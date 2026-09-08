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
// Chunked DEPLOY: the v4 carrier handler (slice validation + storage) and the
// DEPLOY v2/v3 assembly branch (gather chunks → decode → sha256-verify → deploy).

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const { getTestConfig } = require('../../fixtures/config');

const Deploy      = require('../../../src/actions/deploy.js');
const DeployChunk = require('../../../src/actions/deploy_chunk.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const CODE   = 'module.exports = { run: function() { return 1; } };';

function sha256Hex(s){ return crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex'); }

// Split base64(code) into `n` ordered slices and shape them like getDeployChunksForAssembly rows.
function chunkRows(code, n, { source = SOURCE } = {}){
    const b64  = Buffer.from(code, 'utf8').toString('base64');
    const size = Math.ceil(b64.length / n);
    const rows = [];
    for(let i = 0; i < n; i++){
        rows.push({
            chunk_index:  i,
            total_chunks: n,
            code_part:    b64.slice(i * size, (i + 1) * size),
            action_index: 10 + i
        });
    }
    return rows;
}

describe('Chunked DEPLOY: v4 carrier handler @regression @tier2', function () {
    let indexer, ctx, handler;

    function deployChunkData(overrides = {}) {
        return createBaseData({ ACTION: 'DEPLOY', FORMAT: 4, SOURCE, BLOCK_INDEX: 100, ACTION_INDEX: 5, ...overrides });
    }

    beforeEach(function () {
        const config = getTestConfig();
        config['GAS_PRICE'] = '0'; // fee = 0 → skip balance check
        indexer = createMockIndexer({ config });
        indexer.indexerDb.recordDeployChunk = sinon.stub().resolves();
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
        // Pre-activation carrier behaviour: with DEPLOY_DEFERRED_ASSEMBLY off, a stored carrier
        // never looks for a pending assembler and can never deploy. The post-activation carrier
        // is driven in deploy_deferred.test.js.
        ctx = { config: indexer.config, util: indexer.util, mapper: indexer.mapper, decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb,
                protocolChanges: { isEnabled: sinon.stub().resolves(false) } };
        handler = new DeployChunk(ctx, new Deploy(ctx));
        indexer.util.resetLists();
    });
    afterEach(function () { sinon.restore(); });

    const HASH = sha256Hex(CODE);

    it('accepts and stores a valid chunk', async function () {
        const data = deployChunkData();
        await handler.parse(['4', HASH, '0', '3', 'aGVsbG8='], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.recordDeployChunk.calledOnce);
    });

    it('rejects a malformed CODE_HASH', async function () {
        const data = deployChunkData();
        await handler.parse(['4', 'NOTAHASH', '0', '3', 'aGVsbG8='], data, null);
        assert.ok(String(data['STATUS']).includes('CODE_HASH'));
    });

    it('rejects CHUNK_INDEX >= TOTAL_CHUNKS', async function () {
        const data = deployChunkData();
        await handler.parse(['4', HASH, '3', '3', 'aGVsbG8='], data, null);
        assert.ok(String(data['STATUS']).includes('CHUNK_INDEX'));
    });

    it('rejects TOTAL_CHUNKS over the cap', async function () {
        const data = deployChunkData();
        await handler.parse(['4', HASH, '0', '999', 'aGVsbG8='], data, null);
        assert.ok(String(data['STATUS']).includes('TOTAL_CHUNKS'));
    });

    it('rejects a non-base64 CODE_PART', async function () {
        const data = deployChunkData();
        await handler.parse(['4', HASH, '0', '3', 'not base64!|'], data, null);
        assert.ok(String(data['STATUS']).includes('CODE_PART'));
    });
});

// assembleCode is the ONE primitive both R1 (a carrier completing its own group at C, bound
// C + 1) and R2 (an assembler landing pending/invalid, bound its own action_index) call, so
// its `incomplete` flag - the switch between a repairable landing and a terminal one - and its
// `beforeActionIndex` bound are pinned directly here rather than only indirectly through the
// full parse() pipeline in deploy_deferred.test.js.
describe('DeployChunk.assembleCode: the incomplete flag and the assembly bound @regression @tier2', function () {

    function makeHandler(rows) {
        const config  = getTestConfig();
        const indexer = createMockIndexer({ config });
        indexer.indexerDb.getDeployChunksForAssembly = sinon.stub().callsFake(async (src, hash, before) =>
            rows.filter(r => Number(r.action_index) < Number(before)));
        const ctx = { config: indexer.config, util: indexer.util, mapper: indexer.mapper, decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb };
        return new DeployChunk(ctx, null);   // no owning Deploy needed: assembleCode alone is under test
    }

    const HASH = sha256Hex(CODE);

    it('is incomplete (repairable) with no chunks recorded at all', async function () {
        const handler = makeHandler([]);
        const result = await handler.assembleCode(SOURCE, HASH, 1000);
        assert.strictEqual(result.error, 'invalid: CODE_HASH (no chunks)');
        assert.strictEqual(result.incomplete, true);
    });

    it('is incomplete (repairable) when a middle position is missing', async function () {
        const rows = chunkRows(CODE, 3).filter(r => r.chunk_index !== 1);
        const handler = makeHandler(rows);
        const result = await handler.assembleCode(SOURCE, HASH, 1000);
        assert.strictEqual(result.error, 'invalid: CODE_HASH (missing chunk 1)');
        assert.strictEqual(result.incomplete, true);
    });

    it('is terminal (not repairable) when the assembled bytes do not match the declared hash', async function () {
        const handler = makeHandler(chunkRows(CODE, 2));
        const wrongHash = sha256Hex(CODE + ' // tampered');
        const result = await handler.assembleCode(SOURCE, wrongHash, 1000);
        assert.strictEqual(result.error, 'invalid: CODE_HASH (assembly mismatch)');
        assert.strictEqual(result.incomplete, false);
    });

    it('is terminal (not repairable) on a malformed CODE_HASH', async function () {
        const handler = makeHandler([]);
        const result = await handler.assembleCode(SOURCE, 'NOTAHASH', 1000);
        assert.strictEqual(result.error, 'invalid: CODE_HASH (format)');
        assert.strictEqual(result.incomplete, false);
    });

    it('the bound excludes a row at or above it and includes everything below (R1s C + 1)', async function () {
        const rows = chunkRows(CODE, 2);   // rows at action_index 10 (pos 0) and 11 (pos 1)
        const handler = makeHandler(rows);
        // Bound = 11 excludes the position-1 row filed AT 11: the group still reads incomplete.
        let result = await handler.assembleCode(SOURCE, HASH, 11);
        assert.strictEqual(result.incomplete, true);
        // Bound = 12 (C + 1 for a completing carrier at C = 11) includes it: the group assembles.
        result = await handler.assembleCode(SOURCE, HASH, 12);
        assert.strictEqual(result.error, null);
        assert.strictEqual(result.code, CODE);
    });
});

describe('Chunked DEPLOY : DEPLOY v2/v3 assembly @regression @tier2', function () {
    let indexer, ctx, handler;

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
        db.getStatusString          = sinon.stub().resolves('valid');
        db.getDeployChunksForAssembly = sinon.stub().resolves([]);
        db.recordDeployChunk        = sinon.stub().resolves();
    }

    function deployData(overrides = {}) {
        return createBaseData({ ACTION: 'DEPLOY', SOURCE, BLOCK_INDEX: 100, ACTION_INDEX: 50, ...overrides });
    }

    beforeEach(function () {
        const config = getTestConfig();
        config['GAS_PRICE'] = '0';
        indexer = createMockIndexer({ config });
        addDeployStubs(indexer.indexerDb);
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
        // Inline (v0/v1) decode is gated on DEPLOY_BASE64_CODE; default the stub to
        // enabled (base64) so these v0/v1 fixtures behave as on a post-activation node.
        // Every gate on EXCEPT DEPLOY_DEFERRED_ASSEMBLY: these cases pin the PRE-activation
        // chunk verdicts (an incomplete group is invalid at the assembler, byte-for-byte as it
        // has always been). The post-activation verdicts live in deploy_deferred.test.js.
        const isEnabled = sinon.stub().resolves(true);
        isEnabled.withArgs('DEPLOY_DEFERRED_ASSEMBLY', sinon.match.any).resolves(false);
        ctx = { config: indexer.config, util: indexer.util, mapper: indexer.mapper, decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb, vm: { validateSyntax: () => ({ valid: true, errors: [] }), checkFloatWarnings: () => [], readManifest: async () => ({ success: true, manifest: { hasInitialize: false, permissionsType: 'undefined', maxTakeBpsType: 'undefined', metaType: 'object', metaJson: JSON.stringify({ name: 'Unit Fixture', description: 'A unit-test contract fixture.', version: '1.0.0' }), metaError: false, metaOversize: false } }), execute: async () => ({ success: true, gasUsed: 0 }) }, protocolChanges: { isEnabled } };
        handler = new Deploy(ctx);
        indexer.util.resetLists();
    });
    afterEach(function () { sinon.restore(); });

    const HASH = sha256Hex(CODE);

    it('assembles a contract from contiguous chunks (v2)', async function () {
        indexer.indexerDb.getDeployChunksForAssembly.resolves(chunkRows(CODE, 3));
        const data = deployData({ FORMAT: 2 });
        await handler.parse(['2', HASH, '100000', ''], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        // The contract was created with the reassembled plaintext source + the matching hash.
        const args = indexer.indexerDb.createContract.firstCall.args[0];
        assert.strictEqual(args.CODE, CODE);
        assert.strictEqual(args.CODE_HASH, HASH);
    });

    it('assembles from a single chunk (v2)', async function () {
        indexer.indexerDb.getDeployChunksForAssembly.resolves(chunkRows(CODE, 1));
        const data = deployData({ FORMAT: 2 });
        await handler.parse(['2', HASH, '100000', ''], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects when a chunk position is missing', async function () {
        const rows = chunkRows(CODE, 3).filter(r => r.chunk_index !== 1); // drop the middle
        indexer.indexerDb.getDeployChunksForAssembly.resolves(rows);
        const data = deployData({ FORMAT: 2 });
        await handler.parse(['2', HASH, '100000', ''], data, null);
        assert.ok(String(data['STATUS']).includes('CODE_HASH'));
        // A rejected deploy still records a contracts row, but with the invalid status (never 'valid').
        assert.ok(String(indexer.indexerDb.createContract.firstCall.args[0].STATUS).includes('CODE_HASH'));
    });

    it('rejects when no chunks exist for the group', async function () {
        indexer.indexerDb.getDeployChunksForAssembly.resolves([]);
        const data = deployData({ FORMAT: 2 });
        await handler.parse(['2', HASH, '100000', ''], data, null);
        assert.ok(String(data['STATUS']).includes('CODE_HASH'));
    });

    it('rejects when the declared CODE_HASH does not match the assembled bytes', async function () {
        // Chunks assemble to CODE, but the DEPLOY declares a different hash.
        indexer.indexerDb.getDeployChunksForAssembly.resolves(chunkRows(CODE, 2));
        const wrongHash = sha256Hex(CODE + ' // tampered');
        const data = deployData({ FORMAT: 2 });
        await handler.parse(['2', wrongHash, '100000', ''], data, null);
        assert.ok(String(data['STATUS']).includes('CODE_HASH'));
        assert.ok(String(indexer.indexerDb.createContract.firstCall.args[0].STATUS).includes('CODE_HASH'));
    });

    it('rejects a malformed CODE_HASH param', async function () {
        const data = deployData({ FORMAT: 2 });
        await handler.parse(['2', 'NOTAHASH', '100000', ''], data, null);
        assert.ok(String(data['STATUS']).includes('CODE_HASH'));
    });

    it('dedupes duplicate positions by lowest action_index', async function () {
        const good = chunkRows(CODE, 2);
        // Append a duplicate of position 0 carrying garbage at a HIGHER action_index : must be ignored.
        const rows = good.concat([{ chunk_index: 0, total_chunks: 2, code_part: 'GARBAGE=', action_index: 999 }]);
        indexer.indexerDb.getDeployChunksForAssembly.resolves(rows);
        const data = deployData({ FORMAT: 2 });
        await handler.parse(['2', HASH, '100000', ''], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('assembles deterministically when chunk rows arrive out of position order', async function () {
        // Determinism pin: the same chunks returned in a shuffled order, with action_index
        // NOT correlated to chunk_index. Assembly keys strictly on chunk_index (position) and
        // walks 0..total-1, so the reassembled bytes and the CODE_HASH are identical regardless
        // of the row/delivery order. Guards the chunked-DEPLOY assembled-code path against any
        // accidental dependence on result-set ordering (TP-02 chunked-deploy determinism).
        const ordered  = chunkRows(CODE, 4);
        const shuffled = [ordered[2], ordered[0], ordered[3], ordered[1]];
        indexer.indexerDb.getDeployChunksForAssembly.resolves(shuffled);
        const data = deployData({ FORMAT: 2 });
        await handler.parse(['2', HASH, '100000', ''], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        const args = indexer.indexerDb.createContract.firstCall.args[0];
        assert.strictEqual(args.CODE, CODE);
        assert.strictEqual(args.CODE_HASH, HASH);
    });

    it('assembles a stakeable chunked contract (v3) with staking metadata', async function () {
        indexer.indexerDb.getDeployChunksForAssembly.resolves(chunkRows(CODE, 2));
        const data = deployData({ FORMAT: 3 });
        await handler.parse(['3', HASH, '100000', '', '1000', 'BURN'], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        const args = indexer.indexerDb.createContract.firstCall.args[0];
        assert.strictEqual(args.CODE, CODE);
        assert.strictEqual(Number(args.COOLDOWN_BLOCKS), 1000);
    });

    it('still deploys inline for v0 (no chunk lookup)', async function () {
        const b64 = Buffer.from(CODE, 'utf8').toString('base64');
        const data = deployData({ FORMAT: 0 });
        await handler.parse(['0', b64, '100000', ''], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.getDeployChunksForAssembly.notCalled);
    });

    it('routes a v4 carrier to chunk storage (no contract created)', async function () {
        const data = deployData({ FORMAT: 4, ACTION_INDEX: 5 });
        await handler.parse(['4', HASH, '0', '3', 'aGVsbG8='], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        // v4 stores a slice and never runs the VM-deploy path.
        assert.ok(indexer.indexerDb.recordDeployChunk.calledOnce);
        assert.ok(indexer.indexerDb.createContract.notCalled);
    });
});
