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

const reassembly = require('../../../../src/actions/anchor/reassembly.js');
const gateRegistry = require('../../../../src/consensus/gate_registry.js');
const { stubActiveAt, stubGate } = require('../../../helpers/gate_modules.js');

const PARENT_STATUS_GATE = 'reassemble_chunk_parent_status_activation.REASSEMBLE_CHUNK_PARENT_STATUS_ACTIVATION';

function makeHandler(parentStatus){
    const stamp = sinon.stub().resolves();
    return {
        stamp,
        handler: {
            config: { COIN: 'DOGE', NETWORK: 'regtest' },
            indexerDb: {
                getStatusString: sinon.stub().withArgs(7).resolves(parentStatus),
                getAnchorChunks: sinon.stub().resolves([
                    { chunk_index: 1, archive_b64: 'continuation' },
                ]),
                setAnchorArchiveStatus: stamp,
            },
            archiveCrc: sinon.stub().returns('87654321'),
            archiveMatchCount: sinon.stub().throws(new Error('CRC mismatch must settle first')),
        },
    };
}

function chunkData(height = 101){
    return {
        STATUS: 'valid', MATCH_BATCH_SEQ: 7, TOTAL_CHUNKS: 2, BLOCK_INDEX: height,
    };
}

function parentRow(height = 100){
    return {
        action_index: 41, status_id: 7, version: 1, chain: 'BTC',
        block_index_doge: height, match_batch_seq: 7, match_count: 1,
        batch_crc32: '12345678', total_chunks: 2, archive_b64: 'head',
    };
}

async function run(parentStatus, parentGate, data = chunkData(), parent = parentRow()){
    stubActiveAt(sinon, PARENT_STATUS_GATE, parentGate);
    const made = makeHandler(parentStatus);
    await reassembly.reassembleAtChunk(made.handler, data, parent, null, null);
    return made;
}

describe('ANCHOR chunk-side reassembly parent-status gate @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('is unarmed on mainnet, armed on testnet at its v0.25.0 heights, and opt-in on regtest', function () {
        assert.strictEqual(gateRegistry.activeAt(PARENT_STATUS_GATE, 'mainnet', 'BTC', 1e9, null), false);
        // The v0.25.0 cut arms BTC:testnet at 157073 and DOGE:testnet (and the bare testnet key) at 68009330.
        assert.strictEqual(gateRegistry.activeAt(PARENT_STATUS_GATE, 'testnet', 'BTC', 157072, null), false);
        assert.strictEqual(gateRegistry.activeAt(PARENT_STATUS_GATE, 'testnet', 'BTC', 157073, null), true);
        assert.strictEqual(gateRegistry.activeAt(PARENT_STATUS_GATE, 'testnet', 'DOGE', 68009329, null), false);
        assert.strictEqual(gateRegistry.activeAt(PARENT_STATUS_GATE, 'testnet', 'DOGE', 68009330, null), true);
        assert.strictEqual(gateRegistry.get(PARENT_STATUS_GATE).regtest, null);
    });

    it('keeps the deployed chunk-status-only rule while the gate is inert', async function () {
        const { handler, stamp } = await run('invalid: insufficient valid signatures', false);
        assert.deepStrictEqual(stamp.args, [[41, 'invalid_archive']]);
        assert.strictEqual(handler.indexerDb.getStatusString.called, false);
    });

    it('admits a valid parent when the gate is active', async function () {
        const { handler, stamp } = await run('valid', true);
        assert.deepStrictEqual(stamp.args, [[41, 'invalid_archive', true]]);
        assert.ok(handler.indexerDb.getStatusString.calledOnceWithExactly(7));
    });

    it('rejects an invalid parent before reading chunks when the gate is active', async function () {
        const { handler, stamp } = await run('invalid: insufficient valid signatures', true);
        assert.strictEqual(stamp.called, false);
        assert.strictEqual(handler.indexerDb.getAnchorChunks.called, false);
    });

    it('admits an unverified parent when the parent-status gate is active', async function () {
        const active = await run('unverified', true);
        assert.deepStrictEqual(active.stamp.args, [[41, 'invalid_archive', true]]);
    });

    it('keys the new rule on the chunk height', async function () {
        const parentStatus = stubGate(sinon, PARENT_STATUS_GATE, false);
        parentStatus.callsFake((key, network, coin, height) => Number(height) >= 101);
        const made = makeHandler('unverified');

        await reassembly.reassembleAtChunk(
            made.handler, chunkData(101), parentRow(100), null, null);

        assert.deepStrictEqual(made.stamp.args, [[41, 'invalid_archive', true]]);
        assert.ok(parentStatus.calledWith('regtest', null, 101, null));
    });
});
