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
 * API-level assertion helpers for E2E tests.
 *
 * These assert on Explorer HTTP API responses, complementing the
 * DB-level assertions in the integration test suite.
 */

'use strict';

const assert = require('assert');

/** Assert a successful HTTP response with a JSON body. */
function assertApiOk(response, msg) {
    assert.strictEqual(response.status, 200,
        `${msg || 'API'}: expected 200, got ${response.status}`);
    assert.ok(typeof response.body === 'object',
        `${msg || 'API'}: expected JSON body`);
}

/** Assert a list-format API response: { total, data, runtime }. */
function assertListResponse(body, minTotal, msg) {
    const label = msg || 'list response';
    assert.ok('total' in body, `${label}: missing 'total' field`);
    assert.ok(Array.isArray(body.data), `${label}: 'data' should be an array`);
    assert.ok(body.total >= minTotal,
        `${label}: expected total >= ${minTotal}, got ${body.total}`);
}

/** Assert a DataTables-format explorer response: { recordsTotal, recordsFiltered, data }. */
function assertExplorerResponse(body, minTotal, msg) {
    const label = msg || 'explorer response';
    assert.ok('recordsTotal' in body, `${label}: missing 'recordsTotal'`);
    assert.ok('recordsFiltered' in body, `${label}: missing 'recordsFiltered'`);
    assert.ok(Array.isArray(body.data), `${label}: 'data' should be an array`);
    assert.ok(body.recordsTotal >= minTotal,
        `${label}: expected recordsTotal >= ${minTotal}, got ${body.recordsTotal}`);
}

/** Assert an API token response has expected fields. */
function assertTokenFields(body, expected) {
    assert.ok(body.info, 'Token response missing info object');
    if (expected.tick)
        assert.strictEqual(body.info.tick, expected.tick, `Token tick mismatch`);
    if (expected.owner)
        assert.strictEqual(body.info.owner, expected.owner, `Token owner mismatch`);
    if (expected.supply !== undefined) {
        assert.ok(body.supply, 'Token response missing supply object');
        assert.strictEqual(body.supply.current, String(expected.supply), `Token supply mismatch`);
    }
    if (expected.maxSupply !== undefined) {
        assert.ok(body.supply, 'Token response missing supply object');
        assert.strictEqual(body.supply.max, String(expected.maxSupply), `Token max_supply mismatch`);
    }
}

/**
 * Assert a balances response contains an entry for the given tick with the expected amount.
 * Balances format: { address, total, data: [{ tick, amount, ... }] }
 */
function assertBalanceEntry(body, tick, expectedAmount) {
    assert.ok(Array.isArray(body.data), 'Balances response missing data array');
    const entry = body.data.find(d => d.tick === tick);
    assert.ok(entry, `No balance entry found for tick '${tick}'`);
    assert.strictEqual(entry.amount, String(expectedAmount),
        `Balance for ${tick}: expected ${expectedAmount}, got ${entry.amount}`);
}

/**
 * Assert no balance entry exists for the given tick.
 */
function assertNoBalanceEntry(body, tick) {
    if (!body.data) return; // no data at all means no balance
    const entry = body.data.find(d => d.tick === tick);
    assert.ok(!entry, `Expected no balance for tick '${tick}', but found amount=${entry && entry.amount}`);
}

/**
 * Assert a list response data array contains at least one record matching all fieldChecks.
 * @param {object} body - API response body
 * @param {object} fieldChecks - key/value pairs to match (values compared as strings)
 */
function assertDataContains(body, fieldChecks, msg) {
    const label = msg || 'data';
    assert.ok(Array.isArray(body.data), `${label}: missing data array`);
    const match = body.data.find(row =>
        Object.entries(fieldChecks).every(([k, v]) => String(row[k]) === String(v))
    );
    assert.ok(match,
        `${label}: no record matches ${JSON.stringify(fieldChecks)} in ${body.data.length} rows`);
}

/**
 * Assert a list response data array does NOT contain a record matching all fieldChecks.
 */
function assertDataNotContains(body, fieldChecks, msg) {
    const label = msg || 'data';
    if (!Array.isArray(body.data)) return;
    const match = body.data.find(row =>
        Object.entries(fieldChecks).every(([k, v]) => String(row[k]) === String(v))
    );
    assert.ok(!match,
        `${label}: found unexpected record matching ${JSON.stringify(fieldChecks)}`);
}

module.exports = {
    assertApiOk,
    assertListResponse,
    assertExplorerResponse,
    assertTokenFields,
    assertBalanceEntry,
    assertNoBalanceEntry,
    assertDataContains,
    assertDataNotContains,
};
