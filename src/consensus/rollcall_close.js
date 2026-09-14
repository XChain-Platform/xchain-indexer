/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * ROLLCALL epoch close and the eviction rule (validator liveness eviction).
 *
 * Runs BTC-side, once per block, inside the block transaction, in the anchor
 * reward derive's slot: after processCrossChainCalls, before
 * processCancellations and processCooldownCompletions. That position is not
 * cosmetic. It is a fail-closed cross-chain proof that must finish before the
 * block's hashes are computed, and it must land its synthetic UNSTAKE rows
 * BEFORE the cooldown sweep runs, or an eviction's refund would be invisible to
 * the sweep for a whole block.
 *
 * WHAT THIS DECIDES, and what it refuses to decide. The DOGE side stores raw
 * signed material and judges nobody. Every question about membership, weight,
 * quorum, absence and eviction is answered here, because BTC is the only place
 * the capability predicate and the stake rows live. This file re-verifies every
 * signature against its OWN ledger_hash: a DOGE indexer's opinion is never an
 * input, only its rows are.
 *
 * DEFERRAL IS THE SAFE OUTCOME, NEVER AN EMPTY SET. Every way of not knowing --
 * unconfigured, unreachable, malformed, no cut, unburied cut, stale peer
 * manifest -- throws RollcallProofUnavailableError and the block is retried. The
 * failure this avoids is the one that looks like success: reading "no signatures
 * found" as "the whole federation was absent" and evicting all of it.
 *
 * ROLLCALL v1 (at or above ROLLCALL_GATES_ACTIVATION). The signed canonical
 * commits to sha256(GATES), the publisher's list of consensus gate keys, so this
 * file rebuilds it through rollcall_canonical.buildRollcallCanonical rather than
 * spelling the concatenation inline, and a ROLLED v1 epoch also writes one
 * rollcall_gates row per verified signer. That table is the ONLY BTC-side record
 * of which gates a key's build accepted, and the rules-aware attestation set
 * reads nothing else: ROLLCALL is DOGE-only, so rollcall_signers is empty here.
 *
 ********************************************************************/

const crypto  = require('crypto');
const rca     = require('../rollcall_activation.js');
const swq     = require('../stake_weighted_quorum.js');
const srb     = require('../snapshot_reorg_buffer.js');
// The close's steps live beside it in rollcall_close/: the inputs (responsible set,
// window cut, ledger hash, peer answer), the signer verification, and the absence streak.
const { indexResponsible, readEpochHashes, askSigners } = require('./rollcall_close/epoch_inputs.js');
const { verifySigners, formatDropped } = require('./rollcall_close/signer_verify.js');
const { pinnedSources, measureAbsences } = require('./rollcall_close/absence_streak.js');

const { getLogger } = require('../observability/index.js');
// Deterministic ordering, byte-identical to StateAnchorPublisher.hashOrder in
// xchain-hub: sort by SHA256(key ‖ pubkey) ascending. The hub elects the
// publisher with this function and the BTC close pays the winner with it, so a
// one-sided edit would pay a validator the federation did not elect. Copied
// rather than imported because the hub is not a dependency of the indexer.
function hashOrder(key, pubkeys){
    return (pubkeys || []).map((pk) => {
        let p = String(pk).toLowerCase();
        return { pubkey: p, hash: crypto.createHash('sha256').update(key, 'utf8').update(p, 'utf8').digest('hex') };
    }).sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0)).map((e) => e.pubkey);
}

// The leader election preimage. Shares the anchor rail's ordering function but
// carries its own domain tag, so the two elections are independent.
function electionKey(network, epochHeight){
    return 'XROLLCALL|' + network + '|' + String(epochHeight);
}

/**
 * Close every ROLLCALL epoch whose close block is `blockIndex`.
 *
 * @param {object} indexerDb  db handle, bound to the block transaction
 * @param {object} config     indexer config ({ COIN, NETWORK, STAKING, ... })
 * @param {number} blockIndex the BTC block being processed
 * @param {object} proof      RollcallProofClient (DOGE visibility)
 * @param {object} util       indexer utility (bc* amount math)
 * @returns {Promise<number>} epochs closed at this block (0 or 1)
 * @throws {RollcallProofUnavailableError} when the epoch cannot be decided here
 */
async function closeRollcallEpochs(indexerDb, config, blockIndex, proof, util){

    // The capability predicate and the stake rows live only on BTC.
    if(String(config['COIN']) !== 'BTC') return 0;
    let network = String(config['NETWORK'] || '');

    // rollcallEpochClosingAt carries the activation and epoch-boundary gates, so a
    // block that closes nothing costs one arithmetic call.
    let epochHeight = rca.rollcallEpochClosingAt(blockIndex, network);
    if(epochHeight === null) return 0;

    let closeBlock = parseInt(blockIndex);

    // (1) Responsible set at the BURIED snapshot. buriedSnapshotBlock is what every
    // other capability read uses, so R(E) is resolved at the height the rest of the
    // fleet resolves it at.
    let snapshotBlock = srb.buriedSnapshotBlock(epochHeight, network);
    let responsible   = await indexerDb.getStakeWeightsByCapability('oracle_publish', snapshotBlock);
    let truncated     = !!(responsible && responsible.truncated);

    // A truncated read is not a small set, it is an UNKNOWN set. Rolling on it
    // would pin absences for sources that may simply have been cut off past the
    // query cap. Same fail-closed posture meetsStakeThreshold takes.
    if(truncated || !responsible || responsible.length === 0){
        await indexerDb.insertRollcall(epochHeight, snapshotBlock, closeBlock, 0, null);
        getLogger().info('\t ROLLCALL close : epoch=' + epochHeight + ' UNROLLED (' +
                    (truncated ? 'responsible set truncated' : 'no responsible validators') + ')');
        return 1;
    }

    let { keys, sourceOf, allSources } = indexResponsible(responsible);

    // (2) The window cut basis and this indexer's OWN ledger_hash for the epoch block
    // (epoch_inputs.js). Every signature is verified against that hash, never against
    // the hash the action carried.
    let { maxBlockTime, ledgerHash } = await readEpochHashes(indexerDb, network, epochHeight);

    let leader = hashOrder(electionKey(network, epochHeight), keys)[0] || null;

    // (3) Ask the DOGE peer, bounded by the keys we can name.
    let answer = await askSigners(proof, epochHeight, maxBlockTime, keys, leader);

    // (4) Verify each key's row against the canonical its EPOCH calls for (signer_verify.js).
    let verified = verifySigners(answer, keys, sourceOf, ledgerHash, network, epochHeight);

    // (5) Quorum over the WHOLE federation, not over who answered. An epoch that
    // does not reach it counts for nobody, so a partition or a fee spike can never
    // evict anyone.
    let rolled = swq.meetsStakeThreshold(responsible, verified.presentKeys);

    return recordEpochOutcome(indexerDb, config, util, {
        epochHeight, snapshotBlock, closeBlock, rolled, allSources, leader, answer, verified
    });
}

// Write the closed epoch's outcome: the rollcall row always, and for a ROLLED epoch the
// gate lists, the absences, the leader's reward and the evictions. `c` carries what
// closeRollcallEpochs measured. Returns 1, the one epoch closed.
async function recordEpochOutcome(indexerDb, config, util, c){
    let { epochHeight, closeBlock, leader, answer, verified } = c;
    // Order by UTF-8 bytes, the house comparator, not a bare .sort(): this sequence pins
    // responsible_set_json, the absence row order and the eviction order, so it is consensus.
    let sortedSources = Array.from(c.allSources).sort(
        (a, b) => Buffer.compare(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8')));
    await indexerDb.insertRollcall(epochHeight, c.snapshotBlock, closeBlock, c.rolled ? 1 : 0,
                                  c.rolled ? sortedSources : null);

    let droppedNote = formatDropped(verified.dropped, verified.gatesActive);
    if(!c.rolled){
        getLogger().info('\t ROLLCALL close : epoch=' + epochHeight + ' UNROLLED (present ' +
                    verified.presentSources.size + '/' + c.allSources.size + ' sources, below threshold)' + droppedNote);
        return 1;
    }

    // (6) The gate lists of a ROLLED v1 epoch, one row per verified signer. Only a
    // rolled epoch writes here: an unrolled epoch decided nothing about membership,
    // and recording its lists would let a partition's partial answer become the
    // set the attestation filter reads. Same block transaction as every other close
    // write, so a deferred or reorged block leaves no half-written epoch behind.
    if(verified.gatesActive && verified.gatesRows.length > 0)
        await indexerDb.insertRollcallGates(epochHeight, closeBlock, verified.gatesRows);

    // (7) and (8): the absences and each one's K-streak (absence_streak.js), which also
    // writes the absence rows.
    let { absentSources, evictedSources } =
        await measureAbsences(indexerDb, epochHeight, closeBlock, sortedSources, verified.presentSources);

    // (9) The publish reward, to the ELECTED leader only. Never to whoever
    // published first: that would be a fee-bidding race no hub can bump.
    if(leader && answer.publishers && answer.publishers[leader]){
        let ok = await indexerDb.createValidatorReward(
            leader, epochHeight, 'rollcall_publish', rca.ROLLCALL_REWARD_AMOUNT,
            epochHeight, true, closeBlock, 0);
        // The leader is a member of R(E) by construction, so the active-stake
        // precondition holds. Assert it rather than tolerating the silent false,
        // which would drop the reward on some nodes and not others.
        if(ok === false)
            throw new Error('ROLLCALL close: reward write refused for elected leader ' + leader +
                            ' at epoch ' + epochHeight + ' (active-stake precondition failed)');
    }

    // (10) Eviction. Exactly what an UNSTAKE from that source would do, minus the actor.
    for(let source of evictedSources)
        await evictSource(indexerDb, config, util, source, closeBlock);

    getLogger().info('\t ROLLCALL close : epoch=' + epochHeight + ' ROLLED (present ' +
                verified.presentSources.size + '/' + c.allSources.size + ' sources, ' +
                absentSources.length + ' absent, ' + evictedSources.length + ' evicted)' +
                (leader ? ' leader=' + leader.substring(0, 16) + '...' : '') + droppedNote);
    return 1;
}

// Remove one source from the capability set by minting the UNSTAKE it never sent.
// Everything downstream is untouched code: the cooldown sweep, the credit and
// escrow release, the maturity reversal on reorg, state_hash coverage and
// xchain-sync replication all already handle `unstakes` rows.
async function evictSource(indexerDb, config, util, source, closeBlock){
    let staking         = config['STAKING'];
    let cooldownBlocks  = (staking && staking['COOLDOWN_BLOCKS'])         ? staking['COOLDOWN_BLOCKS']         : 1000;
    let activationDelay = (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : config['ACTIVATION_DELAY_BLOCKS'];

    // includePending: an eviction is a removal, not an amount, so it sweeps the
    // pending-activation rows UNSTAKE deliberately leaves alone. Otherwise a
    // 1-XCHAIN top-up landed just before the epoch walks the source back in.
    let rows = await indexerDb.getSweepableStakeBySource(source, closeBlock, true);

    // Zero rows means a real UNSTAKE already landed this block: the eviction is a
    // no-op rather than a second sweep that would double-credit at cooldown end.
    if(!rows || rows.length === 0) return 0;

    for(let r of rows){
        let amount = util.bcformat(String(r.amount), 8);
        if(!util.bcgt(amount, '0')) continue;

        // force=true allocates a distinct action_index per (source, key): there is no
        // natural transaction to key on. FORMAT 3 is the eviction marker, the same
        // mechanism the cooldown completion uses at FORMAT 2.
        let actionIndex = await indexerDb.createActionIndex(
            { ACTION: 'UNSTAKE', BLOCK_INDEX: closeBlock, FORMAT: 3 }, true);

        await indexerDb.createUnstake({
            ACTION_INDEX:       actionIndex,
            SOURCE:             source,
            SIGNING_PUBKEY:     r.signing_pubkey,
            AMOUNT:             amount,
            COOLDOWN_END_BLOCK: closeBlock + cooldownBlocks,
            STATUS:             'valid',
            BLOCK_INDEX:        closeBlock
        });

        // Source-scoped, so a key shared with another source does not take that
        // source's stake down with it.
        await indexerDb.setStakeDeactivationBySourceAndPubkey(
            source, r.signing_pubkey, closeBlock + activationDelay, closeBlock, true);
    }

    // Every delegation of the source, or the DELEGATE branch of the capability
    // predicate would keep it in the set after its own stake rows are stamped.
    await indexerDb.setAllDelegationDeactivationsBySource(source, closeBlock + activationDelay);

    return rows.length;
}

module.exports = { closeRollcallEpochs, evictSource, hashOrder, electionKey, pinnedSources };
