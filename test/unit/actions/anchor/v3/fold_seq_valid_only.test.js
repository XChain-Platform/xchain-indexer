'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const sinon = require('sinon');
const zlib = require('zlib');
const { createBaseData } = require('../../../../fixtures/mocks.js');
const gateRegistry = require('../../../../../src/consensus/gate_registry');
const { armAnchor, disarmAnchor, crc32Hex } = require(
    '../anchor.test/helpers/anchor_fixtures.js');
const { v3Params, vectors } = require(
    '../anchor.test/helpers/anchor_v3_fixtures.js');

const BIND_ENV = 'XC_ANCHOR_CHECKPOINT_SEQ_BIND_REGTEST_ACTIVATION';
const FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';
const STALE = 'invalid: SECTION 0 CHECKPOINT_SEQ (stale; replay of an older checkpoint)';
const anchorActivation = gateRegistry.copy('anchor_activation.ANCHOR_ACTIVATION');

function validFoldParams(network){
    const params = v3Params();
    params[1] = network;
    const archive = JSON.stringify({
        matches: Array.from({ length: 17 }, (_, id) => ({ id }))
    });
    const crcIndex = params.indexOf(vectors.fixture.bundle_v3.batch_crc32);
    params[crcIndex] = crc32Hex(archive);
    params[crcIndex + 2] = zlib.gzipSync(Buffer.from(archive, 'utf8')).toString('base64url');
    return params;
}

function abandonedWatermarks(db){
    db.getMaxAnchorCheckpointSeq.callsFake(
        async (_chain, _network, validOnly) => validOnly ? null : 900);
    db.getArchiveReplayWatermarks.callsFake(
        async (_wrapperRows, validOnly) => validOnly
            ? { batchSeq: null, checkpointSeq: null }
            : { batchSeq: 900, checkpointSeq: 900 });
}

async function parseFold(network){
    const armed = armAnchor();
    armed.indexer.config.NETWORK = network;
    abandonedWatermarks(armed.indexer.indexerDb);
    sinon.stub(gateRegistry, 'activeAt').callThrough().withArgs(FOLD_GATE).returns(true);
    const data = createBaseData({
        ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE',
        BLOCK_INDEX: anchorActivation[network] + 1
    });
    await armed.handler.parse(validFoldParams(network), data, null);
    return { armed, data };
}

describe('ANCHOR v3 replay watermark after a regtest chain reset @regression @tier3', function(){
    let savedBind;

    beforeEach(function(){
        savedBind = process.env[BIND_ENV];
        delete process.env[BIND_ENV];
    });

    afterEach(function(){
        if(savedBind === undefined) delete process.env[BIND_ENV];
        else process.env[BIND_ENV] = savedBind;
    });

    it('judges a regtest fold against valid rows so an unverified high row cannot poison it',
        async function(){
            const { armed, data } = await parseFold('regtest');
            try {
                assert.strictEqual(data.STATUS, 'valid');
                const checkpointCalls = armed.indexer.indexerDb
                    .getMaxAnchorCheckpointSeq.getCalls();
                assert.strictEqual(checkpointCalls.length, 3);
                assert.ok(checkpointCalls.every(call => call.args[2] === true));
                assert.strictEqual(
                    armed.indexer.indexerDb.getArchiveReplayWatermarks.firstCall.args[1], true);
            } finally {
                disarmAnchor(armed);
            }
        });

    for(const network of ['mainnet', 'testnet']){
        it('keeps the ' + network + ' fold on the all-status watermark', async function(){
            const { armed, data } = await parseFold(network);
            try {
                assert.strictEqual(data.STATUS, STALE);
                const checkpointRead = armed.indexer.indexerDb.getMaxAnchorCheckpointSeq.firstCall;
                assert.deepStrictEqual(checkpointRead.args, ['BTC', network, false]);
                assert.ok(armed.indexer.indexerDb.getArchiveReplayWatermarks.notCalled);
            } finally {
                disarmAnchor(armed);
            }
        });
    }
});
