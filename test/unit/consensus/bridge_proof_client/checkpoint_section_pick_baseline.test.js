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
 * registry. The indexerDb double records every call to the four checkpoint reads and returns
 * empty arrays, so what is pinned is which read is made, on which axis, and which section
 * version it binds.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const { ANCHOR_SECTION_VERSION, selectCheckpoint } = require('../../../../src/consensus/bridge_proof_client/checkpoint_source.js');

const READS = [
    'getEarliestValidAnchorCheckpoint',
    'getEarliestValidAnchorCheckpointAfterAnchor',
    'getMirroredStateCheckpointCandidates',
    'getMirroredStateCheckpointCandidatesAfterAnchor'
];

function recorder(returns){
    const calls = [];
    const db = {};
    for(const name of READS){
        db[name] = sinon.spy(async (...args) => {
            calls.push({ name, args });
            return (returns && returns[name]) || [];
        });
    }
    return { db, calls };
}

function ctxFor(db, blockIndex){
    return { indexerDb: db, coin: 'BTC', network: 'testnet', blockIndex };
}

function row(srcChain, snapshotBlock){
    return { src_chain: srcChain, network: 'testnet', snapshot_block: snapshotBlock };
}

function versions(call){
    return [].concat(call.args[0]);
}

describe('selectCheckpoint section reads on testnet @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('ANCHOR_SECTION_VERSION is 0', function () {
        assert.strictEqual(ANCHOR_SECTION_VERSION, 0);
    });

    it('a BTC origin at blockIndex 157500 reads the block_index axis for version 0', async function () {
        const { db, calls } = recorder();
        const out = await selectCheckpoint(row('BTC', 155055), ctxFor(db, 157500));
        const names = calls.map(c => c.name);
        assert.ok(names.includes('getEarliestValidAnchorCheckpoint'));
        assert.ok(!names.includes('getEarliestValidAnchorCheckpointAfterAnchor'));
        assert.ok(names.includes('getMirroredStateCheckpointCandidates'));
        assert.ok(!names.includes('getMirroredStateCheckpointCandidatesAfterAnchor'));
        const call = calls.find(c => c.name === 'getEarliestValidAnchorCheckpoint');
        assert.deepStrictEqual(versions(call), [0]);
        assert.deepStrictEqual(call.args.slice(1), ['BTC', 'testnet', 155055]);
        assert.strictEqual(out, null);
    });

    it('a DOGE origin at blockIndex 157000, below the anchor-match activation, reads the block_index axis for version 0', async function () {
        const { db, calls } = recorder();
        const out = await selectCheckpoint(row('DOGE', 155055), ctxFor(db, 157000));
        const names = calls.map(c => c.name);
        assert.ok(names.includes('getEarliestValidAnchorCheckpoint'));
        assert.ok(!names.includes('getEarliestValidAnchorCheckpointAfterAnchor'));
        assert.ok(names.includes('getMirroredStateCheckpointCandidates'));
        assert.ok(!names.includes('getMirroredStateCheckpointCandidatesAfterAnchor'));
        const call = calls.find(c => c.name === 'getEarliestValidAnchorCheckpoint');
        assert.deepStrictEqual(versions(call), [0]);
        assert.deepStrictEqual(call.args.slice(1), ['DOGE', 'testnet', 155055]);
        assert.strictEqual(out, null);
    });

    it('a DOGE origin at blockIndex 157500 reads the anchor axis for version 0 and never the block_index read', async function () {
        const { db, calls } = recorder();
        const out = await selectCheckpoint(row('DOGE', 155055), ctxFor(db, 157500));
        const names = calls.map(c => c.name);
        assert.ok(names.includes('getEarliestValidAnchorCheckpointAfterAnchor'));
        assert.ok(!names.includes('getEarliestValidAnchorCheckpoint'));
        assert.ok(names.includes('getMirroredStateCheckpointCandidatesAfterAnchor'));
        assert.ok(!names.includes('getMirroredStateCheckpointCandidates'));
        const call = calls.find(c => c.name === 'getEarliestValidAnchorCheckpointAfterAnchor');
        assert.deepStrictEqual(versions(call), [0]);
        assert.deepStrictEqual(call.args.slice(1), ['DOGE', 'testnet', 155055]);
        assert.strictEqual(out, null);
    });

    it('every empty read returns null', async function () {
        for(const [chain, blockIndex] of [['BTC', 157500], ['DOGE', 157000], ['DOGE', 157500]]){
            const { db } = recorder();
            assert.strictEqual(await selectCheckpoint(row(chain, 155055), ctxFor(db, blockIndex)), null);
        }
    });

    it('a returned version 0 anchor row is picked with source anchor_actions', async function () {
        const anchor = { chain: 'BTC', network: 'testnet', block_index: 155060, checkpoint_seq: 155066,
                         snapshot_block: 155066, state_root: 'a'.repeat(64), state_root_version: 2, version: 0 };
        const { db } = recorder({ getEarliestValidAnchorCheckpoint: [anchor] });
        const out = await selectCheckpoint(row('BTC', 155055), ctxFor(db, 157500));
        assert.ok(out);
        assert.strictEqual(out.source, 'anchor_actions');
        assert.strictEqual(out.block_index, 155060);
        assert.strictEqual(out.checkpoint_seq, 155066);
    });
});
