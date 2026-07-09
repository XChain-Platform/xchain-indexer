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

    it('preserves a FILE action MIME string in TYPE', function () {
        // TYPE sits in NUMBER_FIELDS for LIST's numeric list type, but for
        // FILE it is the MIME string; numeric-normalizing it nulled every
        // stored MIME type (files.type_id was always NULL).
        const data = { ACTION: 'FILE', TYPE: 'application/json' };
        const out  = normalize(data);
        assert.strictEqual(out.TYPE, 'application/json');
    });

    it('still numeric-normalizes TYPE for LIST actions', function () {
        const valid   = normalize({ ACTION: 'LIST', TYPE: '2' });
        assert.strictEqual(valid.TYPE, '2');
        const invalid = normalize({ ACTION: 'LIST', TYPE: 'image/png' });
        assert.strictEqual(invalid.TYPE, null);
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
        // ENCRYPTION_METHOD is in NUMBER_FIELDS: kept as-is if numeric, nullified otherwise.
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

    it('returns a copy and never mutates the caller object', function () {
        // AIRDROP's multi-tick loop reuses one `data` across ticks; in-place
        // stringification of TX_OUTPUTS broke fee detection for tick 2+, so
        // normalizeDataValues now operates on a shallow copy.
        const outputs = [{ address: 'addr1', amount: 1 }];
        const data = { AMOUNT: '50', TX_OUTPUTS: outputs };
        const out  = normalize(data);
        assert.notStrictEqual(out, data);
        assert.strictEqual(data.TX_OUTPUTS, outputs);          // caller's array untouched
        assert.strictEqual(typeof out.TX_OUTPUTS, 'string');   // copy got the stringified form
        assert.strictEqual(out.AMOUNT, '50');
    });
});

// ---------------------------------------------------------------------------
// describe: getBlockIndex (input validation only, mocked doQuery)
// ---------------------------------------------------------------------------
describe('Database.getBlockIndex() input validation @regression @tier1', function () {
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
            // createReorg writes its marker via doQueryStrict (throw-on-fault) so a swallowed
            // INSERT failure can't leave the processed-reorg cursor un-advanced.
            doQueryStrict: sinon.stub().resolves([]),
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

// ---------------------------------------------------------------------------
// describe: getBlockIndex (decoder reorg parsing, mocked doQuery)
//
// The decoder stores REORG events as a JSON-serialised array of
// {block_index, block_hash} objects. getBlockIndex('decoder','reorg') must
// unwrap the numeric block_index from each element and return the lowest one
// as a number, not the raw object. A regression here breaks the rollback
// trigger check, so rollbacks silently never fire.
// ---------------------------------------------------------------------------
describe('Database.getBlockIndex() decoder reorg parsing @regression @tier1', function () {
    let db;

    beforeEach(function () {
        const config = getTestConfig();
        const util   = new Utility();
        sinon.stub(util, 'logError');
        db = {
            config,
            util,
            doQuery: sinon.stub().resolves([]),
            // createReorg writes its marker via doQueryStrict (throw-on-fault) so a swallowed
            // INSERT failure can't leave the processed-reorg cursor un-advanced.
            doQueryStrict: sinon.stub().resolves([]),
            getBlockIndex: Database.prototype.getBlockIndex,
        };
    });

    afterEach(function () {
        sinon.restore();
    });

    it('returns a number (not an object) for the object-array format', async function () {
        const events = [{ block_index: 120, block_hash: 'abc123' }];
        db.doQuery.resolves([{ data: JSON.stringify(events) }]);
        const result = await db.getBlockIndex.call(db, 'decoder', 'reorg');
        assert.strictEqual(typeof result, 'number');
        assert.strictEqual(result, 120);
    });

    it('returns the lowest block_index across multiple orphaned blocks', async function () {
        const events = [
            { block_index: 122, block_hash: 'h122' },
            { block_index: 120, block_hash: 'h120' },
            { block_index: 121, block_hash: 'h121' },
        ];
        db.doQuery.resolves([{ data: JSON.stringify(events) }]);
        const result = await db.getBlockIndex.call(db, 'decoder', 'reorg');
        assert.strictEqual(result, 120);
    });

    it('produces a value that compares numerically (rollback trigger fires)', async function () {
        const events = [{ block_index: 120, block_hash: 'abc' }];
        db.doQuery.resolves([{ data: JSON.stringify(events) }]);
        const lastDecoderReorgBlock = await db.getBlockIndex.call(db, 'decoder', 'reorg');
        const lastIndexerBlock = 130;
        // This is the upstream rollback guard; it must evaluate true here.
        assert.strictEqual(lastIndexerBlock >= lastDecoderReorgBlock, true);
    });

    it('returns null when there are no reorg events', async function () {
        db.doQuery.resolves([]);
        const result = await db.getBlockIndex.call(db, 'decoder', 'reorg');
        assert.strictEqual(result, null);
    });
});

// ---------------------------------------------------------------------------
// describe: reorg detection by event IDENTITY (not block-height magnitude)
//
// Regression for the consecutive-reorg miss: comparing reorg block heights
// (`lastDecoderReorgBlock < lastIndexerReorgBlock`) silently drops every reorg
// after the first, because block heights increase. Detection must instead match
// the decoder's reorg events.id (identity). These guard the three pieces the
// indexer composes: getLatestReorg (decoder id+block), createReorg (persists the
// decoder id), getLastProcessedReorgId (reads it back).
// ---------------------------------------------------------------------------
describe('Database reorg identity detection @regression @tier1', function () {
    let db;

    beforeEach(function () {
        const config = getTestConfig();
        const util   = new Utility();
        sinon.stub(util, 'logError');
        db = {
            config,
            util,
            doQuery: sinon.stub().resolves([]),
            // createReorg writes its marker via doQueryStrict (throw-on-fault) so a swallowed
            // INSERT failure can't leave the processed-reorg cursor un-advanced.
            doQueryStrict: sinon.stub().resolves([]),
            getLatestReorg:         Database.prototype.getLatestReorg,
            getReorgsSince:         Database.prototype.getReorgsSince,
            getLastProcessedReorgId: Database.prototype.getLastProcessedReorgId,
            createReorg:            Database.prototype.createReorg,
        };
    });

    afterEach(function () {
        sinon.restore();
    });

    it('getLatestReorg returns {id, block_index} with the lowest orphaned block', async function () {
        const events = [
            { block_index: 202, block_hash: 'h202' },
            { block_index: 200, block_hash: 'h200' },
        ];
        db.doQuery.resolves([{ id: 7, data: JSON.stringify(events) }]);
        const result = await db.getLatestReorg.call(db);
        assert.deepStrictEqual(result, { id: 7, block_index: 200 });
    });

    it('getLatestReorg returns null when there are no reorg events', async function () {
        db.doQuery.resolves([]);
        assert.strictEqual(await db.getLatestReorg.call(db), null);
    });

    it('createReorg persists both block_index and decoder_event_id as JSON', async function () {
        await db.createReorg.call(db, 200, 7);
        // createReorg writes via doQueryStrict (throw-on-fault marker write).
        const args = db.doQueryStrict.firstCall.args[1];
        assert.deepStrictEqual(JSON.parse(args[0]), { block_index: 200, decoder_event_id: 7 });
    });

    it('getLastProcessedReorgId reads back the persisted decoder event id', async function () {
        db.doQuery.resolves([{ data: JSON.stringify({ block_index: 200, decoder_event_id: 7 }) }]);
        assert.strictEqual(await db.getLastProcessedReorgId.call(db), 7);
    });

    it('getLastProcessedReorgId returns null for legacy bare-number rows', async function () {
        db.doQuery.resolves([{ data: '100' }]);
        assert.strictEqual(await db.getLastProcessedReorgId.call(db), null);
    });

    it('detects a SECOND, higher-block reorg that a magnitude compare would miss', async function () {
        // Indexer already recorded the first reorg (block 100, decoder event id 5).
        const indexerDb = {
            config: db.config, util: db.util,
            doQuery: sinon.stub().resolves([{ data: JSON.stringify({ block_index: 100, decoder_event_id: 5 }) }]),
            getLastProcessedReorgId: Database.prototype.getLastProcessedReorgId,
        };
        // Decoder now reports a newer reorg at the HIGHER block 200 (event id 6).
        const decoderDb = {
            config: db.config, util: db.util,
            doQuery: sinon.stub().resolves([{ id: 6, data: JSON.stringify([{ block_index: 200, block_hash: 'h200' }]) }]),
            getLatestReorg: Database.prototype.getLatestReorg,
        };
        const decoderReorg         = await decoderDb.getLatestReorg.call(decoderDb);
        const lastProcessedReorgId = await indexerDb.getLastProcessedReorgId.call(indexerDb);

        // The buggy magnitude check (200 < 100) was false → miss. Identity catches it.
        assert.strictEqual(decoderReorg.block_index < lastProcessedReorgId, false, 'magnitude compare would have missed it');
        assert.strictEqual(decoderReorg.id !== lastProcessedReorgId, true, 'identity check detects the new reorg');
    });

    it('getReorgsSince returns every reorg after the given id, oldest first, each with its lowest block', async function () {
        db.doQuery.resolves([
            { id: 6, data: JSON.stringify([{ block_index: 200, block_hash: 'h200' }]) },
            { id: 7, data: JSON.stringify([{ block_index: 150, block_hash: 'h150' }, { block_index: 152, block_hash: 'h152' }]) },
        ]);
        const result = await db.getReorgsSince.call(db, 5);
        assert.deepStrictEqual(result, [
            { id: 6, block_index: 200 },
            { id: 7, block_index: 150 },
        ]);
        // The query must filter by id > afterId, not return only the latest.
        assert.match(db.doQuery.firstCall.args[0], /id > \?/);
        assert.deepStrictEqual(db.doQuery.firstCall.args[1], [5]);
    });

    it('getReorgsSince(null) returns all reorg events (no afterId filter)', async function () {
        db.doQuery.resolves([{ id: 1, data: JSON.stringify([{ block_index: 10, block_hash: 'h10' }]) }]);
        const result = await db.getReorgsSince.call(db, null);
        assert.deepStrictEqual(result, [{ id: 1, block_index: 10 }]);
        assert.doesNotMatch(db.doQuery.firstCall.args[0], /id > \?/);
    });

    it('exposes the DEEPEST block across two unprocessed reorgs when the newer one is shallower', async function () {
        // The bug: getLatestReorg returns only event 7 (block 200); rolling back to 200
        // leaves orphaned rows from event 6's deeper reorg at block 100. getReorgsSince
        // surfaces both so the caller can roll back to the minimum (deepest) block.
        db.doQuery.resolves([
            { id: 6, data: JSON.stringify([{ block_index: 100, block_hash: 'h100' }]) },
            { id: 7, data: JSON.stringify([{ block_index: 200, block_hash: 'h200' }]) },
        ]);
        const reorgs = await db.getReorgsSince.call(db, 5);
        const minBlock = reorgs.reduce((m, r) => (m === null || r.block_index < m ? r.block_index : m), null);
        assert.strictEqual(minBlock, 100, 'deepest block across all unprocessed reorgs');
        const maxId = reorgs.reduce((m, r) => Math.max(m, r.id), 0);
        assert.strictEqual(maxId, 7, 'cursor advances to the newest decoder event id');
    });
});

// ---------------------------------------------------------------------------
// describe: getValidatorsByCapability (MIN_STAKE threshold source)
// ---------------------------------------------------------------------------
// Regression guard: the validator-set snapshot must filter by the caller-supplied
// threshold (the hub's authoritative MIN_STAKE) VERBATIM when one is provided, and
// only fall back to this indexer's local config when it is absent. The local floor
// must NEVER clamp an explicit caller value: if it did, two hubs pointing at
// differently-configured indexers would compute different validator sets for the
// same block and break PBFT quorum determinism. Anti-inflation lives at the hub +
// on-chain-validation layers, not in this read path.
describe('Database.getValidatorsByCapability() threshold source @regression @tier1', function () {
    let db;

    beforeEach(function () {
        const config = getTestConfig();
        config.STAKING = { CAPABILITIES: { attestation: { MIN_STAKE: '10000' } } };
        db = {
            config,
            getValidatorsByCapability: Database.prototype.getValidatorsByCapability,
            _effectiveCapabilitySetSql: Database.prototype._effectiveCapabilitySetSql,
            getStatusId: sinon.stub().resolves(1),
            doQuery:     sinon.stub().resolves([]),
            // The caller value is honoured verbatim (no clamp), so util.bcgte is
            // not exercised on the threshold-resolution path. Stubbed for parity.
            util: { bcgte: sinon.stub().callsFake((a, b) => parseFloat(a) >= parseFloat(b)) },
        };
    });

    // The effective-set union binds the HAVING threshold twice: once for the
    // stake-key branch (arg 6) and once for the delegated-key source-aggregate
    // branch (arg 10). Both MUST carry the same resolved threshold. (Indices 6/10,
    // not 5/9: WI-2 bump 2 inserted a slash-exclusion blockIndex arg in each branch.)
    function thresholdArgs() {
        const a = db.doQuery.firstCall.args[1];
        return [a[6], a[10]];
    }

    it('uses the caller-supplied override over local config', async function () {
        await db.getValidatorsByCapability.call(db, 'attestation', 100, '25000');
        assert.deepStrictEqual(thresholdArgs(), ['25000', '25000']);
    });

    it('coerces a numeric override to a string', async function () {
        await db.getValidatorsByCapability.call(db, 'attestation', 100, 25000);
        assert.deepStrictEqual(thresholdArgs(), ['25000', '25000']);
    });

    it('falls back to local config when no override is supplied', async function () {
        await db.getValidatorsByCapability.call(db, 'attestation', 100);
        assert.deepStrictEqual(thresholdArgs(), ['10000', '10000']);
    });

    it('treats a 0 override as a real threshold (not a falsy fallback)', async function () {
        // 0 is an explicit caller value and is honoured VERBATIM (no clamp to the
        // local floor). This matches getStakeWeightsByCapability, so both the count
        // and weight paths resolve the identical qualifying set; cross-indexer
        // determinism is preserved because no path reads this indexer's local floor
        // when the hub passes an explicit threshold.
        await db.getValidatorsByCapability.call(db, 'attestation', 100, 0);
        assert.deepStrictEqual(thresholdArgs(), ['0', '0']);
    });
});

// ---------------------------------------------------------------------------
// describe: getActiveCapabilityCount / hasCapability (threshold source)
// ---------------------------------------------------------------------------
// Companions to getValidatorsByCapability: both expose the same optional
// caller-supplied MIN_STAKE override (falling back to local config when absent)
// so the API is symmetric and a future hub caller can drive the threshold the
// same way the validator-set snapshot already does. Current internal callers
// (price/attest block processing) omit the override and keep using local config.
describe('Database.getActiveCapabilityCount() threshold source @regression @tier1', function () {
    let db;

    beforeEach(function () {
        const config = getTestConfig();
        config.STAKING = { CAPABILITIES: { attestation: { MIN_STAKE: '10000' } } };
        db = {
            config,
            getActiveCapabilityCount: Database.prototype.getActiveCapabilityCount,
            _effectiveCapabilitySetSql: Database.prototype._effectiveCapabilitySetSql,
            getStatusId: sinon.stub().resolves(1),
            getLatestBlockIndex: sinon.stub().resolves(100),
            doQuery:     sinon.stub().resolves([{ cnt: 0 }]),
            // The caller value is honoured verbatim (no clamp); util.bcgte stubbed
            // for parity but not exercised on the threshold-resolution path.
            util: { bcgte: sinon.stub().callsFake((a, b) => parseFloat(a) >= parseFloat(b)) },
        };
    });

    // Same effective-set union as getValidatorsByCapability: the threshold
    // binds at args 6 (stake-key branch) and 10 (delegated-key branch). (Shifted
    // from 5/9 by the WI-2 bump 2 slash-exclusion blockIndex arg in each branch.)
    function thresholdArgs() {
        const a = db.doQuery.firstCall.args[1];
        return [a[6], a[10]];
    }

    it('uses the caller-supplied override over local config', async function () {
        await db.getActiveCapabilityCount.call(db, 'attestation', 100, '25000');
        assert.deepStrictEqual(thresholdArgs(), ['25000', '25000']);
    });

    it('falls back to local config when no override is supplied', async function () {
        await db.getActiveCapabilityCount.call(db, 'attestation', 100);
        assert.deepStrictEqual(thresholdArgs(), ['10000', '10000']);
    });

    it('treats a 0 override as a real threshold (not a falsy fallback)', async function () {
        // 0 is an explicit caller value, honoured VERBATIM (no clamp to the local
        // floor) so this count matches the set membership every other indexer resolves.
        await db.getActiveCapabilityCount.call(db, 'attestation', 100, 0);
        assert.deepStrictEqual(thresholdArgs(), ['0', '0']);
    });

    it('counts over the SAME effective-set SQL as getValidatorsByCapability (quorum agreement)', async function () {
        await db.getActiveCapabilityCount.call(db, 'attestation', 100);
        const sql = db.doQuery.firstCall.args[0];
        assert.ok(sql.includes('COUNT(DISTINCT pubkey)'));
        assert.ok(sql.includes('stake_key_revocations'));   // revoked stake keys excluded
        assert.ok(sql.includes('delegations'));             // delegated keys included
    });
});

describe('Database.hasCapability() threshold source @regression @tier1', function () {
    let db;

    beforeEach(function () {
        const config = getTestConfig();
        config.STAKING = { CAPABILITIES: { attestation: { MIN_STAKE: '10000' } } };
        db = {
            config,
            hasCapability:       Database.prototype.hasCapability,
            getStatusId:         sinon.stub().resolves(1),
            getPubkeyId:         sinon.stub().resolves(3),
            getLatestBlockIndex: sinon.stub().resolves(100),
            // Not slashed (WI-2 bump 2 permanent-disqualification guard): stubbed so the
            // threshold-source assertions exercise the stake/delegated branches; the
            // disqualification path has its own dedicated coverage.
            _isPubkeySlashedAt:  sinon.stub().resolves(false),
            // Stake-key branch resolves a per-pubkey aggregate of 15000
            doQuery:             sinon.stub().resolves([{ total: '15000' }]),
            // The caller value is honoured verbatim (no clamp); util.bcgte is used
            // only for the stake comparison bcgte(total, minStake).
            util:                { bcgte: sinon.stub().callsFake((a, b) => parseFloat(a) >= parseFloat(b)) },
        };
    });

    // hasCapability resolves the threshold, then calls util.bcgte(total, minStake)
    // for each branch (stake key, then delegated key). The threshold is honoured
    // verbatim, so bcgte's second arg is the resolved minStake; lastCall reads the
    // threshold used in the actual stake comparison regardless of call count.
    function thresholdArg() {
        return db.util.bcgte.lastCall.args[1];
    }

    it('uses the caller-supplied override over local config', async function () {
        await db.hasCapability.call(db, 'pk', 'attestation', 100, '25000');
        assert.strictEqual(thresholdArg(), '25000');
    });

    it('coerces a numeric override to a string', async function () {
        await db.hasCapability.call(db, 'pk', 'attestation', 100, 25000);
        assert.strictEqual(thresholdArg(), '25000');
    });

    it('falls back to local config when no override is supplied', async function () {
        await db.hasCapability.call(db, 'pk', 'attestation', 100);
        assert.strictEqual(thresholdArg(), '10000');
    });

    it('treats a 0 override as a real threshold (not a falsy fallback)', async function () {
        // 0 is an explicit caller value, honoured VERBATIM (no clamp to the local
        // floor) so this per-pubkey test agrees with the qualifying set resolved
        // by every other indexer for the block.
        await db.hasCapability.call(db, 'pk', 'attestation', 100, 0);
        assert.strictEqual(thresholdArg(), '0');
    });

    it('falls through to the delegated-key branch when the stake branch misses', async function () {
        // Stake branch: no rows. Delegation branch: source aggregate 15000.
        db.doQuery.onFirstCall().resolves([{ total: null }]);
        db.doQuery.onSecondCall().resolves([{ total: '15000' }]);
        db.util.bcgte.returns(true);
        const ok = await db.hasCapability.call(db, 'pk', 'attestation', 100);
        assert.strictEqual(ok, true);
        assert.strictEqual(db.doQuery.callCount, 2);
        assert.ok(db.doQuery.secondCall.args[0].includes('delegations'));
    });

    it('returns false when neither branch qualifies', async function () {
        db.doQuery.resolves([{ total: null }]);
        const ok = await db.hasCapability.call(db, 'pk', 'attestation', 100);
        assert.strictEqual(ok, false);
    });
});

// ---------------------------------------------------------------------------
// describe: isCapabilityConfigured (config-drift signal for the hub RPC)
// ---------------------------------------------------------------------------
// The getcapabilityvalidators RPC uses this to distinguish a capability this
// indexer doesn't know about (config drift during a rollout) from one that
// simply has no qualified validators. Both used to return an empty set, so a
// misconfigured capability silently dropped all its attestation work.
describe('Database.isCapabilityConfigured() @regression @tier1', function () {
    function dbWith(caps) {
        const config = getTestConfig();
        config.STAKING = caps === undefined ? {} : { CAPABILITIES: caps };
        return { config, isCapabilityConfigured: Database.prototype.isCapabilityConfigured };
    }

    it('returns true for a configured capability', function () {
        const db = dbWith({ attestation: { MIN_STAKE: '10000' } });
        assert.strictEqual(db.isCapabilityConfigured.call(db, 'attestation'), true);
    });

    it('returns false for a capability absent from the config', function () {
        const db = dbWith({ attestation: { MIN_STAKE: '10000' } });
        assert.strictEqual(db.isCapabilityConfigured.call(db, 'oracle_publish'), false);
    });

    it('returns false when STAKING.CAPABILITIES is missing entirely', function () {
        const db = dbWith(undefined);
        assert.strictEqual(db.isCapabilityConfigured.call(db, 'attestation'), false);
    });
});

// ---------------------------------------------------------------------------
// describe: getContractState (adversarial state keys like __proto__ must
// round-trip faithfully into the VM's initialState. A plain {} would route
// state['__proto__'] = value through the __proto__ setter (no-op for strings,
// prototype reassignment for objects), silently losing the key on reload.
// Regression guard for the Object.create(null) fix in src/db.js.
// ---------------------------------------------------------------------------
describe('Database.getContractState() adversarial keys @regression @tier1', function () {
    let db;

    function makeDb(rows) {
        return {
            doQuery: sinon.stub().resolves(rows),
            getContractState: Database.prototype.getContractState,
        };
    }

    // Values are stored JSON-serialized (createContractState writes JSON.stringify(value)).
    const row = (k, v) => ({ state_key: k, state_value: JSON.stringify(v) });

    it('returns a null-prototype object (no inherited Object.prototype)', async function () {
        db = makeDb([row('owner', 'addr1')]);
        const state = await db.getContractState.call(db, 1);
        assert.strictEqual(Object.getPrototypeOf(state), null,
            'state object must have a null prototype so adversarial keys are own data properties');
    });

    it('round-trips a "__proto__" string key as an own property (not the proto setter)', async function () {
        db = makeDb([row('__proto__', 'secret-balance'), row('owner', 'addr1')]);
        const state = await db.getContractState.call(db, 1);
        assert.ok(Object.prototype.hasOwnProperty.call(state, '__proto__'),
            '__proto__ must be a genuine own property');
        assert.strictEqual(state['__proto__'], 'secret-balance',
            '__proto__ value must survive the reload (this is what regressed with a plain {})');
        assert.strictEqual(state.owner, 'addr1');
    });

    it('round-trips a "__proto__" OBJECT key without reassigning the prototype', async function () {
        db = makeDb([row('__proto__', { nested: true })]);
        const state = await db.getContractState.call(db, 1);
        // With a plain {}, state['__proto__'] = {nested:true} would set the
        // object's [[Prototype]] instead of an own key, corrupting the state.
        assert.strictEqual(Object.getPrototypeOf(state), null,
            'assigning an object to __proto__ must NOT reassign the prototype');
        assert.deepStrictEqual(state['__proto__'], { nested: true });
    });

    it('round-trips a "constructor" key', async function () {
        db = makeDb([row('constructor', 'C')]);
        const state = await db.getContractState.call(db, 1);
        assert.strictEqual(state['constructor'], 'C');
    });

    it('falls back to the raw string when state_value is not valid JSON', async function () {
        db = makeDb([{ state_key: 'legacy', state_value: 'not-json' }]);
        const state = await db.getContractState.call(db, 1);
        assert.strictEqual(state.legacy, 'not-json');
    });
});
