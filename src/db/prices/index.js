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
 * db/index.js, so call sites stay this.db.<method>(). The PRICE action log (the `prices`
 * table writer and its batch-window read) and the VM oracle snapshot live in parts under
 * prices/, and this file is the entry that merges them into the one method set it exports.
 *
 ********************************************************************/

const path    = require('path');
const priceLog = require('./price_log.js');
const oracleVmSnapshot = require('./oracle_vm_snapshot.js');
const gateRegistry = require('../../consensus/gate_registry');
const { getLogger } = require('../../observability/index.js');
// Per-block cap on the ATTEST deadline-expiry sweep. Vendored
// byte-identical from xchain-documentation/protocol/constants.js, same convention
// as the XCALL_MAX_CALLS_PER_BLOCK sibling it mirrors.
const { ATTEST_MAX_EXPIRIES_PER_BLOCK,
        CROSS_SETTLE_MAX_PER_BLOCK,
        ORACLE_VM_ROUND_WINDOW,
        ORACLE_VM_MAX_ROWS } = require('../../protocol/constants.js');

// getLatestPrice's selection: the query and its arguments for the one branch the call
// takes, with the landed-batch clause (empty when unarmed) and its argument appended last.
function selectLatestPriceQuery(coinPair, blockHeight, opts, landedBound, landedActive, landedTime){
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
    return { query, args };
}

module.exports = Object.assign({

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
    // Landed-batch bound (the price_fee_batch_landed_activation row in src/protocol_changes/). At/after the height
    // the selection additionally requires the round's batch to have LANDED on chain at
    // or before this block's time, so a hub-connected node (whose mirror holds a round
    // a whole batch window before the batch carrying it is mined) and a chain-only node
    // (which cannot hold that round at all until the batch lands) price the same action
    // against the same round. Unarmed everywhere today, so the query below is
    // byte-identical to the pre-gate one on every network.
    async getLatestPrice(coinPair, blockHeight, opts){
        this.assertPriceBarrierNotSkipped('getLatestPrice');
        // The bound's own axis is the landing block's clock, so it needs a chain-derived
        // block time. Armed with no such time available the read FAILS CLOSED (no price)
        // rather than answering from the unbounded selection, which is the fork this gate
        // closes; every consensus caller passes opts.blockTime.
        let landedActive = gateRegistry.activeAt('price_fee_batch_landed_activation.PRICE_FEE_BATCH_LANDED_ACTIVATION',
            this.config['NETWORK'], this.config['COIN'], blockHeight, null);
        let landedTime   = opts ? Number(opts.blockTime) : NaN;
        if(landedActive && !Number.isFinite(landedTime)){
            if(!this._batchLandedNoTimeWarned){
                this._batchLandedNoTimeWarned = true;
                getLogger().warn('WARNING: getLatestPrice: the landed-batch fee bound is armed but this call ' +
                    'supplied no chain-derived block time (opts.blockTime); refusing to price ' +
                    coinPair + ' from the unbounded selection.');
            }
            return null;
        }
        // Empty below the height, so every query string and argument list stays
        // byte-identical to the pre-gate one and historical replay is unchanged. The
        // clause goes LAST in each WHERE so its argument appends last.
        let landedBound = landedActive ? ' AND batch_block_time > 0 AND batch_block_time <= ?' : '';
        let { query, args } = selectLatestPriceQuery(coinPair, blockHeight, opts, landedBound, landedActive, landedTime);
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
        this.assertPriceBarrierNotSkipped('getOraclePrice');
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
        this.assertPriceBarrierNotSkipped('getOraclePricesInTimeRange');
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
        this.assertPriceBarrierNotSkipped('getPricesInTimeRange');
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

}, priceLog, oracleVmSnapshot);
