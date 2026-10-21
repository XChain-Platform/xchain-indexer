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
 * Pins the section reads selectCheckpoint makes on testnet today, against the real gate
 * registry. Each read binds exactly section version 0, and a BTC origin, or a DOGE origin
 * below the anchor-match activation, reads the block_index axis while a DOGE origin at or
 * above it reads the anchor axis. Any later section gate must stay unarmed on testnet
 * and so keep these reads as they are.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const { selectCheckpoint, ANCHOR_SECTION_VERSION } = require('../../../../src/consensus/bridge_proof_client/checkpoint_source.js');

const NET  = 'testnet';
const SNAP = 155055;

const READS = [
    'getEarliestValidAnchorCheckpoint',
    'getEarliestValidAnchorCheckpointAfterAnchor',
    'getMirroredStateCheckpointCandidates',
    'getMirroredStateCheckpointCandidatesAfterAnchor'
];

// A ctx whose indexerDb records every call to the four reads and answers with `anchorRows`
// for the anchor_actions reads and an empty array for the mirrored ones.
function recordingCtx(blockIndex, anchorRows){
    const calls = [];
    const indexerDb = {};
    for(const name of READS){
        indexerDb[name] = sinon.spy(async (...args) => {
            calls.push({ name, args });
            return name.startsWith('getEarliestValid') ? (anchorRows || []) : [];
        });
    }
    return { ctx: { indexerDb, coin: 'BTC', network: NET, blockIndex }, calls };
}

function row(srcChain){
    return { transfer_id: 'ab'.repeat(32), snapshot_block: SNAP, network: NET, src_chain: srcChain,
             src_action_index: 1, dest_chain: 'BTC', tick: 'papeto', decimals: 0, amount: '100' };
}

function named(calls, name){
    return calls.filter(c => c.name === name);
}

function assertSectionZero(call){
    assert.deepStrictEqual([].concat(call.args[0]), [0]);
}

describe('selectCheckpoint section reads on testnet', function(){
    afterEach(() => sinon.restore());

    it('ANCHOR_SECTION_VERSION is 0', function(){
        assert.strictEqual(ANCHOR_SECTION_VERSION, 0);
    });

    it('a BTC-origin row at blockIndex 157500 reads the block_index axis for BTC testnet at its snapshot_block', async function(){
        const { ctx, calls } = recordingCtx(157500);
        await selectCheckpoint(row('BTC'), ctx);
        const reads = named(calls, 'getEarliestValidAnchorCheckpoint');
        assert.strictEqual(reads.length, 1);
        assertSectionZero(reads[0]);
        assert.deepStrictEqual(reads[0].args.slice(1), ['BTC', NET, SNAP]);
        assert.strictEqual(named(calls, 'getEarliestValidAnchorCheckpointAfterAnchor').length, 0);
        assert.strictEqual(named(calls, 'getMirroredStateCheckpointCandidatesAfterAnchor').length, 0);
        assert.strictEqual(named(calls, 'getMirroredStateCheckpointCandidates').length, 1);
    });

    it('a DOGE-origin row at blockIndex 157000, below the anchor-match activation, reads the block_index axis', async function(){
        const { ctx, calls } = recordingCtx(157000);
        await selectCheckpoint(row('DOGE'), ctx);
        const reads = named(calls, 'getEarliestValidAnchorCheckpoint');
        assert.strictEqual(reads.length, 1);
        assertSectionZero(reads[0]);
        assert.deepStrictEqual(reads[0].args.slice(1), ['DOGE', NET, SNAP]);
        assert.strictEqual(named(calls, 'getEarliestValidAnchorCheckpointAfterAnchor').length, 0);
        assert.strictEqual(named(calls, 'getMirroredStateCheckpointCandidatesAfterAnchor').length, 0);
    });

    it('a DOGE-origin row at blockIndex 157500 reads the anchor axis and never the block_index read', async function(){
        const { ctx, calls } = recordingCtx(157500);
        await selectCheckpoint(row('DOGE'), ctx);
        const reads = named(calls, 'getEarliestValidAnchorCheckpointAfterAnchor');
        assert.strictEqual(reads.length, 1);
        assertSectionZero(reads[0]);
        assert.deepStrictEqual(reads[0].args.slice(1), ['DOGE', NET, SNAP]);
        assert.strictEqual(named(calls, 'getEarliestValidAnchorCheckpoint').length, 0);
        assert.strictEqual(named(calls, 'getMirroredStateCheckpointCandidates').length, 0);
        assert.strictEqual(named(calls, 'getMirroredStateCheckpointCandidatesAfterAnchor').length, 1);
    });

    for(const [label, chain, blockIndex] of [['BTC origin', 'BTC', 157500], ['DOGE origin below the activation', 'DOGE', 157000],
                                             ['DOGE origin above the activation', 'DOGE', 157500]]){
        it(`every empty read returns null for a ${label}`, async function(){
            const { ctx, calls } = recordingCtx(blockIndex);
            assert.strictEqual(await selectCheckpoint(row(chain), ctx), null);
            assert.ok(calls.length >= 2);
        });
    }

    it('a returned version 0 anchor row is picked with source anchor_actions', async function(){
        const anchor = { chain: 'BTC', network: NET, block_index: 157400, checkpoint_seq: 155060,
                         snapshot_block: 155060, state_root: 'a'.repeat(64), state_root_version: 2 };
        const { ctx, calls } = recordingCtx(157500, [anchor]);
        const picked = await selectCheckpoint(row('BTC'), ctx);
        assertSectionZero(calls[0]);
        assert.strictEqual(picked.source, 'anchor_actions');
        assert.strictEqual(picked.block_index, 157400);
        assert.strictEqual(picked.checkpoint_seq, 155060);
        assert.strictEqual(picked.state_root, 'a'.repeat(64));
    });
});
