/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/consensus/bridge_proof_client/checkpoint_section_pick_baseline.test.js
 *
 * Pins the section reads selectCheckpoint makes today on testnet, against the real gate
 * registry. A recording indexerDb returns empty arrays for all four checkpoint reads, so
 * what is asserted is which read is made and what it is bound to, not a pick.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const { ANCHOR_SECTION_VERSION, selectCheckpoint } = require('../../../../src/consensus/bridge_proof_client/checkpoint_source.js');

const NET  = 'testnet';
const SNAP = 155055;

const READS = [
    'getEarliestValidAnchorCheckpoint',
    'getEarliestValidAnchorCheckpointAfterAnchor',
    'getMirroredStateCheckpointCandidates',
    'getMirroredStateCheckpointCandidatesAfterAnchor'
];

function recorder(rows) {
    const calls = [];
    const db = {};
    for (const name of READS) {
        db[name] = async (...args) => {
            calls.push({ name, args });
            return (rows && rows[name]) || [];
        };
    }
    return { db, calls };
}

function row(chain) {
    return { src_chain: chain, network: NET, snapshot_block: SNAP };
}

function ctxFor(db, blockIndex) {
    return { indexerDb: db, coin: 'BTC', network: NET, blockIndex };
}

function anchorReads(calls) {
    return calls.filter(c => c.name.startsWith('getEarliestValidAnchorCheckpoint'));
}

describe('selectCheckpoint section reads on testnet @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('ANCHOR_SECTION_VERSION is 0', function () {
        assert.strictEqual(ANCHOR_SECTION_VERSION, 0);
    });

    it('a BTC-origin row at 157500 reads the block_index axis for version 0', async function () {
        const { db, calls } = recorder();
        const out = await selectCheckpoint(row('BTC'), ctxFor(db, 157500));
        const reads = anchorReads(calls);
        assert.strictEqual(reads.length, 1);
        assert.strictEqual(reads[0].name, 'getEarliestValidAnchorCheckpoint');
        assert.deepStrictEqual([].concat(reads[0].args[0]), [0]);
        assert.deepStrictEqual(reads[0].args.slice(1), ['BTC', NET, SNAP]);
        assert.deepStrictEqual(calls.map(c => c.name).sort(),
            ['getEarliestValidAnchorCheckpoint', 'getMirroredStateCheckpointCandidates']);
        assert.strictEqual(out, null);
    });

    it('a DOGE-origin row at 157000, below the anchor-match activation, reads the block_index axis', async function () {
        const { db, calls } = recorder();
        const out = await selectCheckpoint(row('DOGE'), ctxFor(db, 157000));
        const reads = anchorReads(calls);
        assert.strictEqual(reads.length, 1);
        assert.strictEqual(reads[0].name, 'getEarliestValidAnchorCheckpoint');
        assert.deepStrictEqual([].concat(reads[0].args[0]), [0]);
        assert.deepStrictEqual(reads[0].args.slice(1), ['DOGE', NET, SNAP]);
        assert.deepStrictEqual(calls.map(c => c.name).sort(),
            ['getEarliestValidAnchorCheckpoint', 'getMirroredStateCheckpointCandidates']);
        assert.strictEqual(out, null);
    });

    it('a DOGE-origin row at 157500 reads the anchor axis and never the block_index read', async function () {
        const { db, calls } = recorder();
        const out = await selectCheckpoint(row('DOGE'), ctxFor(db, 157500));
        const reads = anchorReads(calls);
        assert.strictEqual(reads.length, 1);
        assert.strictEqual(reads[0].name, 'getEarliestValidAnchorCheckpointAfterAnchor');
        assert.deepStrictEqual([].concat(reads[0].args[0]), [0]);
        assert.deepStrictEqual(reads[0].args.slice(1), ['DOGE', NET, SNAP]);
        assert.ok(!calls.some(c => c.name === 'getEarliestValidAnchorCheckpoint'));
        assert.deepStrictEqual(calls.map(c => c.name).sort(),
            ['getEarliestValidAnchorCheckpointAfterAnchor', 'getMirroredStateCheckpointCandidatesAfterAnchor']);
        assert.strictEqual(out, null);
    });

    it('every empty read returns null', async function () {
        for (const [chain, blockIndex] of [['BTC', 157500], ['DOGE', 157000], ['DOGE', 157500]]) {
            const { db } = recorder();
            assert.strictEqual(await selectCheckpoint(row(chain), ctxFor(db, blockIndex)), null);
        }
    });

    it('a returned version 0 anchor row is picked with source anchor_actions', async function () {
        const anchor = { chain: 'BTC', network: NET, block_index: 157400, checkpoint_seq: 157400,
                         snapshot_block: 157400, state_root: 'a'.repeat(64), state_root_version: 2 };
        const { db } = recorder({ getEarliestValidAnchorCheckpoint: [anchor] });
        const out = await selectCheckpoint(row('BTC'), ctxFor(db, 157500));
        assert.ok(out);
        assert.strictEqual(out.source, 'anchor_actions');
        assert.strictEqual(out.block_index, 157400);
        assert.strictEqual(out.checkpoint_seq, 157400);
    });
});
