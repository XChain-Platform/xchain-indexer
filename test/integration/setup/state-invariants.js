'use strict';

/*
 * Whole-ledger state invariants (Phase 1b — indexer state-invariants).
 *
 * Generalizes the per-tick assertSanity (and db.js:sanityCheck) into a sweep
 * over the ENTIRE current indexer state, asserting the properties that define a
 * correct ledger after any sequence of actions:
 *
 *   - CONSERVATION  per tick: tokens.supply == (Σcredits − Σdebits + Σescrows)
 *                                          == (Σbalances + Σescrows)
 *   - SUPPLY ≥ 0    per tick (no token can owe itself into existence)
 *   - ESCROW ≥ 0    per tick (net locked can't be negative)
 *   - NO NEGATIVE BALANCE: `balances` is current-balance-per-(address,tick)
 *                          (UNIQUE addr_tick + ON DUPLICATE KEY UPDATE), so no
 *                          row may hold a negative amount.
 *
 * Pure SQL over an indexerQuery(sql, args) function — pair with the integration
 * harness (drive the real indexer, then assert) or any seeded indexer DB.
 */

const assert = require('assert');

async function _sum(indexerQuery, table, tickId) {
    const r = await indexerQuery(
        `SELECT COALESCE(SUM(CAST(amount AS DECIMAL(65,18))), 0) AS total FROM ${table} WHERE tick_id = ?`,
        [tickId]
    );
    return parseFloat(r[0].total);
}

/**
 * Assert every ledger invariant over the current indexer DB state.
 * Returns { ticksChecked } on success; throws AssertionError on the first
 * violation (message names the invariant + offending tick).
 */
async function assertStateInvariants(indexerQuery) {
    const ticks = await indexerQuery(
        `SELECT it.id AS tick_id, it.tick, t.supply
         FROM tokens t INNER JOIN index_tickers it ON it.id = t.tick_id`
    );

    for (const row of ticks) {
        const tickId = row.tick_id;
        const tick = row.tick;
        const supply = parseFloat(row.supply);

        const credits = await _sum(indexerQuery, 'credits', tickId);
        const debits = await _sum(indexerQuery, 'debits', tickId);
        const escrows = await _sum(indexerQuery, 'escrows', tickId);
        const balances = await _sum(indexerQuery, 'balances', tickId);

        const ledger = credits - debits + escrows;
        const total = balances + escrows;

        assert.strictEqual(supply, ledger,
            `INVARIANT[conservation-ledger]: ${tick} supply ${supply} != credits-debits+escrows ${ledger}`);
        assert.strictEqual(supply, total,
            `INVARIANT[conservation-balance]: ${tick} supply ${supply} != balances+escrows ${total}`);
        assert.ok(supply >= 0, `INVARIANT[supply>=0]: ${tick} supply ${supply} < 0`);
        assert.ok(escrows >= 0, `INVARIANT[escrow>=0]: ${tick} net escrow ${escrows} < 0`);
    }

    // No current balance row may be negative (you cannot hold negative tokens).
    const negBalances = await indexerQuery(
        `SELECT it.tick, b.address_id, b.amount
         FROM balances b INNER JOIN index_tickers it ON it.id = b.tick_id
         WHERE CAST(b.amount AS DECIMAL(65,18)) < 0 LIMIT 10`
    );
    assert.strictEqual(negBalances.length, 0,
        `INVARIANT[no-negative-balance]: ${JSON.stringify(negBalances)}`);

    return { ticksChecked: ticks.length };
}

module.exports = { assertStateInvariants };
