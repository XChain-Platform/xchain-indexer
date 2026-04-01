/**
 * test/unit/db.test.js
 *
 * Unit tests for Database class methods that do not require a live MariaDB connection.
 *
 * Primary target: normalizeDataValues()
 * Secondary:      getBlockIndex() input-validation branches
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert  = require('assert');
const sinon   = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// ---------------------------------------------------------------------------
// Build a minimal object that has the method + dependencies, but no real DB
// ---------------------------------------------------------------------------
function makeDbLike() {
    const config = getTestConfig();
    const util   = new Utility();
    const obj    = {
        config,
        util,
        normalizeDataValues: Database.prototype.normalizeDataValues,
    };
    return { obj, config, util };
}

// ---------------------------------------------------------------------------
// describe: normalizeDataValues
// ---------------------------------------------------------------------------
describe('Database.normalizeDataValues() @regression @tier1', function () {
    let normalize;
    let config;
    let util;

    beforeEach(function () {
        const built = makeDbLike();
        config      = built.config;
        util        = built.util;
        normalize   = built.obj.normalizeDataValues.bind(built.obj);
    });

    // ── Boxed-object coercion ─────────────────────────────────────────────

    it('converts a mathjs bignumber object to string', function () {
        const bn   = util.bcnum('12345678901234567890');
        const data = { AMOUNT: bn };
        const out  = normalize(data);
        assert.strictEqual(typeof out.AMOUNT, 'string');
        assert.strictEqual(util.bcformat(out.AMOUNT, 0), '12345678901234567890');
    });

    it('leaves a plain string value unchanged', function () {
        const data = { AMOUNT: '100' };
        const out  = normalize(data);
        assert.strictEqual(out.AMOUNT, '100');
    });

    it('leaves null values unchanged', function () {
        const data = { AMOUNT: null };
        const out  = normalize(data);
        assert.strictEqual(out.AMOUNT, null);
    });

    // ── LIST_FIELDS (ALLOW_LIST, BLOCK_LIST) ─────────────────────────────

    it('keeps ALLOW_LIST when it is numeric', function () {
        const data = { ALLOW_LIST: '42', BLOCK_LIST: null };
        const out  = normalize(data);
        assert.strictEqual(out.ALLOW_LIST, '42');
    });

    it('keeps BLOCK_LIST when it is a numeric integer string', function () {
        const data = { ALLOW_LIST: null, BLOCK_LIST: '7' };
        const out  = normalize(data);
        assert.strictEqual(out.BLOCK_LIST, '7');
    });

    it('sets ALLOW_LIST to null when it is a non-numeric string', function () {
        const data = { ALLOW_LIST: 'notanumber', BLOCK_LIST: null };
        const out  = normalize(data);
        assert.strictEqual(out.ALLOW_LIST, null);
    });

    it('sets BLOCK_LIST to null when it is a non-numeric string', function () {
        const data = { ALLOW_LIST: null, BLOCK_LIST: 'bad' };
        const out  = normalize(data);
        assert.strictEqual(out.BLOCK_LIST, null);
    });

    it('leaves ALLOW_LIST null when it is already null', function () {
        const data = { ALLOW_LIST: null, BLOCK_LIST: null };
        const out  = normalize(data);
        assert.strictEqual(out.ALLOW_LIST, null);
    });

    // ── NUMBER_FIELDS ─────────────────────────────────────────────────────

    it('keeps AMOUNT when it is a valid numeric string', function () {
        const data = { AMOUNT: '100' };
        const out  = normalize(data);
        assert.strictEqual(out.AMOUNT, '100');
    });

    it('sets AMOUNT to null when it is a non-numeric string', function () {
        const data = { AMOUNT: 'notanumber' };
        const out  = normalize(data);
        assert.strictEqual(out.AMOUNT, null);
    });

    it('sets AMOUNT to null when it is null', function () {
        const data = { AMOUNT: null };
        const out  = normalize(data);
        assert.strictEqual(out.AMOUNT, null);
    });

    it('sets MAX_SUPPLY to null when it is empty string', function () {
        const data = { MAX_SUPPLY: '' };
        const out  = normalize(data);
        assert.strictEqual(out.MAX_SUPPLY, null);
    });

    it('keeps MAX_SUPPLY when it is a valid large number string', function () {
        const data = { MAX_SUPPLY: '1000000000000000000000' };
        const out  = normalize(data);
        assert.strictEqual(out.MAX_SUPPLY, '1000000000000000000000');
    });

    it('sets DECIMALS to null when it is non-numeric in NUMBER_FIELDS pass', function () {
        const data = { DECIMALS: 'abc' };
        const out  = normalize(data);
        assert.strictEqual(out.DECIMALS, null);
    });

    // ── LOCK_FIELDS ───────────────────────────────────────────────────────

    it('keeps LOCK_MAX_SUPPLY when it is 0', function () {
        const data = { LOCK_MAX_SUPPLY: 0 };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_MAX_SUPPLY, 0);
    });

    it('keeps LOCK_MAX_SUPPLY when it is 1', function () {
        const data = { LOCK_MAX_SUPPLY: 1 };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_MAX_SUPPLY, 1);
    });

    it('sets LOCK_MAX_SUPPLY to null when it is 2', function () {
        const data = { LOCK_MAX_SUPPLY: 2 };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_MAX_SUPPLY, null);
    });

    it('sets LOCK_MAX_SUPPLY to null when it is -1', function () {
        const data = { LOCK_MAX_SUPPLY: -1 };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_MAX_SUPPLY, null);
    });

    it('sets LOCK_MAX_SUPPLY to null when it is null', function () {
        const data = { LOCK_MAX_SUPPLY: null };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_MAX_SUPPLY, null);
    });

    it('converts LOCK_MINT string "1" to integer 1', function () {
        // String '1' is numeric and converts to valid lock value 1
        const data = { LOCK_MINT: '1' };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_MINT, 1);
    });

    it('keeps LOCK_DESCRIPTION at 1', function () {
        const data = { LOCK_DESCRIPTION: 1 };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_DESCRIPTION, 1);
    });

    it('sets LOCK_CALLBACK to null for any value other than 0 or 1', function () {
        const data = { LOCK_CALLBACK: 99 };
        const out  = normalize(data);
        assert.strictEqual(out.LOCK_CALLBACK, null);
    });

    // ── DECIMALS range check ──────────────────────────────────────────────

    it('keeps DECIMALS when it is 0 (MIN boundary)', function () {
        const data = { DECIMALS: 0 };
        const out  = normalize(data);
        assert.strictEqual(out.DECIMALS, 0);
    });

    it('keeps DECIMALS when it is 18 (MAX boundary)', function () {
        const data = { DECIMALS: 18 };
        const out  = normalize(data);
        assert.strictEqual(out.DECIMALS, 18);
    });

    it('sets DECIMALS to null when it is -1 (below MIN)', function () {
        const data = { DECIMALS: -1 };
        const out  = normalize(data);
        assert.strictEqual(out.DECIMALS, null);
    });

    it('sets DECIMALS to null when it is 19 (above MAX)', function () {
        const data = { DECIMALS: 19 };
        const out  = normalize(data);
        assert.strictEqual(out.DECIMALS, null);
    });

    it('leaves DECIMALS as null when it is already null', function () {
        const data = { DECIMALS: null };
        const out  = normalize(data);
        assert.strictEqual(out.DECIMALS, null);
    });

    // ── BROADCAST truncation ──────────────────────────────────────────────

    it('BROADCAST: truncates MESSAGE at 250 chars', function () {
        const long = 'x'.repeat(300);
        const data = { ACTION: 'BROADCAST', MESSAGE: long, VALUE: null, FEE: null };
        const out  = normalize(data);
        assert.strictEqual(out.MESSAGE.length, 250);
    });

    it('BROADCAST: keeps MESSAGE when <= 250 chars', function () {
        const data = { ACTION: 'BROADCAST', MESSAGE: 'hello', VALUE: null, FEE: null };
        const out  = normalize(data);
        assert.strictEqual(out.MESSAGE, 'hello');
    });

    it('BROADCAST: leaves MESSAGE null when null', function () {
        const data = { ACTION: 'BROADCAST', MESSAGE: null, VALUE: null, FEE: null };
        const out  = normalize(data);
        assert.strictEqual(out.MESSAGE, null);
    });

    it('BROADCAST: VALUE is set to null because VALUE is a NUMBER_FIELD (non-numeric)', function () {
        // VALUE is listed in NUMBER_FIELDS, so a non-numeric string gets nulled before truncation
        const long = 'v'.repeat(50);
        const data = { ACTION: 'BROADCAST', MESSAGE: null, VALUE: long, FEE: null };
        const out  = normalize(data);
        // Non-numeric VALUE is wiped by NUMBER_FIELDS normalisation pass
        assert.strictEqual(out.VALUE, null);
    });

    it('BROADCAST: keeps numeric VALUE and truncates at 25 chars', function () {
        // A numeric VALUE string passes NUMBER_FIELDS check, then gets truncated
        const longNum = '1'.repeat(30);
        const data = { ACTION: 'BROADCAST', MESSAGE: null, VALUE: longNum, FEE: null };
        const out  = normalize(data);
        assert.strictEqual(out.VALUE.length, 25);
    });

    it('BROADCAST: truncates FEE at 11 chars', function () {
        const data = { ACTION: 'BROADCAST', MESSAGE: null, VALUE: null, FEE: '0.00000000000' };
        const out  = normalize(data);
        assert.strictEqual(out.FEE.length, 11);
    });

    it('BROADCAST: keeps FEE when <= 11 chars', function () {
        const data = { ACTION: 'BROADCAST', MESSAGE: null, VALUE: null, FEE: '1.5' };
        const out  = normalize(data);
        assert.strictEqual(out.FEE, '1.5');
    });

    // ── FILE truncation ───────────────────────────────────────────────────

    it('FILE: truncates NAME at 250 chars', function () {
        const long = 'n'.repeat(300);
        const data = { ACTION: 'FILE', NAME: long, TITLE: null };
        const out  = normalize(data);
        assert.strictEqual(out.NAME.length, 250);
    });

    it('FILE: truncates TITLE at 250 chars', function () {
        const long = 't'.repeat(300);
        const data = { ACTION: 'FILE', NAME: null, TITLE: long };
        const out  = normalize(data);
        assert.strictEqual(out.TITLE.length, 250);
    });

    it('FILE: leaves NAME null when null', function () {
        const data = { ACTION: 'FILE', NAME: null, TITLE: null };
        const out  = normalize(data);
        assert.strictEqual(out.NAME, null);
    });

    // ── ISSUE truncation ──────────────────────────────────────────────────

    it('ISSUE: truncates DESCRIPTION at 250 chars', function () {
        const long = 'd'.repeat(300);
        const data = { ACTION: 'ISSUE', DESCRIPTION: long };
        const out  = normalize(data);
        assert.strictEqual(out.DESCRIPTION.length, 250);
    });

    it('ISSUE: keeps DESCRIPTION when exactly 250 chars', function () {
        const desc = 'd'.repeat(250);
        const data = { ACTION: 'ISSUE', DESCRIPTION: desc };
        const out  = normalize(data);
        assert.strictEqual(out.DESCRIPTION.length, 250);
    });

    it('ISSUE: leaves DESCRIPTION null when null', function () {
        const data = { ACTION: 'ISSUE', DESCRIPTION: null };
        const out  = normalize(data);
        assert.strictEqual(out.DESCRIPTION, null);
    });

    // ── MESSAGE truncation ────────────────────────────────────────────────

    it('MESSAGE: ENCRYPTION_METHOD validated by NUMBER_FIELDS (kept if numeric)', function () {
        // ENCRYPTION_METHOD is in NUMBER_FIELDS — kept as-is if numeric, nullified otherwise.
        // Truncation removed to prevent converting valid numbers to invalid strings.
        const data = { ACTION: 'MESSAGE', ENCRYPTION_METHOD: '12' };
        const out  = normalize(data);
        assert.strictEqual(out.ENCRYPTION_METHOD, '12');
    });

    it('MESSAGE: leaves ENCRYPTION_METHOD null when null', function () {
        const data = { ACTION: 'MESSAGE', ENCRYPTION_METHOD: null };
        const out  = normalize(data);
        assert.strictEqual(out.ENCRYPTION_METHOD, null);
    });

    it('MESSAGE: keeps ENCRYPTION_METHOD when it is 1 character', function () {
        const data = { ACTION: 'MESSAGE', ENCRYPTION_METHOD: '2' };
        const out  = normalize(data);
        assert.strictEqual(out.ENCRYPTION_METHOD, '2');
    });

    // ── SLEEP truncation ──────────────────────────────────────────────────

    it('SLEEP: truncates RESUME_BLOCK at 25 chars', function () {
        const long = '9'.repeat(30);
        const data = { ACTION: 'SLEEP', RESUME_BLOCK: long };
        const out  = normalize(data);
        assert.strictEqual(out.RESUME_BLOCK.length, 25);
    });

    it('SLEEP: leaves RESUME_BLOCK null when null', function () {
        const data = { ACTION: 'SLEEP', RESUME_BLOCK: null };
        const out  = normalize(data);
        assert.strictEqual(out.RESUME_BLOCK, null);
    });

    it('SLEEP: keeps RESUME_BLOCK when <= 25 chars', function () {
        const data = { ACTION: 'SLEEP', RESUME_BLOCK: '100' };
        const out  = normalize(data);
        assert.strictEqual(out.RESUME_BLOCK, '100');
    });

    // ── MEMO truncation (applies to all actions) ──────────────────────────

    it('truncates MEMO at 250 chars for any action', function () {
        const long = 'm'.repeat(300);
        const data = { ACTION: 'SEND', MEMO: long };
        const out  = normalize(data);
        assert.strictEqual(out.MEMO.length, 250);
    });

    it('keeps MEMO when <= 250 chars', function () {
        const data = { ACTION: 'SEND', MEMO: 'hello' };
        const out  = normalize(data);
        assert.strictEqual(out.MEMO, 'hello');
    });

    it('leaves MEMO null when null', function () {
        const data = { ACTION: 'SEND', MEMO: null };
        const out  = normalize(data);
        assert.strictEqual(out.MEMO, null);
    });

    it('truncates MEMO even for BROADCAST action', function () {
        const long = 'm'.repeat(300);
        const data = { ACTION: 'BROADCAST', MESSAGE: null, VALUE: null, FEE: null, MEMO: long };
        const out  = normalize(data);
        assert.strictEqual(out.MEMO.length, 250);
    });

    // ── Unknown action falls through (no ACTION-specific handling) ────────

    it('does not crash on unknown ACTION string', function () {
        const data = { ACTION: 'UNKNOWN', MEMO: 'test' };
        const out  = normalize(data);
        assert.strictEqual(out.MEMO, 'test');
    });

    it('treats null ACTION as UNKNOWN and still normalizes MEMO', function () {
        const long = 'm'.repeat(300);
        const data = { ACTION: null, MEMO: long };
        const out  = normalize(data);
        assert.strictEqual(out.MEMO.length, 250);
    });

    // ── Return value ──────────────────────────────────────────────────────

    it('returns the same data object (mutates in-place)', function () {
        const data = { AMOUNT: '50' };
        const out  = normalize(data);
        assert.strictEqual(out, data);
    });
});

// ---------------------------------------------------------------------------
// describe: getBlockIndex — input validation only (mocked doQuery)
// ---------------------------------------------------------------------------
describe('Database.getBlockIndex() — input validation @regression @tier1', function () {
    let db;

    beforeEach(function () {
        const config = getTestConfig();
        const util   = new Utility();

        // Stub logError so it does not print to console during tests
        sinon.stub(util, 'logError');

        db = {
            config,
            util,
            doQuery: sinon.stub().resolves([]),
            getBlockIndex: Database.prototype.getBlockIndex,
        };
    });

    afterEach(function () {
        sinon.restore();
    });

    it('returns null for an invalid component', async function () {
        const result = await db.getBlockIndex.call(db, 'invalid', 'first');
        assert.strictEqual(result, null);
    });

    it('returns null for an invalid type', async function () {
        const result = await db.getBlockIndex.call(db, 'indexer', 'unknown');
        assert.strictEqual(result, null);
    });

    it('does not call doQuery when component is invalid', async function () {
        await db.getBlockIndex.call(db, 'bad', 'first');
        assert.strictEqual(db.doQuery.callCount, 0);
    });

    it('does not call doQuery when type is invalid', async function () {
        await db.getBlockIndex.call(db, 'decoder', 'bad');
        assert.strictEqual(db.doQuery.callCount, 0);
    });

    it('calls doQuery when component=decoder and type=first', async function () {
        db.doQuery.resolves([{ block_index: 1 }]);
        const result = await db.getBlockIndex.call(db, 'decoder', 'first');
        assert.strictEqual(db.doQuery.callCount, 1);
        assert.strictEqual(result, 1);
    });

    it('calls doQuery when component=indexer and type=last', async function () {
        db.doQuery.resolves([{ block_index: 500 }]);
        const result = await db.getBlockIndex.call(db, 'indexer', 'last');
        assert.strictEqual(db.doQuery.callCount, 1);
        assert.strictEqual(result, 500);
    });

    it('returns null when doQuery returns empty array for first/last', async function () {
        db.doQuery.resolves([]);
        const result = await db.getBlockIndex.call(db, 'decoder', 'last');
        assert.strictEqual(result, null);
    });

    it('returns null when block_index column is null for first/last', async function () {
        db.doQuery.resolves([{ block_index: null }]);
        const result = await db.getBlockIndex.call(db, 'indexer', 'first');
        assert.strictEqual(result, null);
    });

    it('accepts all three valid types without returning null early', async function () {
        for (const type of ['first', 'last', 'reorg']) {
            db.doQuery.reset();
            db.doQuery.resolves([]);
            const result = await db.getBlockIndex.call(db, 'decoder', type);
            // Should reach doQuery (not return null from validation)
            assert.strictEqual(db.doQuery.callCount, 1, `type=${type} should call doQuery`);
        }
    });

    it('accepts both valid component values without returning null early', async function () {
        for (const component of ['decoder', 'indexer']) {
            db.doQuery.reset();
            db.doQuery.resolves([]);
            const result = await db.getBlockIndex.call(db, component, 'first');
            assert.strictEqual(db.doQuery.callCount, 1, `component=${component} should call doQuery`);
        }
    });
});
