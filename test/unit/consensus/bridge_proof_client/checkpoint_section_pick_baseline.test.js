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
 * Pins which section reads selectCheckpoint makes on testnet today, against the real gate
 * registry. A recording indexerDb returns empty arrays, so each test reads back the call
 * made, not a pick. Any later gate on the section version must stay below its flag day here.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'testnet';

const assert = require('assert');
const sinon  = require('sinon');

const { selectCheckpoint, ANCHOR_SECTION_VERSION } = require('../../../../src/consensus/bridge_proof_client/checkpoint_source');

const READS = [
    'getEarliestValidAnchorCheckpoint',
    'getEarliestValidAnchorCheckpointAfterAnchor',
    'getMirroredStateCheckpointCandidates',
    'getMirroredStateCheckpointCandidatesAfterAnchor'
];

function recordingDb(overrides = {}) {
    const calls = {};
    const db = {};
    for (const name of READS) {
        calls[name] = [];
        db[name] = sinon.stub().callsFake(async (...args) => {
            calls[name].push(args);
            return overrides[name] ? overrides[name] : [];
        });
    }
    return { db, calls };
}

const ctxAt = (db, blockIndex) => ({ indexerDb: db, network: 'testnet', coin: 'BTC', blockIndex });
const rowFor = (chain) => ({ src_chain: chain, network: 'testnet', snapshot_block: 157100 });

describe('selectCheckpoint section reads on testnet @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('reads section version 0 only', function () {
        assert.strictEqual(ANCHOR_SECTION_VERSION, 0);
    });

    it('BTC origin at blockIndex 157500 reads the block_index axis', async function () {
        const { db, calls } = recordingDb();
        const picked = await selectCheckpoint(rowFor('BTC'), ctxAt(db, 157500));
        assert.strictEqual(picked, null);
        assert.strictEqual(calls.getEarliestValidAnchorCheckpoint.length, 1);
        const [version, chain, network, snapshot] = calls.getEarliestValidAnchorCheckpoint[0];
        assert.deepStrictEqual([].concat(version), [0]);
        assert.strictEqual(chain, 'BTC');
        assert.strictEqual(network, 'testnet');
        assert.strictEqual(snapshot, 157100);
        assert.strictEqual(calls.getEarliestValidAnchorCheckpointAfterAnchor.length, 0);
        assert.strictEqual(calls.getMirroredStateCheckpointCandidates.length, 1);
        assert.strictEqual(calls.getMirroredStateCheckpointCandidatesAfterAnchor.length, 0);
    });

    it('DOGE origin at blockIndex 157000, below the anchor-match activation, reads the block_index axis', async function () {
        const { db, calls } = recordingDb();
        const picked = await selectCheckpoint(rowFor('DOGE'), ctxAt(db, 157000));
        assert.strictEqual(picked, null);
        assert.strictEqual(calls.getEarliestValidAnchorCheckpoint.length, 1);
        const [version, chain, network, snapshot] = calls.getEarliestValidAnchorCheckpoint[0];
        assert.deepStrictEqual([].concat(version), [0]);
        assert.strictEqual(chain, 'DOGE');
        assert.strictEqual(network, 'testnet');
        assert.strictEqual(snapshot, 157100);
        assert.strictEqual(calls.getEarliestValidAnchorCheckpointAfterAnchor.length, 0);
        assert.strictEqual(calls.getMirroredStateCheckpointCandidates.length, 1);
        assert.strictEqual(calls.getMirroredStateCheckpointCandidatesAfterAnchor.length, 0);
    });

    it('DOGE origin at blockIndex 157500 reads the anchor axis and never the block_index read', async function () {
        const { db, calls } = recordingDb();
        const picked = await selectCheckpoint(rowFor('DOGE'), ctxAt(db, 157500));
        assert.strictEqual(picked, null);
        assert.strictEqual(calls.getEarliestValidAnchorCheckpointAfterAnchor.length, 1);
        const [version, chain, network, snapshot] = calls.getEarliestValidAnchorCheckpointAfterAnchor[0];
        assert.deepStrictEqual([].concat(version), [0]);
        assert.strictEqual(chain, 'DOGE');
        assert.strictEqual(network, 'testnet');
        assert.strictEqual(snapshot, 157100);
        assert.strictEqual(calls.getEarliestValidAnchorCheckpoint.length, 0);
        assert.strictEqual(calls.getMirroredStateCheckpointCandidates.length, 0);
        assert.strictEqual(calls.getMirroredStateCheckpointCandidatesAfterAnchor.length, 1);
    });

    it('every empty read returns null', async function () {
        for (const [chain, blockIndex] of [['BTC', 157500], ['DOGE', 157000], ['DOGE', 157500]]) {
            const { db } = recordingDb();
            assert.strictEqual(await selectCheckpoint(rowFor(chain), ctxAt(db, blockIndex)), null);
        }
    });

    it('picks a returned version 0 anchor row with source anchor_actions', async function () {
        const anchor = { chain: 'BTC', network: 'testnet', block_index: 157200, checkpoint_seq: 4,
                         snapshot_block: 157150, state_root: 'ab'.repeat(32), state_root_version: 1 };
        const { db } = recordingDb({ getEarliestValidAnchorCheckpoint: [anchor] });
        const picked = await selectCheckpoint(rowFor('BTC'), ctxAt(db, 157500));
        assert.strictEqual(picked.source, 'anchor_actions');
        assert.strictEqual(picked.block_index, 157200);
        assert.strictEqual(picked.checkpoint_seq, 4);
    });
});
