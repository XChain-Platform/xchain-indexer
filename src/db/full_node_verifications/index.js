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
 **********************************************************************
 *
 * XChain Indexer - Database mixin: full_node_verifications
 * 
 * The queries over the full_node_verifications table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');

const { getLogger } = require('../../observability/index.js');
module.exports = {

    // ── Full-node possession proofs (NODEPROOF / verified-validator tier) ──────
    // Record that `pubkeyHex` was verified (by a quorum-signed NODEPROOF verdict)
    // to have answered the possession challenge for `epochHeight`. Resolves the
    // staking source the same way createValidatorReward does. Idempotent on
    // (epoch_height, signing_pubkey) so a replayed/duplicate verdict is a no-op.
    //
    // `setBlock` is the height the SOURCE resolves at and defaults to `blockIndex`
    // (the verdict's own block) so every other caller is byte-unchanged. The
    // NODEPROOF handler passes the height the producing hub locked its claimant
    // universe at, because the two questions have different answers: a node whose
    // stake deactivated between that lock and the verdict was legitimately
    // challenged and quorum-attested, yet resolving its source at the verdict block
    // finds no active stake and silently drops the row. The recorded `block_index`
    // stays the verdict block either way, so the row still says where it landed.
    async createNodeProofVerification(pubkeyHex, challengeId, epochHeight, targetHeight, actionIndex, blockIndex, setBlock){
        let pubkey_id = await this.getPubkeyId(String(pubkeyHex).toLowerCase());
        if(pubkey_id === null){
            getLogger().warn('createNodeProofVerification: unknown pubkey ' + pubkeyHex);
            return false;
        }
        // Source = the staking address active at the set-resolution block, strict
        // active-row resolution matching createValidatorReward + the ANCHOR
        // archive/recovery.
        let sourceBlock = (setBlock === undefined || setBlock === null) ? blockIndex : setBlock;
        let source_id = await this.resolveActiveStakeSourceId(pubkey_id, sourceBlock);
        if(source_id === null || source_id === undefined){
            getLogger().warn('createNodeProofVerification: no active stake or delegation for pubkey ' + pubkeyHex + ' at block ' + sourceBlock);
            return false;
        }
        let query = `INSERT IGNORE INTO full_node_verifications
                        (action_index, challenge_id, epoch_height, target_height, signing_pubkey_id, source_id, passed, block_index)
                     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`;
        await this.doQuery(query, [actionIndex, String(challengeId).toLowerCase(), epochHeight, targetHeight, pubkey_id, source_id, blockIndex]);
        return true;
    },

    // Validators with a `passed` possession-proof inside PROOF_WINDOW_BLOCKS of
    // `blockIndex` - the "verified full node" set (before the live-stake intersect,
    // which callers apply via hasCapability('full_node')). Returns one row per
    // verified pubkey carrying its staking `source` so the equal reward split can
    // dedupe per source (one operator = one full node = one share). Deterministic -
    // depends only on earlier on-chain verdicts.
    async getVerifiedFullNodeSet(blockIndex){
        let window = parseInt((this.config['FULLNODE'] || {})['PROOF_WINDOW_BLOCKS']) || 0;
        let low    = parseInt(blockIndex) - window;
        // Safety cap matching the sibling validator-set RPCs (getActiveValidators,
        // getValidatorsByCapability, etc.) so this path can't return an unbounded
        // set on a large federation. VALIDATOR_QUERY_LIMIT is a frozen consensus
        // constant; raising it requires a coordinated fleet upgrade, not a
        // per-node override.
        let limit = this.config['VALIDATOR_QUERY_LIMIT'];
        let query = `SELECT DISTINCT ip.pubkey AS pubkey, sa.address AS source, fv.source_id AS source_id
                     FROM full_node_verifications fv
                     JOIN index_pubkeys   ip ON ip.id = fv.signing_pubkey_id
                     JOIN index_addresses sa ON sa.id = fv.source_id
                     WHERE fv.passed = 1
                       AND fv.block_index >  ?
                       AND fv.block_index <= ?
                     ORDER BY ip.pubkey ASC, sa.address ASC
                     LIMIT ?`;
        // ORDER BY is required: this set feeds the equal full-node reward split, so a
        // LIMIT without a deterministic order would truncate a different subset on each
        // node (storage/join order differs) and diverge the ledger. Order on
        // consensus-stable columns (pubkey, then source address) - NOT source_id, which
        // is a local AUTO_INCREMENT surrogate that differs per node.
        let rows = await this.doQuery(query, [low, blockIndex, limit]);
        let truncated = rows.length >= limit;
        if(truncated)
            getLogger().warn('getVerifiedFullNodeSet hit the result cap of ' + limit + ' rows at block ' + blockIndex + ' - full-node verifier set may be truncated. Raise the frozen VALIDATOR_QUERY_LIMIT consensus constant (coordinated fleet upgrade) if the federation has grown.');
        let result = rows.map(r => ({
            pubkey:    String(r.pubkey),
            source:    r.source == null ? '' : String(r.source),
            source_id: r.source_id
        }));
        result.truncated = truncated;
        return result;
    },

    // Participation-rate inputs for the full-node REWARD gate (price.js). Earning the
    // full-node tranche is a carrot, not a stick - there is NO slashing; a node that
    // doesn't run a full node simply doesn't pass challenges and doesn't get paid.
    // Over the trailing FULLNODE.REWARD_PASS_WINDOW_BLOCKS ending at `blockIndex` this
    // returns:
    //   - totalEpochs: the number of DISTINCT challenge epochs that produced at least
    //     one PASSING verdict (the denominator - counting only epochs the federation
    //     actually ran, so an outage never penalizes a node), and
    //   - sources: one entry per staking SOURCE that passed in the window, carrying
    //     passed_epochs (DISTINCT epochs that source answered) and the lowercased set of
    //     its passing pubkeys (so price.js can pick a representative round-signer).
    // Deterministic - depends only on earlier on-chain NODEPROOF verdicts; all counts
    // are integers (the gate compares passed*10000 >= bps*total, never floats).
    async getFullNodeParticipation(blockIndex){
        let fn     = this.config['FULLNODE'] || {};
        let window = parseInt(fn['REWARD_PASS_WINDOW_BLOCKS']) || parseInt(fn['PROOF_WINDOW_BLOCKS']) || 0;
        let result = { totalEpochs: 0, sources: [] };
        if(window <= 0) return result;
        let low = parseInt(blockIndex) - window;
        // Denominator - distinct challenge epochs with >=1 passing verdict in the window.
        let totRows = await this.doQuery(
            `SELECT COUNT(DISTINCT epoch_height) AS epochs
               FROM full_node_verifications
              WHERE passed = 1 AND block_index > ? AND block_index <= ?`,
            [low, blockIndex]);
        result.totalEpochs = (totRows.length && totRows[0].epochs != null) ? Number(totRows[0].epochs) : 0;
        if(result.totalEpochs === 0) return result;
        // Numerator rows - (source, epoch, pubkey) for every passing verdict in the
        // window. ORDER BY consensus-stable columns (address, epoch_height, pubkey) -
        // a total order identical fleet-wide, NOT fv.source_id, a local index_addresses
        // AUTO_INCREMENT surrogate that differs per node (the same house rule the sibling
        // getVerifiedFullNodeSet states). The Map/Set aggregation below is order-insensitive
        // today, but a future LIMIT or first-source dust allocation would make this row
        // order consensus-visible, so keep the deterministic total order.
        let rows = await this.doQuery(
            `SELECT fv.source_id AS source_id, sa.address AS source,
                    fv.epoch_height AS epoch_height, ip.pubkey AS pubkey
               FROM full_node_verifications fv
               JOIN index_pubkeys   ip ON ip.id = fv.signing_pubkey_id
               JOIN index_addresses sa ON sa.id = fv.source_id
              WHERE fv.passed = 1 AND fv.block_index > ? AND fv.block_index <= ?
              ORDER BY sa.address, fv.epoch_height, ip.pubkey`,
            [low, blockIndex]);
        let bySource = new Map();
        for(let r of rows){
            let sid   = String(r.source_id);
            let entry = bySource.get(sid);
            if(!entry){
                entry = { source_id: r.source_id, source: r.source == null ? '' : String(r.source),
                          epochs: new Set(), pubkeys: new Set() };
                bySource.set(sid, entry);
            }
            entry.epochs.add(Number(r.epoch_height));
            entry.pubkeys.add(String(r.pubkey).toLowerCase());
        }
        for(let entry of bySource.values())
            result.sources.push({
                source_id:     entry.source_id,
                source:        entry.source,
                passed_epochs: entry.epochs.size,
                pubkeys:       entry.pubkeys
            });
        return result;
    },

};
