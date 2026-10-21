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
 * Baseline of the section reads selectCheckpoint makes on testnet today, against the real
 * gate registry. A recording indexerDb returns empty arrays, so each test names the read
 * that was made, its arguments and the single section version it binds.
 *
 * BTC origin: the block_index read. DOGE origin below the testnet anchor-match activation:
 * the same block_index read. DOGE origin at or above it: the anchor-axis read, and never the
 * block_index one.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const { ANCHOR_SECTION_VERSION, selectCheckpoint } =
    require('../../../../src/consensus/bridge_proof_client/checkpoint_source.js');

const NET = 'testnet';
const SNAP = 155055;

const READS = [
    'getEarliestValidAnchorCheckpoint',
    'getEarliestValidAnchorCheckpointAfterAnchor',
    'getMirroredStateCheckpointCandidates',
    'getMirroredStateCheckpointCandidatesAfterAnchor'
];

function recorder(overrides = {}){
    const calls = [];
    const indexerDb = {};
    for(const name of READS){
        indexerDb[name] = sinon.spy(async (...args) => {
            calls.push({ name, args });
            return overrides[name] ? overrides[name] : [];
        });
    }
    return { indexerDb, calls };
}

function ctxAt(indexerDb, blockIndex){
    return { indexerDb, coin: 'BTC', network: NET, blockIndex };
}

function row(srcChain){
    return { src_chain: srcChain, network: NET, snapshot_block: SNAP };
}

function names(calls){ return calls.map(c => c.name); }

describe('selectCheckpoint section reads on testnet before the section flag day @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('ANCHOR_SECTION_VERSION is 0', function () {
        assert.strictEqual(ANCHOR_SECTION_VERSION, 0);
    });

    it('a BTC-origin row at blockIndex 157500 reads the block_index axis', async function () {
        const { indexerDb, calls } = recorder();
        const out = await selectCheckpoint(row('BTC'), ctxAt(indexerDb, 157500));
        assert.strictEqual(out, null);
        assert.deepStrictEqual(names(calls), ['getEarliestValidAnchorCheckpoint', 'getMirroredStateCheckpointCandidates']);
        const [version, chain, network, snap] = calls[0].args;
        assert.deepStrictEqual([].concat(version), [0]);
        assert.strictEqual(chain, 'BTC');
        assert.strictEqual(network, 'testnet');
        assert.strictEqual(snap, SNAP);
        assert.deepStrictEqual(calls[1].args, ['BTC', 'testnet', SNAP]);
    });

    it('a DOGE-origin row at blockIndex 157000, below the anchor-match activation, reads the block_index axis', async function () {
        const { indexerDb, calls } = recorder();
        const out = await selectCheckpoint(row('DOGE'), ctxAt(indexerDb, 157000));
        assert.strictEqual(out, null);
        assert.deepStrictEqual(names(calls), ['getEarliestValidAnchorCheckpoint', 'getMirroredStateCheckpointCandidates']);
        const [version, chain, network, snap] = calls[0].args;
        assert.deepStrictEqual([].concat(version), [0]);
        assert.strictEqual(chain, 'DOGE');
        assert.strictEqual(network, 'testnet');
        assert.strictEqual(snap, SNAP);
        assert.deepStrictEqual(calls[1].args, ['DOGE', 'testnet', SNAP]);
    });

    it('a DOGE-origin row at blockIndex 157500 reads the anchor axis and never the block_index read', async function () {
        const { indexerDb, calls } = recorder();
        const out = await selectCheckpoint(row('DOGE'), ctxAt(indexerDb, 157500));
        assert.strictEqual(out, null);
        assert.deepStrictEqual(names(calls),
            ['getEarliestValidAnchorCheckpointAfterAnchor', 'getMirroredStateCheckpointCandidatesAfterAnchor']);
        assert.ok(!names(calls).includes('getEarliestValidAnchorCheckpoint'));
        assert.ok(!names(calls).includes('getMirroredStateCheckpointCandidates'));
        const [version, chain, network, snap] = calls[0].args;
        assert.deepStrictEqual([].concat(version), [0]);
        assert.strictEqual(chain, 'DOGE');
        assert.strictEqual(network, 'testnet');
        assert.strictEqual(snap, SNAP);
        assert.deepStrictEqual(calls[1].args, ['DOGE', 'testnet', SNAP]);
    });

    for(const [label, chain, blockIndex] of [['BTC', 'BTC', 157500], ['DOGE below', 'DOGE', 157000], ['DOGE above', 'DOGE', 157500]]){
        it(`every empty read returns null (${label})`, async function () {
            const { indexerDb } = recorder();
            assert.strictEqual(await selectCheckpoint(row(chain), ctxAt(indexerDb, blockIndex)), null);
        });
    }

    it('a returned version 0 anchor row is picked with source anchor_actions', async function () {
        const anchor = { chain: 'BTC', network: NET, block_index: 155060, checkpoint_seq: 155062,
                         snapshot_block: 155062, state_root: 'a'.repeat(64), state_root_version: 2 };
        const { indexerDb, calls } = recorder({ getEarliestValidAnchorCheckpoint: [anchor] });
        const out = await selectCheckpoint(row('BTC'), ctxAt(indexerDb, 157500));
        assert.deepStrictEqual([].concat(calls[0].args[0]), [0]);
        assert.deepStrictEqual(out, { chain: 'BTC', network: NET, block_index: 155060, checkpoint_seq: 155062,
                                      snapshot_block: 155062, state_root: 'a'.repeat(64), state_root_version: 2,
                                      source: 'anchor_actions' });
    });
});
