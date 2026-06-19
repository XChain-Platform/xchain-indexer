/*********************************************************************
 * test/unit/adversarial-compact-id.test.js
 *
 * ADVERSARIAL SUITE (Cat 2 of the ^<id> compaction test brief,
 * claude/reports/2026-06-19_address-token-id-adversarial-test-brief.md).
 *
 * Goal: try to fork or crash the indexer through malformed / dangling
 * compact-ID (`^<id>`) wire references on the RESOLUTION path
 * (db.getAddressId / db.getTickerId), below the SDK (the SDK only ever
 * emits canonical `^<digits>`; an attacker hand-crafting a raw tx can put
 * anything in a reference field).
 *
 * These tests stub the DB pool (no MariaDB needed; runs on Node 22), so
 * they probe the PARSE/RESOLVE layer only. DB-coercion and real-collation
 * behaviour for the float/overflow cases is the test-host/VM leg (Cat 1/6).
 *
 * Findings are tagged FINDING in the test name. They assert CURRENT
 * behaviour (regression guard) and document the risk; the recommended fix
 * is in the findings report, not applied here.
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

    // ---- (A) Fail-open: a well-formed caret-id is accepted with NO existence check ----

    it('FINDING: getAddressId accepts a dangling ^<id> with no existence check (fail-open)', async function () {
        // doQuery throws if reached; a return value proves the row was never verified.
        const db = makeDb();
        const id = await db.getAddressId('^999999');
        assert.strictEqual(id, 999999, 'dangling caret-id returns the bare number, unverified');
        assert.strictEqual(db.doQuery.called, false, 'no DB existence check was performed');
        // Consensus note: not a fork by itself (every node resolves the same wire bytes to
        // the same missing id -> NULL string at hash time). It IS a silent-counterparty bug:
        // a credit/debit can name a non-existent entity and be hashed as NULL.
    });

    it('getTickerId likewise accepts a dangling ^<id> with no existence check', async function () {
        const db = makeDb();
        const id = await db.getTickerId('^999999');
        assert.strictEqual(String(id), '999999');
        assert.strictEqual(db.doQuery.called, false);
    });

    // ---- (B) Non-canonical encodings that ALIAS to the same id (wire is not canonical) ----

    it('FINDING: multiple wire encodings resolve to the SAME address id (non-canonical wire form)', async function () {
        const db = makeDb();
        const id16  = await db.getAddressId('^16');
        const idHex = await db.getAddressId('^0x10');   // hex 0x10 == 16
        const id1k  = await db.getAddressId('^1000');
        const idSci = await db.getAddressId('^1e3');    // 1e3 == 1000
        const id123 = await db.getAddressId('^123');
        const idLz  = await db.getAddressId('^00123');  // leading zeros == 123
        const id1   = await db.getAddressId('^1');
        const idWs  = await db.getAddressId('^ 1');     // leading whitespace == 1
        assert.strictEqual(idHex, id16,  '^0x10 aliases ^16');
        assert.strictEqual(idSci, id1k,  '^1e3 aliases ^1000');
        assert.strictEqual(idLz,  id123, '^00123 aliases ^123');
        assert.strictEqual(idWs,  id1,   '^ 1 aliases ^1');
        // Indexer hashes identically for aliases (same resolved id -> same string), so this is
        // NOT an indexer fork. It IS a wire-canonicalisation gap: the encoder/SDK/validator
        // should accept only /^\^[0-9]+$/ so a single id has a single on-wire byte form
        // (matters for tx canonicalisation / signatures / dedupe).
    });

    // ---- (C) The real fork/crash candidates: non-integer and out-of-range ids ----

    it('FINDING: getAddressId returns a FLOAT id for ^1.5 (DB integer-column coercion is the fork risk)', async function () {
        const db = makeDb();
        const id = await db.getAddressId('^1.5');
        assert.strictEqual(id, 1.5, 'parse layer does not reject a fractional id');
        assert.ok(!Number.isInteger(id), 'a non-integer FK value will be coerced by MariaDB (version/sql_mode dependent) -> divergence candidate; must be canonicalised before the INSERT');
    });

    it('FINDING: getAddressId returns a NEGATIVE id for ^-1', async function () {
        const db = makeDb();
        const id = await db.getAddressId('^-1');
        assert.strictEqual(id, -1, 'negative id accepted; address_id is UNSIGNED -> coercion/overflow candidate');
    });

    it('FINDING: getAddressId returns an OUT-OF-RANGE id far beyond BIGINT for a huge ^<id>', async function () {
        const db = makeDb();
        const big = '^' + '9'.repeat(38); // ~1e38, BIGINT UNSIGNED max ~1.8e19
        const id  = await db.getAddressId(big);
        assert.ok(id > 1.8e19, 'value exceeds BIGINT UNSIGNED range; INSERT/compare behaviour is DB-dependent (clamp/error) -> crash/divergence candidate');
    });

    // ---- (D) Address vs ticker resolver asymmetry (Number() vs raw string) ----

    it('FINDING: getAddressId returns a Number while getTickerId returns the raw string for the same ^<id>', async function () {
        const db = makeDb();
        const addr = await db.getAddressId('^1e3');
        const tick = await db.getTickerId('^1e3');
        assert.strictEqual(typeof addr, 'number', 'address resolver does Number(pid) -> 1000');
        assert.strictEqual(addr, 1000);
        assert.strictEqual(typeof tick, 'string', 'ticker resolver returns pid verbatim -> "1e3"');
        assert.strictEqual(tick, '1e3');
        // The downstream createTicker does Number() at the end, so they converge, but the
        // divergent intermediate types are a latent footgun if either path is reused.
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
        for (const bad of ['^1.5', '^0x10', '^1e3', '^-1', '^ 1', '^', '^abc']) {
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
