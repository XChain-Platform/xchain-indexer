'use strict';

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
 * Whole-ledger state invariants (Phase 1b: indexer state-invariants).
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
 * Pure SQL over an indexerQuery(sql, args) function; pair with the integration
 * harness (drive the real indexer, then assert) or any seeded indexer DB.
 */

const assert = require('assert');
const mathjs = require('mathjs');

// Exact decimal. A conservation checker MUST NOT go through parseFloat / JS
// doubles: parseFloat loses precision past 2^53 (~9e15, well under the 10^21
// MAX_TOKEN_SUPPLY) and below ~1e-15, so a real 1e-18 discrepancy between two
// large supplies is invisible (false pass) and 10^21+1 can't be told from
// 10^21 (false fail). We keep every value as an exact bignumber string from
// SQL and compare with decimal.js's exact .eq (never `parseFloat` or `===`).
const bn = (s) => mathjs.bignumber(String(s == null ? 0 : s));

async function _sum(indexerQuery, table, tickId) {
    const r = await indexerQuery(
        `SELECT CAST(COALESCE(SUM(CAST(amount AS DECIMAL(65,18))), 0) AS CHAR) AS total FROM ${table} WHERE tick_id = ?`,
        [tickId]
    );
    return bn(r[0].total);
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
        const supply = bn(row.supply);

        const credits = await _sum(indexerQuery, 'credits', tickId);
        const debits = await _sum(indexerQuery, 'debits', tickId);
        const escrows = await _sum(indexerQuery, 'escrows', tickId);
        const balances = await _sum(indexerQuery, 'balances', tickId);

        const ledger = credits.minus(debits).plus(escrows);
        const total = balances.plus(escrows);

        assert.ok(supply.eq(ledger),
            `INVARIANT[conservation-ledger]: ${tick} supply ${supply} != credits-debits+escrows ${ledger}`);
        assert.ok(supply.eq(total),
            `INVARIANT[conservation-balance]: ${tick} supply ${supply} != balances+escrows ${total}`);
        assert.ok(supply.gte(0), `INVARIANT[supply>=0]: ${tick} supply ${supply} < 0`);
        assert.ok(escrows.gte(0), `INVARIANT[escrow>=0]: ${tick} net escrow ${escrows} < 0`);
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
