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
 * registry. A recording indexerDb answers every read with an empty array, so what is
 * pinned is which read is made and with which section version, not what it returns.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const { selectCheckpoint, ANCHOR_SECTION_VERSION } = require('../../../../src/consensus/bridge_proof_client/checkpoint_source.js');

const READS = [
    'getEarliestValidAnchorCheckpoint',
    'getEarliestValidAnchorCheckpointAfterAnchor',
    'getMirroredStateCheckpointCandidates',
    'getMirroredStateCheckpointCandidatesAfterAnchor'
];

const SNAPSHOT = 155055;

function recorder(anchorRows){
    const calls = [];
    const indexerDb = {};
    for(const name of READS){
        indexerDb[name] = sinon.stub().callsFake(async (...args) => {
            calls.push({ name, args });
            return (anchorRows && name.startsWith('getEarliestValid')) ? anchorRows : [];
        });
    }
    return { indexerDb, calls };
}

function ctxAt(indexerDb, blockIndex){
    return { indexerDb, coin: 'BTC', network: 'testnet', blockIndex };
}

function row(chain){
    return { src_chain: chain, network: 'testnet', snapshot_block: SNAPSHOT };
}

describe('selectCheckpoint section reads on testnet, baseline @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('pins ANCHOR_SECTION_VERSION to 0', function () {
        assert.strictEqual(ANCHOR_SECTION_VERSION, 0);
    });

    const CASES = [
        { title: 'a BTC-origin row at blockIndex 157500 reads the block_index axis', chain: 'BTC',  at: 157500, read: 'getEarliestValidAnchorCheckpoint',            other: 'getEarliestValidAnchorCheckpointAfterAnchor' },
        { title: 'a DOGE-origin row at blockIndex 157000, below the activation, reads the block_index axis', chain: 'DOGE', at: 157000, read: 'getEarliestValidAnchorCheckpoint',            other: 'getEarliestValidAnchorCheckpointAfterAnchor' },
        { title: 'a DOGE-origin row at blockIndex 157500 reads the anchor axis and never the block_index read', chain: 'DOGE', at: 157500, read: 'getEarliestValidAnchorCheckpointAfterAnchor', other: 'getEarliestValidAnchorCheckpoint' }
    ];

    for(const c of CASES){
        it(`${c.title}, binding exactly version 0`, async function () {
            const { indexerDb, calls } = recorder();
            const picked = await selectCheckpoint(row(c.chain), ctxAt(indexerDb, c.at));
            assert.strictEqual(picked, null);

            const sectionReads = calls.filter(x => x.name.startsWith('getEarliestValid'));
            assert.deepStrictEqual(sectionReads.map(x => x.name), [c.read]);
            assert.strictEqual(calls.filter(x => x.name === c.other).length, 0);

            const [version, chain, network, atOrAfter] = sectionReads[0].args;
            assert.deepStrictEqual([].concat(version), [0]);
            assert.strictEqual(chain, c.chain);
            assert.strictEqual(network, 'testnet');
            assert.strictEqual(atOrAfter, SNAPSHOT);
        });

        it(`${c.title}, with the mirrored read on the same axis`, async function () {
            const { indexerDb, calls } = recorder();
            await selectCheckpoint(row(c.chain), ctxAt(indexerDb, c.at));
            const mirrorName = c.read === 'getEarliestValidAnchorCheckpoint'
                ? 'getMirroredStateCheckpointCandidates'
                : 'getMirroredStateCheckpointCandidatesAfterAnchor';
            assert.deepStrictEqual(calls.filter(x => x.name.startsWith('getMirrored')).map(x => x.name), [mirrorName]);
            assert.deepStrictEqual(calls.find(x => x.name === mirrorName).args, [c.chain, 'testnet', SNAPSHOT]);
        });
    }

    it('returns null when every read is empty', async function () {
        for(const [chain, at] of [['BTC', 157500], ['DOGE', 157000], ['DOGE', 157500]]){
            const { indexerDb } = recorder();
            assert.strictEqual(await selectCheckpoint(row(chain), ctxAt(indexerDb, at)), null);
        }
    });

    it('picks a returned version 0 anchor row with source anchor_actions', async function () {
        const anchor = { chain: 'BTC', network: 'testnet', block_index: 155060, checkpoint_seq: 155066,
                         snapshot_block: 155066, state_root: 'b'.repeat(64), state_root_version: 2 };
        const { indexerDb } = recorder([anchor]);
        const picked = await selectCheckpoint(row('BTC'), ctxAt(indexerDb, 157500));
        assert.ok(picked);
        assert.strictEqual(picked.source, 'anchor_actions');
        assert.strictEqual(picked.block_index, 155060);
        assert.strictEqual(picked.checkpoint_seq, 155066);
    });
});
