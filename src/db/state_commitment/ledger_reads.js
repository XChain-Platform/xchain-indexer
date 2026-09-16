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
async function ledgerKeysForBlock(db, blockIndex){
    const rows = await db.doQueryStrict(
        `SELECT DISTINCT ia.address AS address, it.tick AS tick
           FROM (
                SELECT action_index, address_id, tick_id FROM credits
                UNION ALL
                SELECT action_index, address_id, tick_id FROM debits
           ) s
           INNER JOIN actions a          ON a.action_index = s.action_index
           INNER JOIN index_addresses ia ON ia.id = s.address_id
           INNER JOIN index_tickers   it ON it.id = s.tick_id
          WHERE a.block_index = ?`, [blockIndex]);

    const keys = new Set();
    for(const r of (rows || []))
        if(r.address != null && r.tick != null && r.tick !== '')
            keys.add(r.address + '\t' + r.tick);
    return keys;
}

module.exports = {
    getNetBalance,
    getNonzeroNetBalances,
    ledgerKeysForBlock
};
