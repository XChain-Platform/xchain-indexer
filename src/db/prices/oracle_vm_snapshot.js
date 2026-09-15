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
 * XChain Indexer - Database mixin part: prices (oracle VM snapshot)
 *
 * The serializable oracle preload the VM rebuilds xchain.oracle.* from, read out of the
 * hub-mirrored price_snapshots table. Each of its four reads runs from a module-private
 * helper below, taking the Database instance as `db`; the query text, the argument lists
 * and the order the reads run in are unchanged. A part of the prices mixin:
 * src/db/prices/index.js merges it into the one method set that db/index.js installs onto
 * Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const snapshotAgeCausality = require('../../oracle_snapshot_age_causality_activation');
const staleRoundVisibility = require('../../oracle_stale_round_visibility_activation');
const preloadCausality = require('../../oracle_preload_causality_activation');
const { getLogger } = require('../../observability/index.js');
const { ORACLE_VM_ROUND_WINDOW,
        ORACLE_VM_MAX_ROWS } = require('../../protocol/constants.js');

// The causal window every read in the preload shares: the height cap, this block's
// consensus time, and whether the preload causality bound is armed (with the SQL clause
// it appends, empty when it is not).
function preloadWindow(db, blockIndex, refTime){
    // Cap every snapshot read at the block being processed so a replay never
    // observes a FUTURE snapshot. Defined once here, ahead of the
    // getPrice/getPriceAtRound queries below, so the age query shares the same
    // cap. blockIndex falsy -> 999999999 (no effective cap),
    // matching the sibling queries' idiom.
    let blockCap = blockIndex || 999999999;

    // Preload causality gate (oracle_preload_causality_activation.js). The cap
    // above compares the PROCESSING chain's height against a BTC-anchored
    // reference_block, so on LTC and DOGE it matches every row and admits
    // rounds the hub finalized after this block; which of them a node holds
    // depends on its mirror depth, and the preload is VM-visible, so the
    // contract hash forks. At/after the height each of the four reads below
    // carries an ADDITIONAL `block_timestamp <= ?` bound against this block's
    // consensus time, the axis getLatestPrice's H-3 branch already selects on
    // and the one the fleet-wide waitForPriceSyncTime barrier makes provable
    // off BTC. The bound is added, never swapped, so the admitted row set can
    // only shrink. The reference chain is carved out inside the module: its
    // height cap is exact, and a time bound there would admit rounds anchored
    // after a forward-skewed block. Execution-path gate, indexer-only.
    let timeCausal = preloadCausality.isOraclePreloadCausalityActive(
        blockIndex, db.config['NETWORK'], db.config['COIN']) && Number.isFinite(refTime);
    // Empty below the height, so every query string and argument list stays
    // byte-identical to the pre-gate one and historical replay is unchanged.
    let timeBound = timeCausal ? ' AND block_timestamp <= ?' : '';
    return { blockCap, refTime, timeCausal, timeBound };
}

// Blocks since the latest finalized snapshot, MAX_SAFE_INTEGER when there is none.
async function readSnapshotAge(db, blockIndex, win){
    const { blockCap, refTime, timeCausal, timeBound } = win;
    // Pre-load the latest finalized snapshot age (blocks since last snapshot).
    // Snapshot-age causality gate (oracle_snapshot_age_causality_activation.js):
    // the legacy age query has NO block cap, unlike every sibling below, so a
    // node replaying block N whose DB already holds a future finalized snapshot
    // at N+k reads it and computes snapshotAge 0, while the node that first
    // processed N computed a positive age. getSnapshotAge() is VM-visible, so
    // that divergence forks the contract hash. At/after the activation height
    // the age query is causally capped at blockCap; below it the uncapped legacy
    // query runs so historical blocks replay byte-identically. Execution-path
    // gate (VM read), indexer-only: xchain-sync never re-runs the VM.
    let ageCausal = snapshotAgeCausality.isOracleSnapshotAgeCausalityActive(
        blockIndex, db.config['NETWORK'], db.config['COIN']);
    let ageQuery = "SELECT MAX(reference_block) AS latest_block FROM price_snapshots WHERE status = 'finalized'"
                 + (ageCausal ? " AND reference_block <= ?" : "")
                 + timeBound;
    // Both gates stack: the height cap stays on where it is armed and the time
    // bound layers over it. No args at all when neither is on, which is the
    // pre-gate call.
    let ageArgs = [];
    if(ageCausal)  ageArgs.push(blockCap);
    if(timeCausal) ageArgs.push(refTime);
    // Strict reads throughout this preload (M-17, same rationale as getLatestPrice):
    // the oracle reads run on the hub-DB instance, which never opens a transaction,
    // so doQuery would collapse a driver error into [] - indistinguishable from
    // "the oracle has no rows". That empty result becomes an absent price map and a
    // MAX_SAFE_INTEGER snapshotAge which the VM hashes into block state, so one
    // node's transient DB fault forks it from the fleet. Throwing lets block
    // processing roll back and retry the block instead.
    let ageRows = await db.doQueryStrict(ageQuery, ageArgs.length > 0 ? ageArgs : undefined);
    let latestBlock = (ageRows.length > 0 && ageRows[0].latest_block !== null) ? ageRows[0].latest_block : 0;
    return (blockIndex && latestBlock > 0) ? Math.max(0, blockIndex - latestBlock) : Number.MAX_SAFE_INTEGER;
}

// The `prices` map behind getPrice(), keyed by coin pair.
async function loadLatestPrices(db, blockIndex, win, isStale){
    const { blockCap, refTime, timeCausal, timeBound } = win;
    // getPrice(): latest finalized price per coin_pair at/<= block, one row
    // per pair (GROUP BY guarantees correctness), staleness-applied.
    let prices = {};
    // Continuation lines keep the method-body indentation they were written at, so the
    // query string the driver receives is byte-identical to the one before the move.
    let latestQuery = `SELECT t.coin_pair AS coin_pair, t.price AS price,
                                  t.round_number AS round_number, t.block_timestamp AS block_timestamp
                           FROM price_snapshots t
                           INNER JOIN (
                               SELECT coin_pair, MAX(round_number) AS mr
                               FROM price_snapshots
                               WHERE status = 'finalized' AND price IS NOT NULL AND reference_block <= ?${timeBound}
                               GROUP BY coin_pair
                           ) m ON t.coin_pair = m.coin_pair AND t.round_number = m.mr
                           WHERE t.status = 'finalized' AND t.price IS NOT NULL`;
    // The bound belongs in the subquery that picks the round: the outer join
    // resolves to that same row through the (round_number, coin_pair) unique
    // key, so bounding it twice would filter nothing further.
    let latestRows = await db.doQueryStrict(latestQuery, timeCausal ? [blockCap, refTime] : [blockCap]);
    // Stale-round visibility gate (oracle_stale_round_visibility_activation.js).
    // Below the height a stale tip is dropped from `prices` entirely, so
    // getPrice() returns null while getPriceAtRound() still carries the very
    // same round - the two views disagree about whether the round EXISTS, and
    // a liveness guard that reads getPrice() (the price-bet family's
    // "has the oracle produced a qualifying round yet?") voids a bet that
    // consensus history already decided. At/after the height the row is kept
    // with its PRICE WITHHELD instead: identity and consensus timestamp stay
    // readable, the stale value does not. VM-observable, hence height-gated.
    let staleVisible = staleRoundVisibility.isOracleStaleRoundVisibilityActive(
        blockIndex, db.config['NETWORK'], db.config['COIN']);
    for(let r of latestRows){
        let stale = isStale(Number(r.block_timestamp));
        // Legacy path: stale prices surface as no-price (null); contracts can
        // still read getSnapshotAge() for the staleness signal.
        if(stale && !staleVisible) continue;
        prices[String(r.coin_pair)] = {
            price:       stale ? null : r.price,
            roundNumber: Number(r.round_number),
            timestamp:   Number(r.block_timestamp)
        };
        // Marker only on withheld rows, so a fresh row stays byte-identical
        // to the pre-gate shape across the whole activation boundary.
        if(stale) prices[String(r.coin_pair)].stale = true;
    }
    return prices;
}

// getPriceAtRound(): historical finalized rounds at/<= block. NOTE: this
// now respects block causality (reference_block <= block) - an improvement
// over the old unfiltered query (which was non-functional anyway). Capped
// for safety; a hit is LOGGED, never silently truncated.
//
// Deliberately NOT row-filtered by isStale(). Staleness is measured
// against the block being processed, so it is true of ALL history older
// than maxAge: filtering rows here would empty getPriceAtRound() of
// everything but the last few minutes, break the immutable-history
// contract the accessor exists to provide, move a timestamp-settled bet
// onto a LATER round than consensus history designates, and make every
// round-number bet reclaimable by its loser (that template's void guard
// is "getPriceAtRound(settleRound) === null"). The prices/rounds
// asymmetry is closed on the `prices` side above (stale tips are kept
// with the price withheld) rather than by hiding history here.
// The window is taken in ROUNDS, then the rows of those rounds are loaded.
// The old shape was a flat row cap taken newest-first, which silently made
// the visible history a function of the pair count and, worse, left the
// eviction boundary invisible: a round outside the payload and a round that
// never existed both came back null, and the price-bet family's void guard
// reads exactly that null, so the loser of a settled bet could reclaim their
// stake by waiting for the settle round to scroll out of the preload.
//
// Ungated, on the same measurement Item 1 rests on and with the same expiry
// date: at the time of the change there were zero deployed contracts and zero
// executions on every live network, so getOracleDataForVM had never once run
// against a real contract and no replay observes any of this. Once a contract
// deploys, what this preload contains IS consensus history and any later
// change to the window needs an activation height.
//
// One number, not six: price_snapshots is a single hub-mirrored set and every
// chain path reads the identical rows, so the window applies fleet-wide rather
// than per chain.
//
// readRoundFloor and loadRounds below are that read's two steps.
async function readRoundFloor(db, win){
    const { blockCap, refTime, timeCausal, timeBound } = win;
    // Step one: which rounds does the window cover? DISTINCT rounds, newest
    // first, so the answer does not move when a pair is added or a pair misses a
    // round. Fewer rounds than the window means nothing was evicted at all, and
    // the floor stays 0: on a young chain (regtest, a fresh testnet) every round
    // that ever existed is loaded, and a floor above 0 there would report rounds
    // as "hidden" that simply never happened.
    // Continuation lines at the original method-body indentation: the query bytes are unchanged.
    let windowRows = await db.doQueryStrict(
            `SELECT DISTINCT round_number
             FROM price_snapshots
             WHERE status = 'finalized' AND price IS NOT NULL AND reference_block <= ?${timeBound}
             ORDER BY round_number DESC
             LIMIT ${ORACLE_VM_ROUND_WINDOW}`, timeCausal ? [blockCap, refTime] : [blockCap]);
    return (windowRows.length >= ORACLE_VM_ROUND_WINDOW)
        ? Number(windowRows[windowRows.length - 1].round_number)
        : 0;
}

// The `rounds` map behind getPriceAtRound(), keyed by coin pair then round, with the
// floor the guarantee starts at (raised when the row ceiling bites).
async function loadRounds(db, blockIndex, win, roundFloor){
    const { blockCap, refTime, timeCausal, timeBound } = win;
    let rounds = {};
    // Step two: every row at or above the floor, under a hard payload ceiling.
    // Continuation lines at the original method-body indentation: the query bytes are unchanged.
    let roundQuery = `SELECT coin_pair, price, round_number, block_timestamp
                          FROM price_snapshots
                          WHERE status = 'finalized' AND price IS NOT NULL AND reference_block <= ?${timeBound}
                            AND round_number >= ?
                          ORDER BY round_number DESC
                          LIMIT ${ORACLE_VM_MAX_ROWS}`;
    let roundRows = await db.doQueryStrict(roundQuery,
        timeCausal ? [blockCap, refTime, roundFloor] : [blockCap, roundFloor]);

    // The ceiling truncates newest-first, so the OLDEST loaded round is the one
    // that may be missing pairs. Claiming it is covered would hand a contract the
    // exact ambiguity this floor exists to remove, for the one round where a
    // wrong answer is most likely, so the guarantee starts one round above it.
    if(roundRows.length >= ORACLE_VM_MAX_ROWS){
        let oldestLoaded = Number(roundRows[roundRows.length - 1].round_number);
        roundFloor = oldestLoaded + 1;
        getLogger().error('[oracle snapshot] round set hit the ' + ORACLE_VM_MAX_ROWS +
            ' row ceiling at block ' + blockIndex + ' - the guaranteed window is ' +
            'now rounds >= ' + roundFloor + ', short of the ' + ORACLE_VM_ROUND_WINDOW +
            '-round window (too many coin pairs for the ceiling)');
    }

    for(let r of roundRows){
        let cp = String(r.coin_pair);
        // A partial round above the raised floor is worse than no round: it would
        // answer "never existed" for the pairs the ceiling cut off.
        if(Number(r.round_number) < roundFloor) continue;
        if(!rounds[cp]) rounds[cp] = {};
        rounds[cp][String(r.round_number)] = {
            price:       r.price,
            roundNumber: Number(r.round_number),
            timestamp:   Number(r.block_timestamp)
        };
    }
    return { rounds, roundFloor };
}

module.exports = {

    /*****************************************************************
     * VM Integration - Oracle / Cross-Chain Stubs
     ****************************************************************/

    // Oracle data accessor - reads from price_snapshots table
    // Returns an accessor object that the VM gateway uses for xchain.oracle.*
    //
    // blockTime is the unix-second timestamp of the block being processed; together with
    // maxAgeSeconds it gates getPrice against stale snapshots. Staleness is measured
    // deterministically as (blockTime − snapshot.block_timestamp), both chain-derived
    // unix seconds, so every node replaying the block computes the same result and
    // historical backfill is never falsely flagged stale. maxAgeSeconds <= 0 disables the guard.
    async getOracleDataForVM(blockIndex, blockTime, maxAgeSeconds){
        this.assertPriceBarrierNotSkipped('getOracleDataForVM');
        let self = this;
        let refTime = parseInt(blockTime);
        let maxAge  = parseInt(maxAgeSeconds);
        let win = preloadWindow(this, blockIndex, refTime);
        let snapshotAge = await readSnapshotAge(this, blockIndex, win);

        // True when a snapshot is older than the configured max age relative to the
        // block being processed (stale ⇒ treated as no price). A future-stamped row
        // gives a negative age here and reads as fresh; the preload causality bound
        // closes that by excluding the row, so no clamp belongs in this comparison
        // (one would change the legacy path below the activation height).
        let isStale = (snapshotTimestamp) => {
            if(!(maxAge > 0) || !Number.isFinite(refTime)) return false;
            if(!(snapshotTimestamp > 0)) return false;
            return (refTime - snapshotTimestamp) > maxAge;
        };

        // ── Build a SERIALIZABLE oracle snapshot (plain data) ───────────────
        // The VM runs in a forked worker; read-only data must cross the IPC
        // boundary, so we PRE-LOAD here and let xchain-vm/src/readonly_accessors.js
        // rebuild the synchronous getPrice/getPriceAtRound/getSnapshotAge accessors
        // inside the worker. (These were previously async DB closures - incompatible
        // with the VM's synchronous applySync bridge, so oracle reads silently
        // resolved a Promise. This conversion also fixes that latent bug.)
        // blockCap is defined once above (shared with the snapshot-age query), in
        // preloadWindow.
        let prices = await loadLatestPrices(this, blockIndex, win, isStale);
        let roundFloor = await readRoundFloor(this, win);
        let loaded = await loadRounds(this, blockIndex, win, roundFloor);

        // roundFloor rides along to the VM, where readonly-accessors.js turns a read
        // below it into a distinguishable "outside the loaded window" answer instead
        // of the null that means "this round never existed". 0 means nothing is
        // hidden: the preload holds all the history there is.
        return { snapshotAge, prices, rounds: loaded.rounds, roundFloor: loaded.roundFloor };
    },

};
