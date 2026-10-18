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

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks.js');
const validate = require('../../../../src/actions/anchor/validate.js');
const { armAnchor, disarmAnchor, v1Params, ARCHIVE_JSON } =
    require('./anchor.test/helpers/anchor_fixtures.js');

const ENV = 'XC_ANCHOR_CHECKPOINT_SEQ_BIND_REGTEST_ACTIVATION';

function restoreEnv(saved){
    if(saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
}

describe('ANCHOR v1 checkpoint sequence binding @regression @tier1', function () {
    let saved;
    let armed;

    beforeEach(function () {
        saved = process.env[ENV];
        process.env[ENV] = '0';
        armed = armAnchor();
    });

    afterEach(function () {
        disarmAnchor(armed);
        restoreEnv(saved);
    });

    it('refuses the archive head reason returned at the gate', async function () {
        const reason = 'CHECKPOINT_SEQ (archive-head sentinel)';
        const reasonStub = sinon.stub(validate, 'checkpointSeqBindReason').returns(reason);
        const data = createBaseData({
            ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', BLOCK_INDEX: 100,
        });

        await armed.handler.parse(v1Params(ARCHIVE_JSON, {
            seq: '900', snapshot: '900',
        }), data, null);

        assert.strictEqual(data.STATUS, 'invalid: ' + reason);
        assert.ok(reasonStub.calledOnceWithExactly(data));
        assert.ok(armed.indexer.indexerDb.getMaxAnchorCheckpointSeq.notCalled);
        assert.ok(armed.indexer.indexerDb.getArchiveReplayWatermarks.notCalled);
    });

    it('reads both replay watermarks from valid rows only at the gate', async function () {
        const data = createBaseData({
            ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', BLOCK_INDEX: 100,
        });

        await armed.handler.parse(v1Params(ARCHIVE_JSON, {
            seq: '900', snapshot: '900',
        }), data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.ok(armed.indexer.indexerDb.getMaxAnchorCheckpointSeq.calledOnceWithExactly(
            'BTC', 'regtest', true));
        assert.strictEqual(armed.indexer.indexerDb.getArchiveReplayWatermarks.callCount, 1);
        assert.strictEqual(
            armed.indexer.indexerDb.getArchiveReplayWatermarks.firstCall.args[1], true);
    });
});
