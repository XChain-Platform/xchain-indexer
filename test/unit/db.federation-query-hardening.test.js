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
 * test/unit/db.federation-query-hardening.test.js
 *
 * Hardening guards for two federation-facing read paths surfaced by the
 * 2026-07-08 federation-query stress-sweep:
 *
 *  - getPendingAttestationRequests(): the row count is interpolated into raw SQL,
 *    so a non-integer limit produced `LIMIT 100.5` (a MariaDB syntax error that
 *    failed the whole attestation-work poll). The limit is now floored, hard-
 *    capped and passed as a bound param.
 *
 *  - getCapabilitySnapshotValidators(): a NULL snapshot amount surfaced as the
 *    literal string 'null', diverging from the sibling getCapabilitySnapshotWeights
 *    and the BTC local path (both coerce NULL to '0'). Now null-guarded to '0'.
 *
 * Technique (matches db.queries.test.js): stub doQuery on a prototype-borrowed
 * Database so each method exercises real logic against injected results; no live
 * MariaDB required. _mirrorDb() returns `this` in single-host, so a doQuery stub
 * also covers the capability_snapshots read.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

afterEach(function () {
    sinon.restore();
});

describe('getPendingAttestationRequests() LIMIT hardening @regression @tier1', function () {

    // Capture the (query, args) doQuery receives so we can assert the LIMIT shape.
    function dbCapturing() {
        const db = makeDb();
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake((query, args) => {
            calls.push({ query, args });
            return Promise.resolve([]);
        });
        return { db, calls };
    }

    it('binds the row count as a `LIMIT ?` param, not raw string interpolation', async function () {
        const { db, calls } = dbCapturing();
        await db.getPendingAttestationRequests(null, 100, null);
        assert.strictEqual(calls.length, 1);
        assert.match(calls[0].query, /LIMIT \?/, 'LIMIT must be a bound param');
        assert.doesNotMatch(calls[0].query, /LIMIT\s+\d/, 'no numeric literal interpolated');
        assert.strictEqual(calls[0].args[calls[0].args.length - 1], 100, 'bound limit is the last arg');
    });

    it('floors a fractional limit to an integer (would otherwise be a `LIMIT 100.5` syntax error)', async function () {
        const { db, calls } = dbCapturing();
        await db.getPendingAttestationRequests(null, 100.5, null);
        const bound = calls[0].args[calls[0].args.length - 1];
        assert.strictEqual(bound, 100, 'fractional limit floored to 100');
        assert.strictEqual(Number.isInteger(bound), true);
    });

    it('hard-caps the limit at 500 regardless of caller', async function () {
        const { db, calls } = dbCapturing();
        await db.getPendingAttestationRequests(null, 1e9, null);
        assert.strictEqual(calls[0].args[calls[0].args.length - 1], 500);
    });

    it('falls back to 100 for a non-positive / non-finite limit', async function () {
        const { db, calls } = dbCapturing();
        await db.getPendingAttestationRequests(null, 0, null);
        assert.strictEqual(calls[0].args[calls[0].args.length - 1], 100);
        calls.length = 0;
        await db.getPendingAttestationRequests(null, NaN, null);
        assert.strictEqual(calls[0].args[calls[0].args.length - 1], 100);
        calls.length = 0;
        await db.getPendingAttestationRequests(null, -5, null);
        assert.strictEqual(calls[0].args[calls[0].args.length - 1], 100);
    });

    it('still appends the provider_id + cursor args ahead of the bound limit', async function () {
        const { db, calls } = dbCapturing();
        await db.getPendingAttestationRequests('http_get', 50,
            { after_block_index: 10, after_action_index: 3 });
        const args = calls[0].args;
        // provider_id, then (block>?, block=?, action>?) cursor triple, then LIMIT.
        assert.strictEqual(args[0], 'http_get');
        assert.strictEqual(args[args.length - 1], 50, 'bound limit remains the final arg');
        assert.match(calls[0].query, /LIMIT \?/);
    });
});

describe('getCapabilitySnapshotValidators() NULL-amount guard @regression @tier1', function () {

    it("coerces a NULL snapshot amount to '0' (not the literal string 'null')", async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([
            { pubkey: 'aa'.repeat(32), amount: null },
            { pubkey: 'bb'.repeat(32), amount: '500' }
        ]);
        const out = await db.getCapabilitySnapshotValidators('cross_chain', 961000);
        assert.strictEqual(out[0].amount, '0', "NULL amount must render as '0'");
        assert.strictEqual(out[1].amount, '500');
    });

    it('matches the sibling getCapabilitySnapshotWeights null contract', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ pubkey: 'cc'.repeat(32), weight: null, source: null, amount: null }]);
        const vals = await db.getCapabilitySnapshotValidators('oracle_publish', 961000);
        const wts  = await db.getCapabilitySnapshotWeights('oracle_publish', 961000);
        assert.strictEqual(vals[0].amount, '0');
        assert.strictEqual(wts[0].weight, '0', 'sibling already guards weight');
    });
});
