// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');
const { makeColumnRejectingDb } = require('../../helpers/file_multipart_column_stub.js');
const { buildFile } = require('./contract/file.test/helpers/fixture.js');
const Batch = require('../../../src/actions/batch/index.js');
const File = require('../../../src/actions/file.js');
const Message = require('../../../src/actions/message.js');
const Database = require('../../../src/db');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const FILE_HASH = 'a'.repeat(64);
const KEY_HASH = 'b'.repeat(64);

function manifest(overrides = {}){
    const values = Object.assign({
        fileHash: FILE_HASH,
        totalParts: '2',
        totalBytes: '3',
        name: 'asset.bin',
        type: 'application/octet-stream',
        title: 'Asset',
        memo: '',
        gateTicker: '',
        encryptionMethod: '',
        keyHash: '',
        gateMinAmount: '',
        compression: '',
    }, overrides);
    return ['1', values.fileHash, values.totalParts, values.totalBytes, values.name,
        values.type, values.title, values.memo, values.gateTicker,
        values.encryptionMethod, values.keyHash, values.gateMinAmount, values.compression];
}

function part(overrides = {}){
    const values = Object.assign({ fileHash: FILE_HASH, partIndex: '0' }, overrides);
    return ['2', values.fileHash, values.partIndex];
}

function actionData(format, rawData, overrides = {}){
    const data = createBaseData(Object.assign({ ACTION: 'FILE', FORMAT: format, SOURCE }, overrides));
    if(rawData !== undefined)
        data['RAW_DATA'] = rawData;
    return data;
}

function harness(active = true){
    const built = buildFile();
    const { indexer, actionsCtx } = built;
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) =>
        name === 'FILE_MULTIPART' ? active : true);
    indexer.indexerDb.createManifest = sinon.stub().resolves();
    indexer.indexerDb.createPart = sinon.stub().resolves();
    indexer.indexerDb.createGatedFile = sinon.stub().resolves();
    indexer.indexerDb.getGroup = sinon.stub().resolves({ manifest: null, parts: [] });
    indexer.indexerDb.isActionAllowed.resolves(true);
    return Object.assign(built, { handler: new File(actionsCtx) });
}

async function statusFor(params, data, active = true){
    const built = harness(active);
    await built.handler.parse(params, data, null);
    return { status: data['STATUS'], built };
}

describe('FILE multipart activation routing @regression @tier1', function(){
    it('sends versions 1 and 2 through the unchanged version 0 refusal path below activation', async function(){
        for(const [params, data] of [
            [manifest(), actionData(1)],
            [part(), actionData(2, Buffer.from('abc'))],
        ]){
            const { status, built } = await statusFor(params, data, false);
            assert.strictEqual(status, 'invalid: VERSION (unknown)');
            assert.ok(built.indexer.indexerDb.createFile.calledOnce);
            assert.ok(!built.indexer.indexerDb.createManifest.called);
            assert.ok(!built.indexer.indexerDb.createPart.called);
        }
    });

    it('registers and stores a manifest and a part above activation', async function(){
        const manifestRun = await statusFor(manifest(), actionData(1));
        assert.strictEqual(manifestRun.status, 'valid');
        assert.ok(manifestRun.built.indexer.indexerDb.createFile.calledOnce);
        assert.ok(manifestRun.built.indexer.indexerDb.createManifest.calledOnce);
        const partRun = await statusFor(part(), actionData(2, Buffer.from('abc')));
        assert.strictEqual(partRun.status, 'valid');
        assert.ok(partRun.built.indexer.indexerDb.createPart.calledOnce);
        assert.ok(!partRun.built.indexer.indexerDb.createFile.called);
        assert.ok(!partRun.built.indexer.mapper.createMappings.called);
    });
});

describe('FILE multipart refusal integration @regression @tier1', function(){
    it('stores every manifest field refusal with its exact verdict', async function(){
        const cases = [
            [manifest({ fileHash: 'bad' }), actionData(1), 'invalid: FILE_HASH (format)'],
            [manifest({ totalParts: '1' }), actionData(1), 'invalid: TOTAL_PARTS (range)'],
            [manifest({ totalBytes: '0' }), actionData(1), 'invalid: TOTAL_BYTES (range)'],
            [manifest(), actionData(1, Buffer.from('x')), 'invalid: RAW_DATA (manifest carries no bytes)'],
        ];
        for(const [params, data, expected] of cases){
            const { status, built } = await statusFor(params, data);
            assert.strictEqual(status, expected);
            assert.ok(built.indexer.indexerDb.createManifest.calledOnce);
        }
    });

    it('stores every part field refusal with its exact verdict', async function(){
        const cases = [
            [part({ fileHash: 'bad' }), actionData(2, Buffer.from('x')), 'invalid: FILE_HASH (format)'],
            [part({ partIndex: '32' }), actionData(2, Buffer.from('x')), 'invalid: PART_INDEX (range)'],
            [part(), actionData(2, Buffer.alloc(0)), 'invalid: RAW_DATA (empty part)'],
        ];
        for(const [params, data, expected] of cases){
            const { status, built } = await statusFor(params, data);
            assert.strictEqual(status, expected);
            assert.ok(built.indexer.indexerDb.createPart.calledOnce);
        }
    });

    it('applies multipart checks after the sleeping SOURCE refusal', async function(){
        const built = harness();
        built.indexer.indexerDb.isActionAllowed.resolves(false);
        const data = actionData(1);
        await built.handler.parse(manifest({ fileHash: 'bad' }), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: SOURCE (sleeping)');
    });
});

describe('FILE multipart batch refusals @regression @tier1', function(){
    it('rejects a part whenever BATCH_POSITION is an own property', async function(){
        const data = actionData(2, Buffer.from('x'), { BATCH_POSITION: 0 });
        assert.strictEqual((await statusFor(part(), data)).status, 'invalid: VERSION (batch)');
    });

    it('rejects a manifest beside a second FILE', async function(){
        const siblings = [{ action: 'FILE' }, { action: 'FILE' }];
        const data = actionData(1, undefined, { BATCH_POSITION: 0, SIBLING_ACTIONS: siblings });
        assert.strictEqual((await statusFor(manifest(), data)).status, 'invalid: FILE_HASH (batch)');
    });

    it('rejects a duplicate valid manifest from the same source', async function(){
        const built = harness();
        built.indexer.indexerDb.getGroup.resolves({ manifest: { file_hash: FILE_HASH }, parts: [] });
        const data = actionData(1);
        await built.handler.parse(manifest(), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: FILE_HASH (duplicate manifest)');
    });
});

function adaptColumnDb(indexer, strictDb){
    indexer.indexerDb.createManifest = sinon.stub().callsFake((row) => strictDb.createManifest({
        file_hash: row['FILE_HASH'], total_parts: row['TOTAL_PARTS'], total_bytes: row['TOTAL_BYTES'],
    }));
    indexer.indexerDb.createPart = sinon.stub().callsFake((row) => strictDb.createPart({
        file_hash: row['FILE_HASH'], part_index: row['PART_INDEX'],
        byte_length: row['BYTE_LENGTH'], part_digest: row['PART_DIGEST'],
    }));
}

describe('FILE multipart storage sanitising @regression @tier1', function(){
    it('fits invalid manifest fields to the strict table columns', async function(){
        const built = harness();
        const strictDb = makeColumnRejectingDb();
        adaptColumnDb(built.indexer, strictDb);
        const data = actionData(1);
        await built.handler.parse(manifest({
            fileHash: 'bad', totalParts: '4294967296', totalBytes: '4294967296',
        }), data, null);
        assert.deepStrictEqual(strictDb.manifests[0], { file_hash: '', total_parts: 0, total_bytes: 0 });
    });

    it('fits invalid part fields and hashes the raw bytes exactly', async function(){
        const built = harness();
        const strictDb = makeColumnRejectingDb();
        adaptColumnDb(built.indexer, strictDb);
        const raw = Buffer.from('abc');
        await built.handler.parse(part({ fileHash: 'bad', partIndex: '4294967296' }),
            actionData(2, raw), null);
        assert.deepStrictEqual(strictDb.parts[0], {
            file_hash: '', part_index: 0, byte_length: 3,
            part_digest: crypto.createHash('sha256').update(raw).digest('hex'),
        });
    });
});

describe('FILE multipart part identity @regression @tier1', function(){
    it('stores only a part row and leaves its FILE action index invalid', async function(){
        const { built } = await statusFor(part(), actionData(2, Buffer.from('abc')));
        assert.ok(built.indexer.indexerDb.createPart.calledOnce);
        assert.ok(!built.indexer.indexerDb.createFile.called);
        const db = {
            util: built.indexer.util,
            getActionIndexTable: Database.prototype.getActionIndexTable,
            async doQuery(query){
                if(query.includes('LCASE(a2.action)')) return [{ action: 'file' }];
                if(query.includes('FROM \n                            files')) return [];
                throw new Error('unexpected query: ' + query);
            },
        };
        assert.strictEqual(await Database.prototype.isActionIndexValid.call(db, 1), false);
    });
});

function gatedBatchHarness(){
    const indexer = createMockIndexer();
    const actionsCtx = {
        config: indexer.config, util: indexer.util, mapper: indexer.mapper,
        decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb,
        protocolChanges: { isEnabled: sinon.stub().resolves(true) },
        actionAliases: {}, processAction: null,
    };
    const fileHandler = new File(actionsCtx);
    const messageHandler = new Message(actionsCtx);
    const seenMessageKeys = [];
    actionsCtx.processAction = async (action, params, data, error) => {
        if(action === 'FILE') return fileHandler.parse(params, data, error);
        seenMessageKeys.push(...Object.keys(data));
        return messageHandler.parse(params, data, error);
    };
    indexer.indexerDb.createManifest = sinon.stub().resolves();
    indexer.indexerDb.createPart = sinon.stub().resolves();
    indexer.indexerDb.createGatedFile = sinon.stub().resolves();
    indexer.indexerDb.getGroup = sinon.stub().resolves({ manifest: null, parts: [] });
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ OWNER: SOURCE, DECIMALS: 8 }));
    indexer.indexerDb.isOwnershipEscrowed.resolves(false);
    return { indexer, actionsCtx, handler: new Batch(actionsCtx), seenMessageKeys };
}

describe('FILE gated multipart batch integration @regression @tier1', function(){
    it('joins a manifest and MESSAGE v2 without leaking FILE fields into the message', async function(){
        const built = gatedBatchHarness();
        const file = manifest({
            gateTicker: 'TEST', encryptionMethod: '1', keyHash: KEY_HASH,
        }).join('|');
        const message = ['MESSAGE', '2', 'BTC', SOURCE, 'ciphertext'].join('|');
        const data = actionData(0, undefined, {
            ACTION: 'BATCH', TX_DATA: 'BATCH|0|FILE|' + file + ';' + message,
        });
        await built.handler.parse(['0'], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(built.indexer.indexerDb.createManifest.calledOnce);
        assert.ok(built.indexer.indexerDb.createGatedFile.calledOnce);
        assert.strictEqual(built.indexer.indexerDb.createGatedFile.firstCall.args[0]['RAW_DATA'], null);
        for(const key of ['FILE_HASH', 'TOTAL_PARTS', 'TOTAL_BYTES', 'GATE_TICKER', 'KEY_HASH'])
            assert.ok(!built.seenMessageKeys.includes(key), key + ' leaked into MESSAGE');
        assert.ok(built.indexer.indexerDb.createMessage.calledOnce);
    });
});
