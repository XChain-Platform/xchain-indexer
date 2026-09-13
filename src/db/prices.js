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
 * XChain Indexer - Database mixin: prices
 * 
 * The queries over the prices table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
const snapshotAgeCausality = require('../oracle_snapshot_age_causality_activation');
const staleRoundVisibility = require('../oracle_stale_round_visibility_activation');
const preloadCausality = require('../oracle_preload_causality_activation');
const batchLandedFee = require('../price_fee_batch_landed_activation');
// Per-block cap on the ATTEST deadline-expiry sweep. Vendored
// byte-identical from xchain-documentation/protocol/constants.js, same convention
// as the XCALL_MAX_CALLS_PER_BLOCK sibling it mirrors.
const { ATTEST_MAX_EXPIRIES_PER_BLOCK,
        CROSS_SETTLE_MAX_PER_BLOCK,
        ORACLE_VM_ROUND_WINDOW,
        ORACLE_VM_MAX_ROWS } = require('../protocol/constants.js');

module.exports = {

    // Create/Update record in `prices` table (PRICE action log)
    // Stores the raw on-chain PRICE action data; the hub aggregates these into price_snapshots/oracle_prices
    async createPrice(data){
        data                = this.normalizeDataValues(data);
        let status_id       = await this.createStatus(data['STATUS']);
        let source_id       = await this.getAddressId(data['SOURCE']);
        let action_index    = data['ACTION_INDEX'];
        let version         = data['VERSION'];
        let validation      = data['VALIDATION_STATUS'] || 'pending';
        // v0 fields (round_number holds FIRST_ROUND on a batch row; see prices.sql)
        let round_number    = data['ROUND'] || null;
        let round_timestamp = data['TIMESTAMP'] || null;
        let pair_count      = data['PAIR_COUNT'] || null;
        let pairs_json      = data['PAIRS_JSON'] || null;
        let sig_count       = data['SIG_COUNT'] || null;
        let sigs_json       = data['SIGS_JSON'] || null;
        // v2 fields (BATCH window; NULL on a v0/v1 row)
        let batch_first_round = data['BATCH_FIRST_ROUND'] || null;
        let batch_last_round  = data['BATCH_LAST_ROUND'] || null;
        let round_count       = data['ROUND_COUNT'] || null;
        let rounds_json       = data['ROUNDS_JSON'] || null;
        // v1 fields
        let coin_id         = (data['V1_COIN'])  ? await this.createCoin(data['V1_COIN'])     : null;
        let tick_id         = (data['V1_TICK'])  ? await this.createTicker(data['V1_TICK'])   : null;
        let fiat_id         = (data['V1_FIAT'])  ? await this.createFiat(data['V1_FIAT'])     : null;
        let value           = data['V1_VALUE'] || null;
        let fee             = data['V1_FEE']   || null;
        let memo_id         = (data['MEMO'])     ? await this.createMemo(data['MEMO'])         : null;
        // Check if record exists (idempotent for retries)
        let query   = "SELECT action_index FROM prices WHERE action_index=? LIMIT 1";
        let args    = [action_index];
        let exists  = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE prices SET
                        version=?, source_id=?, round_number=?, round_timestamp=?,
                        pair_count=?, pairs_json=?, sig_count=?, sigs_json=?,
                        batch_first_round=?, batch_last_round=?, round_count=?, rounds_json=?,
                        coin_id=?, tick_id=?, fiat_id=?, value=?, fee=?, memo_id=?,
                        validation_status=?, status_id=?
                    WHERE action_index=?`;
            args = [version, source_id, round_number, round_timestamp,
                    pair_count, pairs_json, sig_count, sigs_json,
                    batch_first_round, batch_last_round, round_count, rounds_json,
                    coin_id, tick_id, fiat_id, value, fee, memo_id,
                    validation, status_id, action_index];
        } else {
            query = `INSERT INTO prices
                        (version, source_id, round_number, round_timestamp,
                         pair_count, pairs_json, sig_count, sigs_json,
                         batch_first_round, batch_last_round, round_count, rounds_json,
                         coin_id, tick_id, fiat_id, value, fee, memo_id,
                         validation_status, status_id, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [version, source_id, round_number, round_timestamp,
                    pair_count, pairs_json, sig_count, sigs_json,
                    batch_first_round, batch_last_round, round_count, rounds_json,
                    coin_id, tick_id, fiat_id, value, fee, memo_id,
                    validation, status_id, action_index];
        }
        await this.doQuery(query, args);
    },

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
        this._assertPriceBarrierNotSkipped('getOracleDataForVM');
        let self = this;
        let refTime = parseInt(blockTime);
        let maxAge  = parseInt(maxAgeSeconds);

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
            blockIndex, this.config['NETWORK'], this.config['COIN']) && Number.isFinite(refTime);
        // Empty below the height, so every query string and argument list stays
        // byte-identical to the pre-gate one and historical replay is unchanged.
        let timeBound = timeCausal ? ' AND block_timestamp <= ?' : '';

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
            blockIndex, this.config['NETWORK'], this.config['COIN']);
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
        let ageRows = await this.doQueryStrict(ageQuery, ageArgs.length > 0 ? ageArgs : undefined);
        let latestBlock = (ageRows.length > 0 && ageRows[0].latest_block !== null) ? ageRows[0].latest_block : 0;
        let snapshotAge = (blockIndex && latestBlock > 0) ? Math.max(0, blockIndex - latestBlock) : Number.MAX_SAFE_INTEGER;

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
        // boundary, so we PRE-LOAD here and let xchain-vm/src/readonly-accessors.js
        // rebuild the synchronous getPrice/getPriceAtRound/getSnapshotAge accessors
        // inside the worker. (These were previously async DB closures - incompatible
        // with the VM's synchronous applySync bridge, so oracle reads silently
        // resolved a Promise. This conversion also fixes that latent bug.)
        // blockCap is defined once above (shared with the snapshot-age query).

        // getPrice(): latest finalized price per coin_pair at/<= block, one row
        // per pair (GROUP BY guarantees correctness), staleness-applied.
        let prices = {};
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
        let latestRows = await this.doQueryStrict(latestQuery, timeCausal ? [blockCap, refTime] : [blockCap]);
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
            blockIndex, this.config['NETWORK'], this.config['COIN']);
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
        let rounds = {};

        // Step one: which rounds does the window cover? DISTINCT rounds, newest
        // first, so the answer does not move when a pair is added or a pair misses a
        // round. Fewer rounds than the window means nothing was evicted at all, and
        // the floor stays 0: on a young chain (regtest, a fresh testnet) every round
        // that ever existed is loaded, and a floor above 0 there would report rounds
        // as "hidden" that simply never happened.
        let windowRows = await this.doQueryStrict(
            `SELECT DISTINCT round_number
             FROM price_snapshots
             WHERE status = 'finalized' AND price IS NOT NULL AND reference_block <= ?${timeBound}
             ORDER BY round_number DESC
             LIMIT ${ORACLE_VM_ROUND_WINDOW}`, timeCausal ? [blockCap, refTime] : [blockCap]);
        let roundFloor = (windowRows.length >= ORACLE_VM_ROUND_WINDOW)
            ? Number(windowRows[windowRows.length - 1].round_number)
            : 0;

        // Step two: every row at or above the floor, under a hard payload ceiling.
        let roundQuery = `SELECT coin_pair, price, round_number, block_timestamp
                          FROM price_snapshots
                          WHERE status = 'finalized' AND price IS NOT NULL AND reference_block <= ?${timeBound}
                            AND round_number >= ?
                          ORDER BY round_number DESC
                          LIMIT ${ORACLE_VM_MAX_ROWS}`;
        let roundRows = await this.doQueryStrict(roundQuery,
            timeCausal ? [blockCap, refTime, roundFloor] : [blockCap, roundFloor]);

        // The ceiling truncates newest-first, so the OLDEST loaded round is the one
        // that may be missing pairs. Claiming it is covered would hand a contract the
        // exact ambiguity this floor exists to remove, for the one round where a
        // wrong answer is most likely, so the guarantee starts one round above it.
        if(roundRows.length >= ORACLE_VM_MAX_ROWS){
            let oldestLoaded = Number(roundRows[roundRows.length - 1].round_number);
            roundFloor = oldestLoaded + 1;
            console.error('[oracle snapshot] round set hit the ' + ORACLE_VM_MAX_ROWS +
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

        // roundFloor rides along to the VM, where readonly-accessors.js turns a read
        // below it into a distinguishable "outside the loaded window" answer instead
        // of the null that means "this round never existed". 0 means nothing is
        // hidden: the preload holds all the history there is.
        return { snapshotAge, prices, rounds, roundFloor };
    },

    // Get the latest finalized price for a coin pair at or before a given block height
    // blockHeight gates the query so two nodes processing the same block always see the same price
    //
    // opts (optional) enables a staleness guard: { blockTime, maxAgeSeconds }. When both
    // are supplied and maxAgeSeconds > 0, a snapshot whose block_timestamp is older than
    // maxAgeSeconds relative to blockTime is treated as no price (returns null) rather than
    // a silently outdated value. Age is measured as (blockTime − snapshot.block_timestamp),
    // both chain-derived unix seconds, so the check is deterministic across nodes and does
    // not false-trigger during historical backfill.
    //
    // Landed-batch bound (price_fee_batch_landed_activation.js). At/after the height
    // the selection additionally requires the round's batch to have LANDED on chain at
    // or before this block's time, so a hub-connected node (whose mirror holds a round
    // a whole batch window before the batch carrying it is mined) and a chain-only node
    // (which cannot hold that round at all until the batch lands) price the same action
    // against the same round. Unarmed everywhere today, so the query below is
    // byte-identical to the pre-gate one on every network.
    async getLatestPrice(coinPair, blockHeight, opts){
        this._assertPriceBarrierNotSkipped('getLatestPrice');
        // The bound's own axis is the landing block's clock, so it needs a chain-derived
        // block time. Armed with no such time available the read FAILS CLOSED (no price)
        // rather than answering from the unbounded selection, which is the fork this gate
        // closes; every consensus caller passes opts.blockTime.
        let landedActive = batchLandedFee.isPriceFeeBatchLandedActive(
            blockHeight, this.config['NETWORK'], this.config['COIN']);
        let landedTime   = opts ? Number(opts.blockTime) : NaN;
        if(landedActive && !Number.isFinite(landedTime)){
            if(!this._batchLandedNoTimeWarned){
                this._batchLandedNoTimeWarned = true;
                console.warn('WARNING: getLatestPrice: the landed-batch fee bound is armed but this call ' +
                    'supplied no chain-derived block time (opts.blockTime); refusing to price ' +
                    coinPair + ' from the unbounded selection.');
            }
            return null;
        }
        // Empty below the height, so every query string and argument list stays
        // byte-identical to the pre-gate one and historical replay is unchanged. The
        // clause goes LAST in each WHERE so its argument appends last.
        let landedBound = landedActive ? ' AND batch_block_time > 0 AND batch_block_time <= ?' : '';
        let query, args;
        if(opts && opts.selectByTime && Number.isFinite(Number(opts.blockTime))){
            // H-3 (NATIVE_FEE_PRICE_TIME_GATE): on non-reference chains the
            // reference_block gate below is vacuous (LTC/DOGE heights sit far
            // above any BTC anchor), so selection must pin on the round's own
            // consensus timestamp vs this block's time - the same two
            // quantities the staleness guard compares. Deterministic across
            // nodes (given the time-keyed price barrier) and on replay
            // (historical block times exclude rounds finalized later).
            query = `SELECT price, round_number, block_timestamp
                     FROM price_snapshots
                     WHERE coin_pair = ? AND status = 'finalized' AND price IS NOT NULL
                       AND block_timestamp <= ?${landedBound}
                     ORDER BY round_number DESC LIMIT 1`;
            args = [coinPair, Number(opts.blockTime)];
            if(landedActive) args.push(landedTime);
        } else if(blockHeight !== undefined && blockHeight !== null){
            query = `SELECT price, round_number, block_timestamp
                     FROM price_snapshots
                     WHERE coin_pair = ? AND status = 'finalized' AND price IS NOT NULL
                       AND reference_block <= ?${landedBound}
                     ORDER BY round_number DESC LIMIT 1`;
            args = [coinPair, blockHeight];
            if(landedActive) args.push(landedTime);
        } else {
            query = `SELECT price, round_number, block_timestamp
                     FROM price_snapshots
                     WHERE coin_pair = ? AND status = 'finalized' AND price IS NOT NULL${landedBound}
                     ORDER BY round_number DESC LIMIT 1`;
            args = [coinPair];
            if(landedActive) args.push(landedTime);
        }
        // Strict read (M-17): this is a consensus input. doQuery would swallow a
        // non-transactional query error into [] - indistinguishable from "no
        // price", so one node with a transient hub-DB fault fails the fee closed
        // while healthy peers accept, forking the ledger. Throwing instead lets
        // block processing roll back and retry the block.
        let rows = await this.doQueryStrict(query, args);
        if(rows.length === 0) return null;

        // Staleness guard (opt-in via opts) - see method comment.
        if(opts){
            let refTime = parseInt(opts.blockTime);
            let maxAge  = parseInt(opts.maxAgeSeconds);
            let snapTs  = Number(rows[0].block_timestamp);
            if(maxAge > 0 && Number.isFinite(refTime) && snapTs > 0 && (refTime - snapTs) > maxAge){
                return null;
            }
        }

        return {
            price:       rows[0].price,
            roundNumber: Number(rows[0].round_number),
            timestamp:   Number(rows[0].block_timestamp)
        };
    },

    // Get the latest effective oracle price for a (sourceAddress, coin, tick, fiat) combination
    // gated by blockTime so two nodes processing the same block see the same price.
    // The 24-hour lock window is enforced by `effective_at` - only prices whose effective_at <= blockTime are returned.
    async getOraclePrice(sourceAddress, coin, tick, fiat, blockTime){
        this._assertPriceBarrierNotSkipped('getOraclePrice');
        let query = `SELECT id, source_address, source_chain, coin, tick, fiat, value, fee, memo,
                            block_time, effective_at, action_index
                     FROM oracle_prices
                     WHERE source_address = ? AND coin = ? AND tick = ? AND fiat = ?`;
        let args = [sourceAddress, coin, tick, fiat];
        if(blockTime !== undefined && blockTime !== null){
            query += ' AND effective_at <= ?';
            args.push(blockTime);
        }
        // Tiebreak on action_index (consensus-stable: (source_chain, action_index) is the
        // unique key) not id (local AUTO_INCREMENT, differs per mirror by arrival order),
        // so an effective_at tie resolves to the same row on every node.
        query += ' ORDER BY effective_at DESC, action_index DESC LIMIT 1';
        // Strict read (M-17): the same swallow that forks the VM preload decides
        // whether a Mode B dispenser is valid at all, and on the hub instance an
        // errored read is indistinguishable from "no effective oracle price".
        let rows = await this.doQueryStrict(query, args);
        if(rows.length === 0) return null;
        return {
            sourceAddress: rows[0].source_address,
            sourceChain:   rows[0].source_chain,
            coin:          rows[0].coin,
            tick:          rows[0].tick,
            fiat:          rows[0].fiat,
            value:         rows[0].value,
            fee:           rows[0].fee,
            memo:          rows[0].memo,
            blockTime:     Number(rows[0].block_time),
            effectiveAt:   Number(rows[0].effective_at),
            actionIndex:   Number(rows[0].action_index)
        };
    },

    // Get oracle prices for a (sourceAddress, coin, tick, fiat) within a time range (newest-first)
    // Used by reverseOraclePriceMatch for FIAT dispenser settlement.
    async getOraclePricesInTimeRange(sourceAddress, coin, tick, fiat, startTime, endTime){
        this._assertPriceBarrierNotSkipped('getOraclePricesInTimeRange');
        let query = `SELECT value, block_time, effective_at, action_index
                     FROM oracle_prices
                     WHERE source_address = ? AND coin = ? AND tick = ? AND fiat = ?
                       AND effective_at BETWEEN ? AND ?
                     ORDER BY effective_at DESC, action_index DESC`;
        // Strict read (M-17): FIAT settlement input; an errored read here would look
        // like "no oracle price in the window" and settle the dispense differently
        // on this node alone.
        let rows = await this.doQueryStrict(query, [sourceAddress, coin, tick, fiat, startTime, endTime]);
        return rows.map(row => ({
            price:        row.value,
            blockTime:    Number(row.block_time),
            effectiveAt:  Number(row.effective_at),
            actionIndex:  Number(row.action_index)
        }));
    },

    // Get finalized prices for a coin pair within a time range (newest-first)
    async getPricesInTimeRange(coinPair, startTime, endTime){
        this._assertPriceBarrierNotSkipped('getPricesInTimeRange');
        let query = `SELECT price, round_number, block_timestamp
                     FROM price_snapshots
                     WHERE coin_pair = ? AND status = 'finalized' AND price IS NOT NULL
                       AND block_timestamp BETWEEN ? AND ?
                     ORDER BY block_timestamp DESC, round_number DESC`;
        // Strict read (M-17): the validator price that values the oracle fee and
        // settles a FIAT dispense; [] from a driver error is read as "no validator
        // price" and rejects or re-prices the action on this node only.
        let rows = await this.doQueryStrict(query, [coinPair, startTime, endTime]);
        return rows.map(row => ({
            price:       row.price,
            roundNumber: Number(row.round_number),
            timestamp:   Number(row.block_timestamp)
        }));
    },

    // Valid batch rows overlapping the closed round range the caller asked for. A batch
    // overlaps when it starts at or before the range's end AND ends at or after its start,
    // which is why the two round arguments read in the opposite order to the range itself.
    // round_number carries the batch's FIRST_ROUND on a batch row (prices.sql), so the
    // indexed column drives the scan while batch_first_round stays the authoritative field
    // and is what comes back. The caller pages by advancing first_round past the last batch
    // it received.
    async getPriceBatchesOverlappingRange(validationStatus, lastRound, firstRound, limit){
        let query = 'SELECT action_index, batch_first_round, batch_last_round, round_count ' +
                    'FROM prices ' +
                    'WHERE version = 0 AND validation_status = ? ' +
                    'AND batch_first_round IS NOT NULL AND batch_last_round IS NOT NULL ' +
                    'AND batch_first_round <= ? AND batch_last_round >= ? ' +
                    'ORDER BY batch_first_round ASC, action_index ASC ' +
                    'LIMIT ?';
        return await this.doQuery(query, [validationStatus, lastRound, firstRound, limit]);
    },

};
