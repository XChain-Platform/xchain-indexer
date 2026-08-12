/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

/*********************************************************************
 * test/unit/adversarial-compact-id.test.js
 *
 * ADVERSARIAL SUITE (Cat 2 of the ^<id> compaction test brief).
 *
 * Goal: try to fork or crash the indexer through malformed / dangling
 * compact-ID (`^<id>`) wire references on the RESOLUTION path
 * (db.getAddressId / db.getTickerId), below the SDK (the SDK only ever
 * emits canonical `^<digits>`; an attacker hand-crafting a raw tx can put
 * anything in a reference field).
 *
 * These tests stub the DB pool (no MariaDB needed; runs on Node 22), so
 * they probe the PARSE/RESOLVE layer only. DB-coercion and real-collation
 * behaviour for the float/overflow cases is a separate VM-integration leg (Cat 1/6).
 *
 * The canonicalization + existence fix (#4900/#4901/#4902) is now APPLIED:
 * getAddressId / getTickerId accept ONLY a canonical `^[1-9][0-9]*` that
 * resolves to an existing block-stamped row, mirroring resolveAddressRef.
 * These tests are the regression guard for that fix (a non-canonical or
 * dangling caret resolves to null, never a phantom / aliased / coerced id).
 *********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// Build a Database whose pool is stubbed. `onQuery` lets a test observe / answer
// the DB lookup branch. By default the lookup throws, so any test that expects
// the caret fast-path to return WITHOUT a DB hit is proven by absence of throw.
function makeDb(onQuery) {
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config: getTestConfig(), util });
    const q = onQuery || (() => { throw new Error('DB lookup should not have been reached'); });
    db.doQuery = sinon.stub().callsFake(q);
    return db;
}

afterEach(function () { sinon.restore(); });

describe('Adversarial ^<id> resolution: dangling / malformed references @adversarial @tier1', function () {

    // ---- (A) Existence-checked: a well-formed caret-id is verified against a real row ----

    it('getAddressId existence-checks a canonical ^<id>: dangling -> null (no phantom)', async function () {
        // The caret branch now SELECTs (id WHERE block_index IS NOT NULL); no row -> null.
        const db = makeDb((sql, args) => { assert.strictEqual(args[0], '999999', 'id passed as digit string'); return []; });
        const id = await db.getAddressId('^999999');
        assert.strictEqual(id, null, 'dangling caret-id is verified and rejected');
        assert.strictEqual(db.doQuery.called, true, 'a DB existence check WAS performed');
    });

    it('getAddressId resolves a canonical ^<id> that DOES exist', async function () {
        const db = makeDb(() => [{ id: 16 }]);
        assert.strictEqual(await db.getAddressId('^16'), 16);
    });

    it('getTickerId existence-checks a canonical ^<id>: dangling -> null', async function () {
        const db = makeDb(() => []);
        assert.strictEqual(await db.getTickerId('^999999'), null);
        assert.strictEqual(db.doQuery.called, true);
    });

    it('getTickerId resolves a canonical ^<id> that DOES exist (returns a Number)', async function () {
        const db = makeDb(() => [{ id: 42 }]);
        const id = await db.getTickerId('^42');
        assert.strictEqual(id, 42);
        assert.strictEqual(typeof id, 'number');
    });

    // ---- (B) Non-canonical encodings NO LONGER alias: each falls through to a literal lookup ----

    it('non-canonical caret encodings no longer alias to a numeric id (hex/sci/leading-zero/whitespace)', async function () {
        // None match /^[1-9][0-9]*$/, so each falls through to the literal string lookup
        // (which finds no "^…" address row) -> null. The aliasing gap is closed.
        const seen = [];
        const db = makeDb((sql, args) => { seen.push(args && args[0]); return []; });
        for (const bad of ['^0x10', '^1e3', '^00123', '^ 1', '^007']) {
            assert.strictEqual(await db.getAddressId(bad), null, `${JSON.stringify(bad)} no longer resolves to an id`);
        }
        assert.strictEqual(seen.length, 5, 'each non-canonical caret string hit the literal lookup branch, never the id existence SELECT');
        assert.ok(seen.every(s => String(s).charAt(0) === '^'), 'the literal lookup used the raw caret string, proving no numeric coercion happened');
    });

    // ---- (C) Former fork/crash candidates: non-integer and out-of-range ids are now rejected ----

    it('a FLOAT ^1.5 is non-canonical -> null (never coerced onto an integer FK)', async function () {
        const db = makeDb(() => []);
        assert.strictEqual(await db.getAddressId('^1.5'), null);
    });

    it('a NEGATIVE ^-1 is non-canonical -> null', async function () {
        const db = makeDb(() => []);
        assert.strictEqual(await db.getAddressId('^-1'), null);
    });

    it('an OUT-OF-RANGE huge ^<id> is matched as a digit string, not coerced to a float', async function () {
        const big = '^' + '9'.repeat(38); // ~1e38, BIGINT UNSIGNED max ~1.8e19
        let captured;
        const db = makeDb((sql, args) => { captured = args[0]; return []; }); // no row -> null
        assert.strictEqual(await db.getAddressId(big), null);
        assert.strictEqual(captured, '9'.repeat(38), 'id handed to SQL verbatim (no Number() overflow)');
        assert.strictEqual(typeof captured, 'string');
    });

    // ---- (D) Address and ticker resolvers are now symmetric (canonical + existence + Number) ----

    it('getAddressId and getTickerId resolve a canonical existing ^<id> symmetrically (both Number)', async function () {
        const db = makeDb(() => [{ id: 1000 }]);
        const addr = await db.getAddressId('^1000');
        const tick = await db.getTickerId('^1000');
        assert.strictEqual(addr, 1000);
        assert.strictEqual(tick, 1000);
        assert.strictEqual(typeof addr, 'number');
        assert.strictEqual(typeof tick, 'number');
    });

    // ---- (E) Non-numeric caret strings fall through to a literal lookup (must NOT crash) ----

    it('non-numeric caret strings fall through to a string lookup and do not crash', async function () {
        const seen = [];
        const db = makeDb((sql, args) => { seen.push(args && args[0]); return []; });
        for (const bad of ['^', '^abc', '^٢' /* arabic-indic 2 */, '^۱۲' /* persian 12 */]) {
            const id = await db.getAddressId(bad);
            assert.strictEqual(id, null, `${JSON.stringify(bad)} is treated as an unknown literal address -> null`);
        }
        assert.ok(seen.length === 4, 'each non-numeric caret string hit the literal lookup branch');
    });
});

describe('resolveAddressRef: the handler-side ^<id> -> canonical address guard (the fix) @adversarial @tier1', function () {

    it('resolves a canonical ^<digits> reference to the stored address', async function () {
        const db = makeDb((sql, args) => {
            assert.strictEqual(args[0], '123', 'id is passed to SQL as the digit string');
            return [{ address: 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef' }];
        });
        assert.strictEqual(await db.resolveAddressRef('^123'), 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef');
    });

    it('passes the id to SQL as a digit STRING (no Number(); preserves precision past 2^53)', async function () {
        let captured;
        const db = makeDb((sql, args) => { captured = args[0]; return []; });
        await db.resolveAddressRef('^999999999999999999999'); // 21 digits, > Number.MAX_SAFE_INTEGER
        assert.strictEqual(captured, '999999999999999999999');
        assert.strictEqual(typeof captured, 'string');
    });

    it('leaves a NON-canonical caret string unchanged and never queries (float/hex/sci/neg/space/empty/alpha)', async function () {
        const db = makeDb(() => { throw new Error('must not query for a non-canonical reference'); });
        for (const bad of ['^1.5', '^0x10', '^1e3', '^-1', '^ 1', '^', '^abc', '^007', '^0']) {
            assert.strictEqual(await db.resolveAddressRef(bad), bad,
                `${JSON.stringify(bad)} must be returned unchanged so isCryptoAddress rejects it`);
        }
    });

    it('leaves a DANGLING ^<id> unchanged (no row) so the format check rejects it (no silent drop)', async function () {
        const db = makeDb(() => []); // id resolves to no row
        assert.strictEqual(await db.resolveAddressRef('^999999'), '^999999');
    });

    it('returns a full address and null/empty unchanged (no query)', async function () {
        const db = makeDb(() => { throw new Error('must not query for a non-reference value'); });
        assert.strictEqual(await db.resolveAddressRef('mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef'), 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef');
        assert.strictEqual(await db.resolveAddressRef(''), '');
        assert.strictEqual(await db.resolveAddressRef(null), null);
    });
});
