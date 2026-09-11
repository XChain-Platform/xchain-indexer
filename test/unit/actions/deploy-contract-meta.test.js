// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// AT2: every verdict row of CONTRACT_META_REQUIRED driven through the real DEPLOY
// handler, plus the storage half (which META_* values reach createContract) and the
// below-flag-day half (today's verdicts, byte for byte, and the columns still filled
// for a conforming value). The grammar itself is unit-tested in
// test/unit/contract-meta-text.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const { getTestConfig } = require('../../fixtures/config');

const Deploy       = require('../../../src/actions/deploy.js');
const contractMeta = require('../../../src/contract_meta.js');
const V            = contractMeta.VERDICTS;

const VALID_CODE     = 'module.exports = { run: function() { return 1; } };';
const VALID_CODE_B64 = Buffer.from(VALID_CODE, 'utf8').toString('base64');

const GOOD_META = { name: 'Escrow', description: 'Two-party escrow with an arbiter', version: '1.0.0' };

// Mirror of the xchain-vm CONTRACT_WRAPPER meta report (seam S1): the isolate decides
// metaType, serialises inside the isolate, and caps at 4096 UTF-16 code units.
function metaReportFor(meta) {
    if (meta === undefined)
        return { metaType: 'undefined', metaJson: null, metaError: false, metaOversize: false };
    const metaType = meta === null ? 'null' : (Array.isArray(meta) ? 'array' : typeof meta);
    if (metaType !== 'object')
        return { metaType, metaJson: null, metaError: false, metaOversize: false };
    let json = null, metaError = false, metaOversize = false;
    try { json = JSON.stringify(meta); } catch (e) { metaError = true; }
    if (json !== null && json.length > 4096) { metaOversize = true; json = null; }
    if (json !== null && json.charAt(0) !== '{') { metaError = true; json = null; }
    return { metaType, metaJson: json, metaError, metaOversize };
}

function manifestFor(meta, overrides = {}) {
    return Object.assign({
        permissions: null, permissionsType: 'undefined',
        maxTakeBps:  null, maxTakeBpsType:  'undefined',
        hasInitialize: false
    }, metaReportFor(meta), overrides);
}

describe('DEPLOY meta verdicts (CONTRACT_META_REQUIRED) @regression @tier1', function () {

    const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    let indexer, actionsCtx;

    function addDeployStubs(db) {
        db.createContract           = sinon.stub().resolves();
        db.createContractPermission = sinon.stub().resolves();
        db.deleteContract           = sinon.stub().resolves();
        db.createContractExecution  = sinon.stub().resolves();
        db.createContractState      = sinon.stub().resolves();
        db.createSavepoint          = sinon.stub().resolves('sp1');
        db.releaseSavepoint         = sinon.stub().resolves();
        db.rollbackToSavepoint      = sinon.stub().resolves();
        db.getOracleDataForVM       = sinon.stub().resolves({});
        db.getCrossChainDataForVM   = sinon.stub().resolves({});
        db.getPollResultsForVM      = sinon.stub().resolves({ polls: {} });
        db.getStatusString          = sinon.stub().resolves('valid');
    }

    function makeVm(read) {
        return {
            validateSyntax:     sinon.stub().returns({ valid: true }),
            checkFloatWarnings: sinon.stub().returns([]),
            readManifest:       sinon.stub().resolves(read),
            execute:            sinon.stub().resolves({
                success: true, gasUsed: 0, stateChanges: [], stateDeletes: [], emittedActions: []
            })
        };
    }

    // Drive one DEPLOY through the real handler with the given raw readManifest result.
    // metaEnabled=false models a block below the flag day.
    async function deployWith(read, metaEnabled = true) {
        const isEnabled = sinon.stub().resolves(true);
        if (!metaEnabled)
            isEnabled.withArgs('CONTRACT_META_REQUIRED', sinon.match.any).resolves(false);
        actionsCtx.protocolChanges = { isEnabled };
        actionsCtx.vm = makeVm(read);
        const handler = new Deploy(actionsCtx);
        const data = createBaseData({ ACTION: 'DEPLOY', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
        await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
        return { status: data['STATUS'], createContract: indexer.indexerDb.createContract };
    }

    // The common case: a successful read of a manifest carrying `meta`.
    function readOf(meta, overrides) {
        return { success: true, manifest: manifestFor(meta, overrides), error: null };
    }

    function metaArgs(stub) {
        assert.ok(stub.calledOnce, 'createContract must be called exactly once');
        const row = stub.firstCall.args[0];
        return {
            META_NAME: row.META_NAME, META_DESCRIPTION: row.META_DESCRIPTION,
            META_VERSION: row.META_VERSION, META_JSON: row.META_JSON
        };
    }

    beforeEach(function () {
        const config = getTestConfig();
        config['GAS_PRICE'] = '0';
        indexer = createMockIndexer({ config });
        addDeployStubs(indexer.indexerDb);
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
        actionsCtx = {
            config: indexer.config, util: indexer.util, mapper: indexer.mapper,
            decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb,
            protocolChanges: { isEnabled: sinon.stub().resolves(true) },
            vm: makeVm(readOf(GOOD_META))
        };
        indexer.util.resetLists();
    });

    afterEach(function () { sinon.restore(); });

    describe('the seven verdict rows, at/after the flag day', function () {

        it('row 1: a module-level throw (success:false) is (manifest read failed), NOT a nameless valid', async function () {
            // The bypass this rule exists to close: below the flag day a throwing contract
            // deploys 'valid' because the whole verdict block sits inside success && manifest.
            const { status } = await deployWith({ success: false, manifest: null, error: 'ReferenceError: boom' });
            assert.strictEqual(status, V.READ_FAILED);
        });

        it('row 1: an unparseable report (manifest null) is (manifest read failed)', async function () {
            const { status } = await deployWith({ success: true, manifest: null, error: null });
            assert.strictEqual(status, V.READ_FAILED);
        });

        it('row 2: no meta export is (meta required)', async function () {
            const { status } = await deployWith(readOf(undefined));
            assert.strictEqual(status, V.REQUIRED);
        });

        it('row 3: meta null is (meta must be a plain object)', async function () {
            const { status } = await deployWith(readOf(null));
            assert.strictEqual(status, V.NOT_OBJECT);
        });

        it('row 3: meta as an array is (meta must be a plain object)', async function () {
            const { status } = await deployWith(readOf(['Escrow']));
            assert.strictEqual(status, V.NOT_OBJECT);
        });

        it('row 3: a Date serialises to a non-object and is (meta must be a plain object)', async function () {
            const read = readOf(new Date('2026-09-08T00:00:00Z'));
            assert.strictEqual(read.manifest.metaError, true, 'the wrapper mirror must flag a Date');
            const { status } = await deployWith(read);
            assert.strictEqual(status, V.NOT_OBJECT);
        });

        it('row 3: a circular meta cannot be serialised and is (meta must be a plain object)', async function () {
            const circular = { name: 'Escrow', description: 'Circular' };
            circular.self = circular;
            const read = readOf(circular);
            assert.strictEqual(read.manifest.metaError, true, 'the wrapper mirror must flag a circular meta');
            assert.strictEqual(read.manifest.metaJson, null);
            const { status } = await deployWith(read);
            assert.strictEqual(status, V.NOT_OBJECT);
        });

        it('row 4: a 5000-character meta is (meta exceeds 4096 characters)', async function () {
            const read = readOf({ name: 'Escrow', description: 'Big', filler: 'x'.repeat(5000) });
            assert.strictEqual(read.manifest.metaOversize, true);
            assert.ok(JSON.stringify({ name: 'Escrow', description: 'Big', filler: 'x'.repeat(5000) }).length > 5000);
            const { status } = await deployWith(read);
            assert.strictEqual(status, V.OVERSIZE);
        });

        it('row 5: a name carrying U+202E (bidi override) is the name string', async function () {
            const { status } = await deployWith(readOf({ name: 'Esc\u202Erow', description: 'Bidi' }));
            assert.strictEqual(status, V.NAME);
        });

        it('row 5: a name carrying a lone surrogate is the name string', async function () {
            const json = JSON.stringify({ name: 'Escrow\uD800', description: 'Lone surrogate' });
            assert.strictEqual(JSON.parse(json).name.isWellFormed(), false);
            const { status } = await deployWith(readOf(undefined, { metaType: 'object', metaJson: json }));
            assert.strictEqual(status, V.NAME);
        });

        it('row 5: a name with a leading U+00A0 is the name string (untrimmed, and trim() is never used)', async function () {
            const { status } = await deployWith(readOf({ name: '\u00A0Escrow', description: 'Leading NBSP' }));
            assert.strictEqual(status, V.NAME);
        });

        it('row 6: a description with a LEADING LF is the description string', async function () {
            const { status } = await deployWith(readOf({ name: 'Escrow', description: '\nLeading LF' }));
            assert.strictEqual(status, V.DESCRIPTION);
        });

        it('row 6: a description with an INTERIOR LF deploys valid and stores the bytes unchanged', async function () {
            const meta = { name: 'Escrow', description: 'line one\nline two', version: '1.0.0' };
            const { status, createContract } = await deployWith(readOf(meta));
            assert.strictEqual(status, 'valid');
            assert.strictEqual(metaArgs(createContract).META_DESCRIPTION, 'line one\nline two');
        });

        it("row 7: version '' is the version string", async function () {
            const { status } = await deployWith(readOf({ name: 'Escrow', description: 'Escrow', version: '' }));
            assert.strictEqual(status, V.VERSION);
        });

        it('row 7: version ABSENT deploys valid and stores a NULL meta_version', async function () {
            const { status, createContract } = await deployWith(readOf({ name: 'Escrow', description: 'Escrow' }));
            assert.strictEqual(status, 'valid');
            assert.strictEqual(metaArgs(createContract).META_VERSION, null);
            assert.strictEqual(metaArgs(createContract).META_NAME, 'Escrow');
        });

    });

    describe('verdict precedence', function () {

        it('a contract bad on permissions AND meta reports the PERMISSIONS string (meta is judged after)', async function () {
            const read = { success: true, error: null, manifest: manifestFor(undefined, {
                permissionsType: 'array', permissions: 'SEND'      // declared array, is a string
            }) };
            const { status } = await deployWith(read);
            assert.strictEqual(status, 'invalid: CONTRACT_MANIFEST (permissions must be an array)');
        });

        it('a contract bad on maxTakeBps AND meta reports the MAX_TAKE_BPS string', async function () {
            const read = { success: true, error: null, manifest: manifestFor(undefined, {
                maxTakeBpsType: 'number', maxTakeBps: 99999
            }) };
            const { status } = await deployWith(read);
            assert.strictEqual(status, 'invalid: CONTRACT_MANIFEST (maxTakeBps must be an integer in [0, 10000])');
        });

        it('a vector bad on TWO meta rows reports the EARLIER row (name before description)', async function () {
            const { status } = await deployWith(readOf({ name: '', description: '' }));
            assert.strictEqual(status, V.NAME);
        });

        it('a vector bad on the description AND the version reports the DESCRIPTION row', async function () {
            const { status } = await deployWith(readOf({ name: 'Escrow', description: '', version: '' }));
            assert.strictEqual(status, V.DESCRIPTION);
        });

        it('an oversize meta whose name is also bad reports the OVERSIZE row', async function () {
            const { status } = await deployWith(readOf({ name: '', description: 'x', filler: 'y'.repeat(5000) }));
            assert.strictEqual(status, V.OVERSIZE);
        });

    });

    describe('function-export contracts (R1)', function () {

        it('a function export WITHOUT f.meta reports metaType undefined and is (meta required)', async function () {
            // What a function export reports today: __ce is {} for a non-object, so nothing
            // is found. With the wrapper change, meta is read off the function itself.
            const { status } = await deployWith(readOf(undefined, { hasInitialize: true }));
            assert.strictEqual(status, V.REQUIRED);
        });

        it('a function export WITH f.meta reports metaType object and deploys valid with its columns', async function () {
            const meta = { name: 'Ping', description: 'Returns ok', version: '1.0.0' };
            const { status, createContract } = await deployWith(readOf(meta, { hasInitialize: false }));
            assert.strictEqual(status, 'valid');
            assert.deepStrictEqual(metaArgs(createContract), {
                META_NAME: 'Ping', META_DESCRIPTION: 'Returns ok', META_VERSION: '1.0.0',
                META_JSON: JSON.stringify(meta)
            });
        });

    });

    describe('what reaches createContract (seam S3)', function () {

        it('a valid deploy with conforming meta passes all four META_* keys', async function () {
            const { status, createContract } = await deployWith(readOf(GOOD_META));
            assert.strictEqual(status, 'valid');
            assert.deepStrictEqual(metaArgs(createContract), {
                META_NAME:        'Escrow',
                META_DESCRIPTION: 'Two-party escrow with an arbiter',
                META_VERSION:     '1.0.0',
                META_JSON:        JSON.stringify(GOOD_META)
            });
        });

        it('META_JSON is the isolate bytes verbatim, unknown keys and all', async function () {
            const meta = { name: 'Escrow', description: 'Escrow', author: 'nobody', nested: { a: 1 } };
            const { createContract } = await deployWith(readOf(meta));
            assert.strictEqual(metaArgs(createContract).META_JSON, JSON.stringify(meta));
        });

        it('an INVALID deploy writes four NULLs even though its row is still created', async function () {
            const { status, createContract } = await deployWith(readOf(undefined));
            assert.strictEqual(status, V.REQUIRED);
            assert.deepStrictEqual(metaArgs(createContract), {
                META_NAME: null, META_DESCRIPTION: null, META_VERSION: null, META_JSON: null
            });
        });

        it('a deploy rejected for a NON-meta reason writes four NULLs even when its meta conforms', async function () {
            const read = { success: true, error: null, manifest: manifestFor(GOOD_META, {
                permissionsType: 'array', permissions: 'SEND'
            }) };
            const { status, createContract } = await deployWith(read);
            assert.strictEqual(status, 'invalid: CONTRACT_MANIFEST (permissions must be an array)');
            assert.deepStrictEqual(metaArgs(createContract), {
                META_NAME: null, META_DESCRIPTION: null, META_VERSION: null, META_JSON: null
            });
        });

        it('a deploy whose CONSTRUCTOR fails writes four NULLs (status is not valid)', async function () {
            const isEnabled = sinon.stub().resolves(true);
            actionsCtx.protocolChanges = { isEnabled };
            const vm = makeVm(readOf(GOOD_META));
            vm.execute = sinon.stub().resolves({
                success: false, error: 'revert: bad init', gasUsed: 100,
                stateChanges: [], stateDeletes: [], emittedActions: []
            });
            actionsCtx.vm = vm;
            const handler = new Deploy(actionsCtx);
            const data = createBaseData({ ACTION: 'DEPLOY', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);
            assert.notStrictEqual(data['STATUS'], 'valid');
            assert.deepStrictEqual(metaArgs(indexer.indexerDb.createContract), {
                META_NAME: null, META_DESCRIPTION: null, META_VERSION: null, META_JSON: null
            });
        });

    });

    describe('BELOW the flag day', function () {

        const badVectors = [
            ['a module-level throw',       { success: false, manifest: null, error: 'boom' }],
            ['an unparseable report',      { success: true,  manifest: null, error: null }],
            ['no meta export',             readOf(undefined)],
            ['meta null',                  readOf(null)],
            ['meta as an array',           readOf(['x'])],
            ['a bidi name',                readOf({ name: 'Esc\u202Erow', description: 'Bidi' })],
            ["version ''",                 readOf({ name: 'Escrow', description: 'Escrow', version: '' })]
        ];

        for (const [label, read] of badVectors) {
            it(label + ' still deploys with TODAY\'s verdict (valid), so a from-genesis replay is unchanged', async function () {
                const { status } = await deployWith(read, false);
                assert.strictEqual(status, 'valid');
            });
        }

        it('a conforming meta is STILL handed to createContract below the flag day', async function () {
            const { status, createContract } = await deployWith(readOf(GOOD_META), false);
            assert.strictEqual(status, 'valid');
            assert.deepStrictEqual(metaArgs(createContract), {
                META_NAME:        'Escrow',
                META_DESCRIPTION: 'Two-party escrow with an arbiter',
                META_VERSION:     '1.0.0',
                META_JSON:        JSON.stringify(GOOD_META)
            });
        });

        it('a NON-conforming meta hands four NULLs below the flag day (it deploys valid, but stores nothing)', async function () {
            const { status, createContract } = await deployWith(readOf({ name: '\u00A0Escrow', description: 'Leading NBSP' }), false);
            assert.strictEqual(status, 'valid');
            assert.deepStrictEqual(metaArgs(createContract), {
                META_NAME: null, META_DESCRIPTION: null, META_VERSION: null, META_JSON: null
            });
        });

        it('an absent meta hands four NULLs below the flag day', async function () {
            const { status, createContract } = await deployWith(readOf(undefined), false);
            assert.strictEqual(status, 'valid');
            assert.deepStrictEqual(metaArgs(createContract), {
                META_NAME: null, META_DESCRIPTION: null, META_VERSION: null, META_JSON: null
            });
        });

        it('the gate is consulted by NAME: only CONTRACT_META_REQUIRED turns the verdict off', async function () {
            const isEnabled = sinon.stub().resolves(true);
            isEnabled.withArgs('CONTRACT_META_REQUIRED', sinon.match.any).resolves(false);
            actionsCtx.protocolChanges = { isEnabled };
            actionsCtx.vm = makeVm(readOf(undefined));
            const handler = new Deploy(actionsCtx);
            const data = createBaseData({ ACTION: 'DEPLOY', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(isEnabled.calledWith('CONTRACT_META_REQUIRED', 100),
                'the verdict must resolve the gate on THIS deploy\'s block index');
        });

    });

    describe('registration', function () {

        it('CONTRACT_META_REQUIRED is registered, genesis-active on mainnet and regtest and armed on testnet at 2026-09-13T00:00:00Z', function () {
            const ProtocolChanges = require('../../../src/protocol_changes.js');
            const TESTNET_ARM = 1789257600; // 2026-09-13T00:00:00Z, pinned by the v0.17.0 cut
            assert.strictEqual(ProtocolChanges.CONTRACT_META_REQUIRED_MAINNET_TIME, 0);
            assert.strictEqual(ProtocolChanges.CONTRACT_META_REQUIRED_TESTNET_TIME, TESTNET_ARM);
            assert.strictEqual(TESTNET_ARM, Date.UTC(2026, 8, 13) / 1000,
                'the armed instant is 00:00:00Z of the second day after the carrying release lands');

            const pc = new ProtocolChanges(createMockIndexer(), '0.2.0');
            const change = pc.changes['CONTRACT_META_REQUIRED'];
            assert.ok(change, 'CONTRACT_META_REQUIRED must be registered');
            assert.strictEqual(change.mainnet_time, 0);
            assert.strictEqual(change.testnet_time, TESTNET_ARM);
            assert.strictEqual(change.regtest_time, 0);
            assert.strictEqual(change.mainnet_block, 0);
            assert.strictEqual(change.testnet_block, 0);
            assert.strictEqual(change.regtest_block, 0);
        });

    });

});
