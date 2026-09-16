/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 * XChain Indexer - ATTEST handler part
 *
 * Absorbing a completed response batch: the coverage check, the batch quorum and the hub push.
 *
 * Installed onto Attest.prototype by actions/attest/index.js, so call sites stay
 * this.<method>().
 *
 ********************************************************************/

'use strict';

const ed25519 = require('../../consensus/ed25519.js');
const swq     = require('../../consensus/stake_weighted_quorum.js');
// The v5/v6 wire: layout, chunking, caps and reassembly. Pure, and byte-twinned
// into xchain-hub so the publisher that BUILDS a batch and this parser cannot
// disagree about its bytes.
const abw     = require('./attest_batch_wire.js');
const { getLogger } = require('../../observability/index.js');
const { ATTEST_BATCH_COMPLETION_STAMP } = require('./constants.js');

module.exports = {
    // Absorb the batch on the continuation that completes its coverage, or do nothing when
    // slots are still missing.
    //
    // The landing chunk is joined to the stored set in memory rather than re-read: it was
    // written a statement ago, and the two sets are the same one. Coverage is decided by the
    // INDEX SET, never by a count, so a stray out-of-range row can neither pad an incomplete
    // set nor let a complete one absorb twice.
    //
    // A failure here is the BATCH's, so it lands on the head, exactly as the ANCHOR archive
    // stamps its own head (actions/anchor/index.js). This chunk's bytes were well formed and its
    // row stays valid, which is what keeps one bad batch from re-judging an honest wire.
    //
    // The push carries the HEAD's action index and THIS action's block and time. They are
    // different things: the index NAMES THE BATCH (the hub stamps it onto every carried
    // response as batch_action_index, and that is the link an explorer opens, which must
    // land on the head that declares the window rather than on whichever continuation
    // happened to close it), while the block and time are the completing action's because
    // that is the action whose rollback un-lands the delivery and the stamp any hub keying
    // on time needs.
    async absorbCompletedBatch(headRow, stored, chunk, data){
        let head   = this.headFromRow(headRow);
        let chunks = stored.concat([{
            chunk_index:  chunk.chunkIndex,
            chunk_b64:    chunk.chunkB64,
            action_index: data['ACTION_INDEX']
        }]);
        if(abw.attestChunkCoverage(chunks, head.totalChunks) === null) return;

        let assembled = abw.reassembleAttestBatch(head, chunks);
        let failure   = assembled.ok ? null : assembled.status;
        let batch     = assembled.ok ? assembled.batch : null;
        if(batch){
            let quorum = await this.verifyBatchQuorum(batch);
            if(!quorum.ok) failure = quorum.error;
        }

        if(failure){
            getLogger().warn("\t ATTEST v6 : batch=" + String(head.batchKey).substring(0,16) + '...' +
                         ' : completed and failed, flagging the head : ' + failure);
            // The verdict carries the completion marker so a later reorg of THIS chunk can
            // tell an after-the-fact stamp from a head that was terminal when it was written,
            // and restore only the former (ATTEST_BATCH_COMPLETION_STAMP; rollback.js).
            await this.indexerDb.setAttestBatchStatus(Number(headRow.action_index),
                                                      failure + ATTEST_BATCH_COMPLETION_STAMP);
            return;
        }

        // Same durable transactional outbox the single-chunk head uses, for the same
        // reason: this push is the chain-only rebuild road, not an optimisation.
        if(this.hubClient && this.hubClient.enabled){
            let pushGeneration = await this.indexerDb.getPushGeneration(data['COIN']);
            let payload = this.buildBatchHubPush(batch, data, pushGeneration, Number(headRow.action_index));
            // The QUEUE ROW is keyed on THIS action, never on the head the payload names.
            // pending_hub_pushes.action_index is the reorg purge key (rollback deletes every
            // row at or above the orphaned range) and the action that lands this delivery is
            // the completing continuation. Keyed at the head instead, a rollback of the very
            // chunk that completed the batch leaves the queued delivery alive, and attest_batch
            // is an uncapped durable push type, so it would retry until the hub published a
            // completion for chunks no longer on chain. Every other wire of the batch landed at
            // or below this action, so keying here purges on a rollback of any of them too.
            let pushId  = await this.indexerDb.enqueueHubPushTx('attest_batch', payload, Number(data['ACTION_INDEX']));
            this.indexerDb.stageHubPush({ id: pushId, pushType: 'attest_batch', payload });
        }
    },

    // The hub push payload for a valid batch. The KEY NAMES ARE THE INTERFACE and the
    // transport validates none of them: the hub's `pushattestbatch` handler destructures
    // exactly these, so a typo fails silently at runtime (an undefined field, a refused
    // batch) rather than loudly at build time. A test pins this key set.
    //
    // `rows` and `sigs` are the reassembled body verbatim, so the hub re-verifies the same
    // bytes this node verified rather than a re-serialization of them. `block_time` rides
    // along for the same reason the PRICE batch carries it: batching widens the hub/chain
    // skew, and a hub keying anything on time needs the LANDING action's own stamp.
    //
    // `action_index` is the batch HEAD's, which is why it is a parameter rather than read
    // off `data`: on a multi-chunk batch the landing action is the completing continuation,
    // and naming that one would point every carried response's batch link at a chunk.
    //
    // @param {Object} batch the reassembled batch body
    // @param {Object} data the landing v5/v6 action
    // @param {number} pushGeneration the source-chain reorg fence
    // @param {number} headActionIndex the batch head's action index
    // @returns {Object} the pushattestbatch payload
    buildBatchHubPush(batch, data, pushGeneration, headActionIndex){
        return {
            source_chain:     data['COIN'],
            network:          batch.network,
            window_start:     batch.window_start,
            window_end:       batch.window_end,
            row_count:        batch.row_count,
            btc_block_height: batch.btc_block_height,
            rows:             batch.rows,
            sigs:             batch.sigs,
            action_index:     headActionIndex,
            block_index:      data['BLOCK_INDEX'],
            block_time:       data['BLOCK_TIME'],
            push_generation:  pushGeneration
        };
    },

    // Verify the batch quorum over the batch canonical, against the `attestation`
    // capability snapshot at the batch's signed BTC anchor.
    //
    // The set, the weights and the count all key on that anchor and never on this action's
    // own height: capability_snapshots.snapshot_block is a BTC height, so a DOGE landing
    // height matches nothing. Off BTC all three reads reach the mirrored snapshot through
    // db.usesCapabilitySnapshot, which is why `attestation` had to join that redirect.
    //
    // Signer-set rule is the PRICE batch's, because both are the same trust decision on
    // the same rail: stake-weighted (source-deduped) at and above STAKE_WEIGHTED_QUORUM,
    // else the legacy PBFT count. A pubkey is marked seen only AFTER its signature
    // verifies, so a garbage signature carrying a qualified validator's pubkey cannot be
    // ordered ahead of the real one to consume its slot. This wire has no pre-flag-day
    // history to preserve, so that rule is unconditional here rather than gated.
    async verifyBatchQuorum(batch){
        let anchor    = Number(batch.btc_block_height);
        let network   = this.config['NETWORK'];
        let canonical = abw.buildAttestBatchCanonical(batch);

        // Same truncation fallback the PRICE batch carries: getValidatorsByCapability caps
        // at VALIDATOR_QUERY_LIMIT and hasCapability does not, so treating a TRUNCATED read
        // as the whole set would silently drop a qualified signer and under-count.
        let capableRows = await this.indexerDb.getValidatorsByCapability('attestation', anchor);
        let capableSet  = (capableRows && capableRows.truncated === true)
                        ? null
                        : new Set((capableRows || []).map(v => String(v.pubkey).toLowerCase()));
        let capabilityCache = new Map();

        let signers = [], seen = new Set();
        for(let s of batch.sigs){
            let pubkey = String(s.pubkey || '').toLowerCase();
            let sig    = String(s.sig || '').toLowerCase();
            if(seen.has(pubkey)) continue;

            let capable;
            if(capableSet){
                capable = capableSet.has(pubkey);
            } else {
                capable = capabilityCache.get(pubkey);
                if(capable === undefined){
                    capable = await this.indexerDb.hasCapability(pubkey, 'attestation', anchor);
                    capabilityCache.set(pubkey, capable);
                }
            }
            if(!capable) continue;
            if(!ed25519.verify(canonical, sig, pubkey)) continue;

            seen.add(pubkey);
            signers.push(pubkey);
        }

        if(swq.isStakeWeightedQuorumActive(anchor, network)){
            let validators = await this.indexerDb.getStakeWeightsByCapability('attestation', anchor);
            if(!swq.meetsStakeThreshold(validators, signers))
                return { ok: false, error: 'invalid: insufficient signer stake' };
        } else {
            let n = await this.indexerDb.getActiveCapabilityCount('attestation', anchor);
            let quorum = (n <= 1) ? 1 : Math.max(2 * Math.floor((n - 1) / 3) + 1, Math.ceil((n + 1) / 2));
            if(signers.length < quorum)
                return { ok: false, error: 'invalid: insufficient PBFT quorum (' + signers.length + '/' + quorum + ')' };
        }
        return { ok: true, signers: signers };
    }
};
