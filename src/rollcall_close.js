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
 * ROLLCALL epoch close and the eviction rule (validator liveness eviction, §3.4).
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
 ********************************************************************/

const crypto  = require('crypto');
const ed25519 = require('./ed25519.js');
const eq      = require('./equivocation_header.js');
const rca     = require('./rollcall_activation.js');
const swq     = require('./stake_weighted_quorum.js');
const srb     = require('./snapshot_reorg_buffer.js');
const { RollcallProofUnavailableError } = require('./rollcall_proof_client.js');

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

// Parse a pinned responsible set back into a Set of source addresses. A row whose
// JSON is missing or unparseable yields null, and the caller must then treat that
// epoch as one it cannot judge membership at rather than as an empty set: an
// empty set would silently make every source "not in R" and skip the epoch,
// quietly shortening every streak.
function pinnedSources(row){
    if(!row || row.responsible_set_json === null || row.responsible_set_json === undefined) return null;
    try {
        let parsed = JSON.parse(row.responsible_set_json);
        if(!Array.isArray(parsed)) return null;
        return new Set(parsed.map((s) => String(s)));
    } catch(e){ return null; }
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
        console.log('\t ROLLCALL close : epoch=' + epochHeight + ' UNROLLED (' +
                    (truncated ? 'responsible set truncated' : 'no responsible validators') + ')');
        return 1;
    }

    let keys       = responsible.map((r) => String(r.pubkey).toLowerCase());
    let sourceOf   = new Map();               // effective key -> its source address
    let allSources = new Set();
    for(let r of responsible){
        sourceOf.set(String(r.pubkey).toLowerCase(), String(r.source));
        allSources.add(String(r.source));
    }

    // (2) The window cut basis: the RAW header stamp at E + ACCEPT_WINDOW. Raw,
    // because it must be the same number on every BTC indexer; a derived protocol
    // time is a median over a window and would drift between nodes.
    let windowEnd = rca.rollcallWindowEndHeight(epochHeight, network);
    let windowRow = await indexerDb.getStoredBlockHashes(windowEnd);
    if(!windowRow || windowRow.block_time === null || windowRow.block_time === undefined)
        throw new RollcallProofUnavailableError(
            'window-end block ' + windowEnd + ' has no stored block_time for epoch ' + epochHeight);
    let maxBlockTime = parseInt(windowRow.block_time);

    // This indexer's OWN ledger_hash for the epoch block. Every signature is
    // verified against this, never against the hash the action carried.
    let epochRow = await indexerDb.getStoredBlockHashes(epochHeight);
    if(!epochRow || !epochRow.ledger_hash)
        throw new RollcallProofUnavailableError(
            'epoch block ' + epochHeight + ' has no stored ledger_hash');
    let ledgerHash = String(epochRow.ledger_hash).toLowerCase();

    let leader = hashOrder(electionKey(network, epochHeight), keys)[0] || null;

    // (3) Ask the DOGE peer, bounded by the keys we can name.
    let answer = await proof.fetchSigners({
        epochHeight:  epochHeight,
        maxBlockTime: maxBlockTime,
        pubkeys:      keys,
        publishers:   leader ? [leader] : []
    });
    if(!answer || !answer.decided)
        throw new RollcallProofUnavailableError(
            'epoch ' + epochHeight + ' undecidable: ' + ((answer && answer.reason) || 'no answer'));

    // (4) Verify. A row counts only if it carries THIS indexer's ledger_hash and
    // its signature verifies over the canonical rebuilt here.
    let canonRaw  = eq.buildEquivCanonical(eq.ENGINE_TAGS.ROLLCALL, String(epochHeight), 0,
                                           network + '|' + epochHeight + '|' + ledgerHash);
    let canonical = Buffer.from(canonRaw, 'utf8');

    let presentKeys    = [];
    let presentSources = new Set();
    for(let key of keys){
        let row = answer.signers ? answer.signers[key] : null;
        if(!row || !row.sig) continue;
        // The carried hash must be ours. A signature bound to a different epoch
        // block is a signature about a chain this node is not on.
        if(String(row.ledger_hash).toLowerCase() !== ledgerHash) continue;
        if(!ed25519.verify(canonical, String(row.sig).toLowerCase(), key)) continue;
        presentKeys.push(key);
        presentSources.add(sourceOf.get(key));
    }

    // (5) Quorum over the WHOLE federation, not over who answered. An epoch that
    // does not reach it counts for nobody, so a partition or a fee spike can never
    // evict anyone.
    let rolled = swq.meetsStakeThreshold(responsible, presentKeys);

    // Order by UTF-8 bytes, the house comparator, not a bare .sort(): this sequence pins
    // responsible_set_json, the absence row order and the eviction order, so it is consensus.
    let sortedSources = Array.from(allSources).sort(
        (a, b) => Buffer.compare(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8')));
    await indexerDb.insertRollcall(epochHeight, snapshotBlock, closeBlock, rolled ? 1 : 0,
                                  rolled ? sortedSources : null);

    if(!rolled){
        console.log('\t ROLLCALL close : epoch=' + epochHeight + ' UNROLLED (present ' +
                    presentSources.size + '/' + allSources.size + ' sources, below threshold)');
        return 1;
    }

    // (6) Absences, pinned against the set at S and never re-derived.
    let absentSources = sortedSources.filter((s) => !presentSources.has(s));

    // (7) The K-streak, over the pinned lookback window. The window includes this
    // epoch's own row, which was written above.
    let lookback = await indexerDb.getRolledRollcallEpochs(epochHeight, rca.ROLLCALL_STREAK_LOOKBACK);
    let evictedSources = [];
    let absenceRows    = [];

    for(let source of absentSources){
        let priorAbsences = new Set(
            await indexerDb.getRollcallAbsenceEpochsForSource(source, lookback.map((r) => parseInt(r.epoch_height))));

        let streak = 0;
        for(let row of lookback){                       // newest first
            let eh = parseInt(row.epoch_height);

            // This epoch: absence is what we just measured, membership is given.
            if(eh === epochHeight){ streak++; if(streak >= rca.ROLLCALL_EVICT_MISSES) break; continue; }

            // Epochs the source was not responsible for are SKIPPED: not counted and
            // not streak-ending. That is what stops a source resetting its streak by
            // dipping under the capability floor for one epoch with a partial UNSTAKE.
            // An unreadable pin is treated as "cannot judge membership", which ends
            // the walk rather than silently skipping and over-counting the streak.
            let pinned = pinnedSources(row);
            if(pinned === null) break;
            if(!pinned.has(source)) continue;

            if(!priorAbsences.has(eh)) break;           // present: the streak ends
            streak++;
            if(streak >= rca.ROLLCALL_EVICT_MISSES) break;
        }

        let evicted = (streak >= rca.ROLLCALL_EVICT_MISSES);
        if(evicted) evictedSources.push(source);
        absenceRows.push({ epoch_height: epochHeight, source: source, close_block: closeBlock, evicted: evicted });
    }

    if(absenceRows.length > 0)
        await indexerDb.insertRollcallAbsences(absenceRows);

    // (8) The publish reward, to the ELECTED leader only. Never to whoever
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

    // (9) Eviction. Exactly what an UNSTAKE from that source would do, minus the actor.
    for(let source of evictedSources)
        await evictSource(indexerDb, config, util, source, closeBlock);

    console.log('\t ROLLCALL close : epoch=' + epochHeight + ' ROLLED (present ' +
                presentSources.size + '/' + allSources.size + ' sources, ' +
                absentSources.length + ' absent, ' + evictedSources.length + ' evicted)' +
                (leader ? ' leader=' + leader.substring(0, 16) + '...' : ''));
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
