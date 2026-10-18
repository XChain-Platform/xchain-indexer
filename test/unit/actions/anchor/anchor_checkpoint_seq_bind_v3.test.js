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

process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'DOGE';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const zlib = require('zlib');
const { createBaseData } = require('../../../fixtures/mocks.js');
const { armAnchor, disarmAnchor, crc32Hex } = require(
    './anchor.test/helpers/anchor_fixtures.js');
const { v3Params, vectors } = require('./anchor.test/helpers/anchor_v3_fixtures.js');

const BIND_ENV = 'XC_ANCHOR_CHECKPOINT_SEQ_BIND_REGTEST_ACTIVATION';
const FOLD_ENV = 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION';

function restoreEnv(name, value){
    if(value === undefined) delete process.env[name];
    else process.env[name] = value;
}

function validFoldParams(sectionOverrides){
    const params = v3Params({ sectionOverrides });
    const archive = JSON.stringify({
        matches: Array.from({ length: 17 }, (_, id) => ({ id }))
    });
    const crcIndex = params.indexOf(vectors.fixture.bundle_v3.batch_crc32);
    params[crcIndex] = crc32Hex(archive);
    params[crcIndex + 2] = zlib.gzipSync(Buffer.from(archive, 'utf8')).toString('base64url');
    return params;
}

function boundSections(extra){
    const overrides = {};
    for(const section of vectors.fixture.bundle_v3.sections){
        overrides[section.chain] = Object.assign({
            checkpoint_seq: String(section.snapshot_block)
        }, extra && extra[section.chain]);
    }
    return overrides;
}

describe('ANCHOR v3 checkpoint sequence binding @regression @tier1', function(){
    let savedBind;
    let savedFold;

    beforeEach(function(){
        savedBind = process.env[BIND_ENV];
        savedFold = process.env[FOLD_ENV];
        process.env[FOLD_ENV] = '0';
    });

    afterEach(function(){
        restoreEnv(BIND_ENV, savedBind);
        restoreEnv(FOLD_ENV, savedFold);
    });

    it('refuses a mismatched fold section at activation', async function(){
        process.env[BIND_ENV] = '100';
        const armed = armAnchor();
        try {
            const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3,
                COIN: 'DOGE', BLOCK_INDEX: 100 });
            const overrides = boundSections({ DOGE: { checkpoint_seq: '101' } });

            await armed.handler.parse(validFoldParams(overrides), data, null);

            assert.strictEqual(data.STATUS,
                'invalid: SECTION 1 CHECKPOINT_SEQ (does not match SNAPSHOT_BLOCK)');
        } finally {
            disarmAnchor(armed);
        }
    });

    it('reads checkpoint and archive watermarks from valid rows at activation', async function(){
        process.env[BIND_ENV] = '100';
        const armed = armAnchor();
        try {
            const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3,
                COIN: 'DOGE', BLOCK_INDEX: 100 });

            await armed.handler.parse(validFoldParams(boundSections()), data, null);

            assert.strictEqual(data.STATUS, 'valid');
            const checkpointCalls = armed.indexer.indexerDb.getMaxAnchorCheckpointSeq.getCalls();
            assert.strictEqual(checkpointCalls.length, 3);
            assert.ok(checkpointCalls.every(call => call.args[2] === true));
            const archiveCalls = armed.indexer.indexerDb.getArchiveReplayWatermarks.getCalls();
            assert.strictEqual(archiveCalls.length, 1);
            assert.strictEqual(archiveCalls[0].args[1], true);
        } finally {
            disarmAnchor(armed);
        }
    });

    it('keeps binding inert and reads all rows below activation', async function(){
        process.env[BIND_ENV] = '100';
        const armed = armAnchor();
        try {
            const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3,
                COIN: 'DOGE', BLOCK_INDEX: 99 });

            await armed.handler.parse(validFoldParams(), data, null);

            assert.strictEqual(data.STATUS, 'valid');
            const checkpointCalls = armed.indexer.indexerDb.getMaxAnchorCheckpointSeq.getCalls();
            assert.strictEqual(checkpointCalls.length, 3);
            assert.ok(checkpointCalls.every(call => call.args[2] === false));
            const archiveCalls = armed.indexer.indexerDb.getArchiveReplayWatermarks.getCalls();
            assert.strictEqual(archiveCalls.length, 1);
            assert.strictEqual(archiveCalls[0].args[1], false);
        } finally {
            disarmAnchor(armed);
        }
    });
});
