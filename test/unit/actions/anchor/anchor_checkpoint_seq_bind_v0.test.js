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
const sinon = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks.js');
const validate = require('../../../../src/actions/anchor/validate.js');
const { armAnchor, disarmAnchor, v0Params } =
    require('./anchor.test/helpers/anchor_fixtures.js');

const ENV = 'XC_ANCHOR_CHECKPOINT_SEQ_BIND_REGTEST_ACTIVATION';

function restoreEnv(saved){
    if(saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
}

describe('ANCHOR v0 checkpoint sequence binding @regression @tier1', function () {
    let saved;
    let armed;

    beforeEach(function () {
        saved = process.env[ENV];
        process.env[ENV] = '100';
        armed = armAnchor();
    });

    afterEach(function () {
        disarmAnchor(armed);
        restoreEnv(saved);
    });

    async function parseSection(checkpointSeq, snapshotBlock, blockIndex){
        const data = createBaseData({
            ACTION: 'ANCHOR',
            FORMAT: 0,
            COIN: 'DOGE',
            BLOCK_INDEX: blockIndex,
        });
        await armed.handler.parse(v0Params({
            snapshot: snapshotBlock,
            sections: [{ chain: 'BTC', seq: checkpointSeq, snapshot: snapshotBlock }],
        }), data, null);
        return data;
    }

    it('refuses a section whose sequence differs from its snapshot at activation', async function () {
        const reasonSpy = sinon.spy(validate, 'checkpointSeqBindReason');
        const data = await parseSection('99', '100', 100);

        assert.strictEqual(data.STATUS,
            'invalid: SECTION 0 CHECKPOINT_SEQ (does not match SNAPSHOT_BLOCK)');
        assert.strictEqual(reasonSpy.callCount, 1);
        assert.strictEqual(armed.indexer.indexerDb.createAnchorAction.callCount, 1);
        assert.ok(armed.indexer.indexerDb.getMaxAnchorCheckpointSeq.notCalled);
    });

    it('refuses a noncanonical bound sequence at activation', async function () {
        const data = await parseSection('0100', '0100', 100);

        assert.strictEqual(data.STATUS,
            'invalid: SECTION 0 CHECKPOINT_SEQ (not a canonical safe integer)');
        assert.ok(armed.indexer.indexerDb.getMaxAnchorCheckpointSeq.notCalled);
    });

    it('reads only valid checkpoint rows for a bound section at activation', async function () {
        const data = await parseSection('100', '100', 100);

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(armed.indexer.indexerDb.createAnchorAction.callCount, 1);
        assert.strictEqual(armed.indexer.indexerDb.getMaxAnchorCheckpointSeq.callCount, 1);
        assert.deepStrictEqual(armed.indexer.indexerDb.getMaxAnchorCheckpointSeq.firstCall.args,
            ['BTC', 'regtest', true]);
    });

    // Regtest reads verified rows on either side of the bind gate, as the archive
    // head does, so an abandoned chain's unverified rows never set the watermark.
    // The all-status read below the gate is pinned for mainnet and testnet in
    // anchor_checkpoint_seq_bind_v0_below_gate.test.js.
    it('reads only verified rows on regtest immediately before activation', async function () {
        const data = await parseSection('99', '100', 99);

        assert.strictEqual(data.STATUS, 'valid');
        assert.deepStrictEqual(armed.indexer.indexerDb.getMaxAnchorCheckpointSeq.firstCall.args,
            ['BTC', 'regtest', true]);
    });
});
