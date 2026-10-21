/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/consensus/bridge_proof_client/checkpoint_section_pick_baseline.test.js
 *
 * The section reads selectCheckpoint makes on testnet today, against the real gate
 * registry. Whatever gates the section pick later must keep these reads on testnet,
 * where such a gate ships unarmed. The ctx indexerDb records every call to the four
 * checkpoint reads and returns empty arrays.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const PC = require('../../../../src/consensus/bridge_proof_client.js');

const NET = 'testnet';
const SNAP = 155055;

function recordingCtx(blockIndex, rows) {
    const calls = [];
    const db = {};
    for (const name of ['getEarliestValidAnchorCheckpoint', 'getEarliestValidAnchorCheckpointAfterAnchor',
                        'getMirroredStateCheckpointCandidates', 'getMirroredStateCheckpointCandidatesAfterAnchor']) {
        db[name] = sinon.spy(async (...args) => {
            calls.push({ name, args });
            return (rows && rows[name]) || [];
        });
    }
    return { ctx: { indexerDb: db, coin: 'BTC', network: NET, blockIndex }, calls };
}

function row(srcChain) {
    return { transfer_id: 'ab'.repeat(32), snapshot_block: SNAP, network: NET, src_chain: srcChain,
             src_action_index: 1, dest_chain: 'BTC', tick: 'XCHAIN', decimals: 0, amount: '1' };
}

function reads(calls, name) {
    return calls.filter(c => c.name === name);
}

function assertSingleVersionZero(call) {
    assert.deepStrictEqual([].concat(call.args[0]), [0]);
}

describe('selectCheckpoint section reads on testnet before any section gate @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('ANCHOR_SECTION_VERSION is 0', function () {
        assert.strictEqual(PC.ANCHOR_SECTION_VERSION, 0);
    });

    it('a BTC-origin row at blockIndex 157500 reads the block_index axis with version 0', async function () {
        const { ctx, calls } = recordingCtx(157500);
        await PC.selectCheckpoint(row('BTC'), ctx);
        const hits = reads(calls, 'getEarliestValidAnchorCheckpoint');
        assert.strictEqual(hits.length, 1);
        assertSingleVersionZero(hits[0]);
        assert.deepStrictEqual(hits[0].args.slice(1), ['BTC', NET, SNAP]);
        assert.strictEqual(reads(calls, 'getEarliestValidAnchorCheckpointAfterAnchor').length, 0);
        assert.strictEqual(reads(calls, 'getMirroredStateCheckpointCandidates').length, 1);
        assert.strictEqual(reads(calls, 'getMirroredStateCheckpointCandidatesAfterAnchor').length, 0);
    });

    it('a DOGE-origin row at blockIndex 157000 reads the block_index axis with version 0', async function () {
        const { ctx, calls } = recordingCtx(157000);
        await PC.selectCheckpoint(row('DOGE'), ctx);
        const hits = reads(calls, 'getEarliestValidAnchorCheckpoint');
        assert.strictEqual(hits.length, 1);
        assertSingleVersionZero(hits[0]);
        assert.deepStrictEqual(hits[0].args.slice(1), ['DOGE', NET, SNAP]);
        assert.strictEqual(reads(calls, 'getEarliestValidAnchorCheckpointAfterAnchor').length, 0);
        assert.strictEqual(reads(calls, 'getMirroredStateCheckpointCandidates').length, 1);
        assert.strictEqual(reads(calls, 'getMirroredStateCheckpointCandidatesAfterAnchor').length, 0);
    });

    it('a DOGE-origin row at blockIndex 157500 reads the anchor axis with version 0 and never the block_index read', async function () {
        const { ctx, calls } = recordingCtx(157500);
        await PC.selectCheckpoint(row('DOGE'), ctx);
        const hits = reads(calls, 'getEarliestValidAnchorCheckpointAfterAnchor');
        assert.strictEqual(hits.length, 1);
        assertSingleVersionZero(hits[0]);
        assert.deepStrictEqual(hits[0].args.slice(1), ['DOGE', NET, SNAP]);
        assert.strictEqual(reads(calls, 'getEarliestValidAnchorCheckpoint').length, 0);
        assert.strictEqual(reads(calls, 'getMirroredStateCheckpointCandidates').length, 0);
        assert.strictEqual(reads(calls, 'getMirroredStateCheckpointCandidatesAfterAnchor').length, 1);
    });

    for (const [label, chain, blockIndex] of [['BTC origin at 157500', 'BTC', 157500],
                                              ['DOGE origin at 157000', 'DOGE', 157000],
                                              ['DOGE origin at 157500', 'DOGE', 157500]]) {
        it(`${label}: every empty read returns null`, async function () {
            const { ctx } = recordingCtx(blockIndex);
            assert.strictEqual(await PC.selectCheckpoint(row(chain), ctx), null);
        });
    }

    it('a returned version 0 anchor row is picked with source anchor_actions', async function () {
        const anchor = { chain: 'BTC', network: NET, block_index: 157494, checkpoint_seq: 7,
                         snapshot_block: 157500, state_root: 'a'.repeat(64), state_root_version: 2 };
        const { ctx, calls } = recordingCtx(157500, { getEarliestValidAnchorCheckpoint: [anchor] });
        const picked = await PC.selectCheckpoint(row('BTC'), ctx);
        assertSingleVersionZero(reads(calls, 'getEarliestValidAnchorCheckpoint')[0]);
        assert.strictEqual(picked.source, 'anchor_actions');
        assert.strictEqual(picked.block_index, 157494);
        assert.strictEqual(picked.checkpoint_seq, 7);
    });
});
