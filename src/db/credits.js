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
 * XChain Indexer - Database mixin: credits
 * 
 * The queries over the credits table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
const ledgerPrecision = require('../ledger_amount_precision_activation');
// The bridge reads (getBridgeBalances, getBridgeEscrowProof) are the part of this family
// kept in credits/bridge_reads.js; they are merged into the export below, so db/index.js
// installs one credits mixin and every method keeps its name on Database.prototype.
const bridgeReads = require('./credits/bridge_reads.js');

// The block/action scope getTokenSupply and getHolders put on a ledger read: rows whose
// action landed at or below `block_index`, through the alias the caller joined `actions`
// under, and rows strictly before `action_index`. Either bound is skipped when absent or
// non-numeric. Pushes its bind values onto `args` in the order the SQL names them and
// returns the clause to append to the WHERE.
function ledgerScopeSql(db, actionsAlias, block_index, action_index, args){
    let sql = '';
    // If a block_index was given, only lookup tokens created before or in given block_index
    if(!db.util.isNull(block_index) && db.util.isNumeric(block_index)){
        sql += " AND " + actionsAlias + ".block_index <= ?";
        args.push(parseInt(block_index));
    }
    // If a action_index was given, only lookup tokens created before given action_index
    if(!db.util.isNull(action_index) && db.util.isNumeric(action_index)){
        sql += " AND m.action_index < ?";
        args.push(parseInt(action_index));
    }
    return sql;
}

// Sort holders list from biggest to smallest. Equal balances fall back to a
// lexicographic address tiebreak so the iteration order is deterministic across
// nodes - the GROUP BY queries in getHolders carry no ORDER BY, so equal-balance holders
// would otherwise iterate in engine-arbitrary order, forking the DIVIDEND/AIRDROP/
// CALLBACK credit INSERT sequence (and therefore the ledger hash) across validators.
function sortHoldersDescending(db, holders){
    return Object.fromEntries(Object.entries(holders).sort(([addrA, a], [addrB, b]) => {
        if(db.util.bcgt(b, a)) return  1;
        if(db.util.bclt(b, a)) return -1;
        return addrA < addrB ? -1 : addrA > addrB ? 1 : 0;
    }));
}

module.exports = {

    // Early-decide watermark helpers. See the _pollTallyWatermark comment in the
    // constructor and processVoteFinalizations step 2. The fingerprint is the highest
    // action_index present in each of the poll's three tally-input tables (votes for the poll,
    // delegations for the tick, and the tick's credits/debits ledger). All three are append-only
    // during forward processing, so a strictly-higher MAX means a new input row landed; an
    // unchanged tuple proves no input changed and the tally is byte-identical. action_index (not
    // block_index) is used so the fingerprint moves even for multiple input rows within one block.
    async getPollTallyInputWatermark(pollIndex, tick_id){
        let rows = await this.doQuery(
            `SELECT
                (SELECT COALESCE(MAX(action_index),0) FROM votes WHERE poll_index=?)            AS v,
                (SELECT COALESCE(MAX(action_index),0) FROM vote_delegations WHERE tick_id=?)     AS d,
                (SELECT COALESCE(MAX(action_index),0) FROM (
                    SELECT action_index FROM credits WHERE tick_id=?
                    UNION ALL
                    SELECT action_index FROM debits  WHERE tick_id=?
                 ) led)                                                                          AS l`,
            [pollIndex, tick_id, tick_id, tick_id]);
        let r = (rows && rows[0]) ? rows[0] : {};
        return String(r.v || 0) + ':' + String(r.d || 0) + ':' + String(r.l || 0);
    },

    // Get token supply from credits/debits table (credits - debits + escrows = supply)
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    //
    // Scope by the ACTION's own block_index (a.block_index), NOT by joining transactions
    // on tx_index. Protocol-generated / synthetic actions (ORDER_MATCH, *_EXPIRE, VOTE v2,
    // the UNSTAKE v2 cooldown completion, etc.) carry tx_index = NULL with no transactions
    // row, so the old `INNER JOIN transactions` silently dropped their ledger effects from
    // this supply sum. That stayed invisible only while every synthetic effect was net-zero
    // on supply (matched credit+debit / escrow release); the UNSTAKE v2 completion is the
    // first synthetic NET-MINT credit, so it exposed the gap as a balances>ledger SanityError.
    // Mirrors the identical fix in getBlockHashes. actions.block_index is set for every row.
    //
    // Each component is summed EXACTLY (18 dp) and the combination is rounded
    // ONCE at the tick's own scale. Rounding each component first
    // and then combining is not the same number: round(C) - round(D) + round(E)
    // can differ from round(C - D + E) by a whole unit when the ledger carries
    // amounts finer than the tick (fees at 8 dp against a 0-decimal gas tick),
    // and the balances-side projection in sanityCheck rounds only once, so a
    // per-component rounding here forks the two sides into a SanityError.
    // On rows written before the exact-ledger flag-day every amount is already
    // an exact multiple of 10^-decimals, so this is value-identical to the old
    // per-row SUM(CAST(m.amount AS DECIMAL(60,decimals))).
    async getTokenSupply(tick, block_index, action_index){
        let credits = 0;
        let debits  = 0;
        let escrows = 0;
        let supply  = 0;
        let sql     = '',
            query   = '',
            args    = [],
            results = null,
            tick_id = await this.createTicker(tick);
        // Get info on decimal precision
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        // Add tick_id to SQL query arguments
        args.push(tick_id);
        // Scoped through the actions join aliased `a` (the header says why not transactions).
        sql = ledgerScopeSql(this, 'a', block_index, action_index, args);
        let sumExpr = ledgerPrecision.exactSumSql('m.amount');
        // Get Credits
        query = `SELECT
                    ` + sumExpr + ` as credits
                FROM
                    credits m
                    INNER JOIN actions a ON (a.action_index=m.action_index)
                WHERE
                    m.tick_id=?` + sql;
        results = await this.doQuery(query, args);
        if(results.length > 0 && !this.util.isNull(results[0].credits))
            credits = results[0].credits;
        // Get Debits
        query = `SELECT
                    ` + sumExpr + ` as debits
                FROM
                    debits m
                    INNER JOIN actions a ON (a.action_index=m.action_index)
                WHERE
                    m.tick_id=?` + sql;
        results = await this.doQuery(query, args);
        if(results.length > 0 && !this.util.isNull(results[0].debits))
            debits = results[0].debits;
        // Get Escrows
        query = `SELECT
                    ` + sumExpr + ` as escrows
                FROM
                    escrows m
                    INNER JOIN actions a ON (a.action_index=m.action_index)
                WHERE
                    m.tick_id=?` + sql;
        results = await this.doQuery(query, args);
        if(results.length > 0 && !this.util.isNull(results[0].escrows))
            escrows = results[0].escrows;
        // Determine total supply ((credits - debits) + escrows), rounded once.
        let exact = ledgerPrecision.LEDGER_AMOUNT_PRECISION;
        supply = this.util.bcadd(this.util.bcsub(credits, debits, exact), escrows, decimals);
        return supply;
    },

    // Handle getting a list of TICK holders and amounts
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    // TODO: Add support for 'escrowed' tokens (dispensers, orders, bets)
    // TODO(j-dog): Can optimize this function to allow getting list of holders from balances table instead of credits/debits
    // Per-holder credits and debits are summed EXACTLY (18 dp) and netted at
    // that scale, matching getAddressBalances / getNetBalance. The
    // former per-row cast to the tick's scale made sum-of-rounded-holdings
    // drift from the rounded ledger sum as soon as any row was finer than the
    // tick; on pre-flag-day rows (already on the tick's grid) it is identical.
    async getHolders(tick, block_index, action_index){
        let holders = {};
        let sql     = '',
            query   = '',
            results = null,
            args    = [],
            tick_id = null;
        // Get the tick_id for the given ticker
        if(!this.util.isNull(tick) && this.util.isNull(tick_id))
            tick_id = await this.createTicker(tick);
        // NOTE: the tick's decimal precision is no longer read here. Holder
        // balances are netted at the exact ledger scale (below), so the lookup
        // was a wasted round-trip per call.
        // Add tick_id to SQL query arguments
        args.push(tick_id);
        sql = ledgerScopeSql(this, 'a1', block_index, action_index, args);
        let holderSumExpr = ledgerPrecision.exactSumSql('m.amount');
        let exact         = ledgerPrecision.LEDGER_AMOUNT_PRECISION;
        // Get Credits
        query = `SELECT
                    ` + holderSumExpr + ` as credits,
                    a2.address
                FROM 
                    credits m
                    INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                    INNER JOIN index_addresses a2 ON (a2.id=m.address_id)
                WHERE 
                    m.tick_id=?` + sql + `
                GROUP BY a2.address`;
        results = await this.doQuery(query, args);
        if(results.length > 0)
            for(let row of results)
                holders[row.address] = row.credits;
        // Get Debits
        query = `SELECT
                    ` + holderSumExpr + ` as debits,
                    a2.address
                FROM 
                    debits m
                    INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                    INNER JOIN index_addresses a2 ON (a2.id=m.address_id)
                WHERE 
                    m.tick_id=?` + sql + `
                GROUP BY a2.address`;
        results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                let balance = this.util.bcsub(holders[row.address], row.debits, exact);
                if(this.util.bcgt(balance, 0))
                    holders[row.address] = balance;
                else
                   delete holders[row.address];
            }
        }
        // Biggest first, with the deterministic address tiebreak sortHoldersDescending documents.
        return sortHoldersDescending(this, holders);
    },

    // Compute a poll's tally deterministically (Phase 1 lazy tally; the same logic
    // the system-injected VOTE v2 will freeze on-chain in Phase 2). Weight is the
    // voter's balance at the measure block (default = the poll's close block);
    // callers may pass the current tip for a provisional standing on an open poll.
    // Enforces the close-time backing rule (a voter must still hold the token at
    // the measure block) and the dust floor on participation counting.
    // Time-weighted average balance of every holder over [startBlock, endBlock],
    // for the time_weighted VOTE weight mode (Section 12.2). Resists
    // flash-acquisition voting: weight reflects sustained holding, not a close
    // snapshot. Derived from the credits/debits ledger (each event joined to its
    // action's block), NOT an O(blocks) scan: balance at startBlock + the signed
    // window events reconstruct the trajectory; each segment contributes
    // balance*blocks_held, summed and divided by the window length. All mathjs
    // fixed-precision; same-block events have zero-length segments so intra-block
    // ordering never affects the result (deterministic). Returns {address: avg}.
    async getTimeWeightedBalances(tick, startBlock, endBlock){
        startBlock = Number(startBlock);
        endBlock   = Number(endBlock);
        let windowLen = endBlock - startBlock;
        let startBal  = await this.getHolders(tick, startBlock, null);
        let tick_id   = await this.createTicker(tick);
        // Signed balance-change events in (startBlock, endBlock], oldest first.
        let rows = await this.doQuery(
            `SELECT ia.address AS address, ac.block_index AS block_index, c.amount AS amount, 1 AS sign
               FROM credits c
               INNER JOIN actions ac        ON ac.action_index = c.action_index
               INNER JOIN index_addresses ia ON ia.id = c.address_id
              WHERE c.tick_id = ? AND ac.block_index > ? AND ac.block_index <= ?
             UNION ALL
             SELECT ia.address AS address, ac.block_index AS block_index, d.amount AS amount, -1 AS sign
               FROM debits d
               INNER JOIN actions ac        ON ac.action_index = d.action_index
               INNER JOIN index_addresses ia ON ia.id = d.address_id
              WHERE d.tick_id = ? AND ac.block_index > ? AND ac.block_index <= ?
              ORDER BY block_index ASC`,
            [tick_id, startBlock, endBlock, tick_id, startBlock, endBlock]);
        let evByAddr = {};
        for(let r of rows){
            if(this.util.isNull(evByAddr[r.address])) evByAddr[r.address] = [];
            let delta = (Number(r.sign) < 0) ? this.util.bcmul(String(r.amount), '-1', 18) : String(r.amount);
            evByAddr[r.address].push({ block: Number(r.block_index), delta: delta });
        }
        let result = {};
        let addrs  = new Set([...Object.keys(startBal), ...Object.keys(evByAddr)]);
        for(let addr of addrs){
            let bal = this.util.isNull(startBal[addr]) ? '0' : String(startBal[addr]);
            // Degenerate window (close == creation): no integral, average is the
            // start balance (avoids divide-by-zero; a poll closing at its own
            // creation block can only happen via an immediate early-decide).
            if(windowLen <= 0){ result[addr] = bal; continue; }
            let prevBlock = startBlock;
            let integral  = '0';
            for(let ev of (evByAddr[addr] || [])){
                let segLen = ev.block - prevBlock;
                if(segLen > 0) integral = this.util.bcadd(integral, this.util.bcmul(bal, String(segLen), 18), 18);
                bal = this.util.bcadd(bal, ev.delta, 18);
                prevBlock = ev.block;
            }
            let tailLen = endBlock - prevBlock;
            if(tailLen > 0) integral = this.util.bcadd(integral, this.util.bcmul(bal, String(tailLen), 18), 18);
            result[addr] = this.util.bcdiv(integral, String(windowLen), 18);
        }
        return result;
    },

    ...bridgeReads,

};
