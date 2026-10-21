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
 * XChain Indexer - Database part: state commitment ledger reads
 *
 * The credits/debits reads the balances_root commitment derives from: one
 * key's authoritative net, every nonzero net for a full rebuild, and the keys
 * one block's ledger moved. Plain functions over a db handle rather than a
 * mixin, because the commitment is also driven by unit mocks that implement
 * only doQueryStrict and by the bin/ replay tools, neither of which installs
 * the Database prototype.
 *
 * M-17: every read here uses doQueryStrict, never doQuery. See the note above
 * DbNodeStore in src/state_commitment/persistent_smt.js for why a fail-soft [] is a WRONG
 * answer on these paths rather than an error signal.
 *
 ********************************************************************/

'use strict';

// ---- Leaf value derivation (authoritative, never the balances cache) --------
// Per SPV spec §4.2 the leaf is the authoritative SUM(credits)-SUM(debits) at 18 dp,
// NOT the mutable balances cache (the per-block sanityCheck verifies aggregate
// SUPPLIES, not per-address balances, so the cache is not guaranteed correct
// per-key). Cost is O(history per touched key); flagged for Phase-1 throughput
// measurement on the fast chains. Resolves through the index tables by canonical
// string (never surrogate ids), matching BLOCK_HASH_VERSION's id-independence rule.
async function getNetBalance(db, address, tick){
    const rows = await db.doQueryStrict(
        `SELECT
            (SELECT COALESCE(SUM(CAST(c.amount AS DECIMAL(60,18))),0) FROM credits c
                INNER JOIN index_addresses a ON a.id=c.address_id
                INNER JOIN index_tickers   t ON t.id=c.tick_id
                WHERE a.address=? AND t.tick=?) AS cr,
            (SELECT COALESCE(SUM(CAST(d.amount AS DECIMAL(60,18))),0) FROM debits d
                INNER JOIN index_addresses a ON a.id=d.address_id
                INNER JOIN index_tickers   t ON t.id=d.tick_id
                WHERE a.address=? AND t.tick=?) AS dr`,
        [address, tick, address, tick]);
    const cr = rows.length ? String(rows[0].cr) : '0';
    const dr = rows.length ? String(rows[0].dr) : '0';
    // Render via bcstr: bcsub returns a decimal.js bignumber whose String() form
    // goes exponential below 1e-7 ("1e-8"), which canonicalAmount rejects and
    // wedges the block loop. bcstr is minimal fixed notation, byte-identical to
    // the sync follower's SQL minimal-decimal rendering of the same net.
    return db.util.bcstr(db.util.bcsub(cr, dr, 18));
}

// Keys per statement of getNetBalances: each key binds two parameters, so a chunk
// stays far under the placeholder limit while a block still costs one round trip.
const NET_BALANCES_CHUNK = 500;

// getNetBalance for many keys at once: one statement per chunk of keys rather than one
// serial query per key. Each key is the same correlated authoritative sum as
// getNetBalance (same joins, same equality on the canonical strings), so a key's net is
// byte-identical to the single-key read, including whatever collation folding the
// index tables apply. Returns a Map of address<TAB>tick to the minimal-decimal net; a
// key with no ledger rows is '0', exactly as getNetBalance reports it.
async function getNetBalances(db, keys){
    const wanted = [];
    const seen = new Set();
    for(const [address, tick] of keys){
        const id = address + '\t' + tick;
        if(seen.has(id)) continue;
        seen.add(id);
        wanted.push([address, tick, id]);
    }
    const out = new Map();
    for(let off = 0; off < wanted.length; off += NET_BALANCES_CHUNK){
        const chunk = wanted.slice(off, off + NET_BALANCES_CHUNK);
        const params = [];
        const inputs = chunk.map((k, i) => {
            params.push(k[0], k[1]);
            return i === 0 ? 'SELECT 0 AS i, ? AS address, ? AS tick'
                           : 'SELECT ' + i + ', ?, ?';
        }).join(' UNION ALL ');
        const rows = await db.doQueryStrict(
            `SELECT k.i AS i,
                (SELECT COALESCE(SUM(CAST(c.amount AS DECIMAL(60,18))),0) FROM credits c
                    INNER JOIN index_addresses a ON a.id=c.address_id
                    INNER JOIN index_tickers   t ON t.id=c.tick_id
                    WHERE a.address=k.address AND t.tick=k.tick) AS cr,
                (SELECT COALESCE(SUM(CAST(d.amount AS DECIMAL(60,18))),0) FROM debits d
                    INNER JOIN index_addresses a ON a.id=d.address_id
                    INNER JOIN index_tickers   t ON t.id=d.tick_id
                    WHERE a.address=k.address AND t.tick=k.tick) AS dr
               FROM (${inputs}) k`, params);
        const byIdx = new Map();
        (rows || []).forEach((r, pos) => byIdx.set(r.i == null ? pos : Number(r.i), r));
        chunk.forEach((k, i) => {
            const r = byIdx.get(i);
            const cr = r ? String(r.cr) : '0';
            const dr = r ? String(r.dr) : '0';
            out.set(k[2], db.util.bcstr(db.util.bcsub(cr, dr, 18)));
        });
    }
    return out;
}

// Every (address, tick) with a nonzero net across the whole ledger, as
// { address, tick, net } rows: the input of the flag-day full balances build
// (state_commitment/full_balances_root.js).
async function getNonzeroNetBalances(db){
    return db.doQueryStrict(
        `SELECT a.address AS address, t.tick AS tick, CAST(SUM(s.amt) AS CHAR) AS net FROM (
            SELECT address_id, tick_id,  CAST(amount AS DECIMAL(60,18)) AS amt FROM credits
            UNION ALL
            SELECT address_id, tick_id, -CAST(amount AS DECIMAL(60,18)) AS amt FROM debits
         ) s
         INNER JOIN index_addresses a ON a.id=s.address_id
         INNER JOIN index_tickers   t ON t.id=s.tick_id
         GROUP BY s.address_id, s.tick_id
         HAVING SUM(s.amt) <> 0`, []);
}

// The (address, tick) keys THIS block's ledger moved, as canonical strings
// resolved through the index tables, which is the same derivation the
// commitment's own key uses. Shared by the touched-set guard and the
// leaf-presence assertion (state_commitment/touch_guards.js) so the two can
// never drift into disagreeing about what the block moved.
//
// doQueryStrict, never doQuery: inside the block transaction a failed read
// throws and the block retries. A guard that reads through the fail-soft path
// would see [] as "the ledger moved nothing" and pass every block, which is
// worse than not having a guard at all (M-17).
//
// Each UNION ALL branch joins actions and filters by block itself: a block_index
// predicate outside the derived table cannot be pushed into it, so the old shape
// materialized every credits and debits row ever written on each call.
async function ledgerKeysForBlock(db, blockIndex){
    const rows = await db.doQueryStrict(
        `SELECT DISTINCT ia.address AS address, it.tick AS tick
           FROM (
                SELECT c.address_id, c.tick_id FROM credits c
                  INNER JOIN actions a ON a.action_index = c.action_index
                 WHERE a.block_index = ?
                UNION ALL
                SELECT d.address_id, d.tick_id FROM debits d
                  INNER JOIN actions a ON a.action_index = d.action_index
                 WHERE a.block_index = ?
           ) s
           INNER JOIN index_addresses ia ON ia.id = s.address_id
           INNER JOIN index_tickers   it ON it.id = s.tick_id`, [blockIndex, blockIndex]);

    const keys = new Set();
    for(const r of (rows || []))
        if(r.address != null && r.tick != null && r.tick !== '')
            keys.add(r.address + '\t' + r.tick);
    return keys;
}

// Return the longest credit/debit histories first, with stable tie-breaks.
async function getHottestLedgerKeys(db, limit){
    const n = Math.max(1, Math.min(10000, Math.floor(Number(limit)) || 1));
    const rows = await db.doQueryStrict(
        `SELECT a.address AS address, t.tick AS tick, SUM(s.n) AS \`rows\` FROM (
            SELECT address_id, tick_id, COUNT(*) AS n FROM credits GROUP BY address_id, tick_id
            UNION ALL
            SELECT address_id, tick_id, COUNT(*) AS n FROM debits  GROUP BY address_id, tick_id
         ) s
         INNER JOIN index_addresses a ON a.id=s.address_id
         INNER JOIN index_tickers   t ON t.id=s.tick_id
         GROUP BY s.address_id, s.tick_id, a.address, t.tick
         ORDER BY \`rows\` DESC, a.address, t.tick
         LIMIT ${n}`, []);
    return (rows || []).map(r => ({ address: r.address, tick: r.tick, rows: Number(r.rows) }));
}

module.exports = {
    getHottestLedgerKeys,
    getNetBalance,
    getNetBalances,
    getNonzeroNetBalances,
    ledgerKeysForBlock
};
