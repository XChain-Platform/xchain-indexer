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
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const {
    ANCHOR_SECTION_VERSION,
    selectCheckpoint,
} = require('../../../../src/consensus/bridge_proof_client/checkpoint_source.js');

const NETWORK = 'testnet';
const SNAPSHOT_BLOCK = 155055;

function transfer(srcChain) {
    return { src_chain: srcChain, network: NETWORK, snapshot_block: SNAPSHOT_BLOCK };
}

function selectionContext(blockIndex) {
    return {
        coin: 'BTC',
        network: NETWORK,
        blockIndex,
        indexerDb: {
            getEarliestValidAnchorCheckpoint: sinon.stub().resolves([]),
            getEarliestValidAnchorCheckpointAfterAnchor: sinon.stub().resolves([]),
            getMirroredStateCheckpointCandidates: sinon.stub().resolves([]),
            getMirroredStateCheckpointCandidatesAfterAnchor: sinon.stub().resolves([]),
        },
    };
}

function assertVersionZero(call) {
    assert.deepStrictEqual([].concat(call.args[0]), [0]);
}

function assertBlockIndexReads(ctx, chain) {
    const db = ctx.indexerDb;
    assert.strictEqual(db.getEarliestValidAnchorCheckpoint.callCount, 1);
    assertVersionZero(db.getEarliestValidAnchorCheckpoint.firstCall);
    assert.deepStrictEqual(db.getEarliestValidAnchorCheckpoint.firstCall.args.slice(1),
        [chain, NETWORK, SNAPSHOT_BLOCK]);
    assert.strictEqual(db.getMirroredStateCheckpointCandidates.callCount, 1);
    assert.deepStrictEqual(db.getMirroredStateCheckpointCandidates.firstCall.args,
        [chain, NETWORK, SNAPSHOT_BLOCK]);
    assert.strictEqual(db.getEarliestValidAnchorCheckpointAfterAnchor.callCount, 0);
    assert.strictEqual(db.getMirroredStateCheckpointCandidatesAfterAnchor.callCount, 0);
}

function assertAnchorReads(ctx, chain) {
    const db = ctx.indexerDb;
    assert.strictEqual(db.getEarliestValidAnchorCheckpointAfterAnchor.callCount, 1);
    assertVersionZero(db.getEarliestValidAnchorCheckpointAfterAnchor.firstCall);
    assert.deepStrictEqual(db.getEarliestValidAnchorCheckpointAfterAnchor.firstCall.args.slice(1),
        [chain, NETWORK, SNAPSHOT_BLOCK]);
    assert.strictEqual(db.getMirroredStateCheckpointCandidatesAfterAnchor.callCount, 1);
    assert.deepStrictEqual(db.getMirroredStateCheckpointCandidatesAfterAnchor.firstCall.args,
        [chain, NETWORK, SNAPSHOT_BLOCK]);
    assert.strictEqual(db.getEarliestValidAnchorCheckpoint.callCount, 0);
    assert.strictEqual(db.getMirroredStateCheckpointCandidates.callCount, 0);
}

describe('selectCheckpoint section-pick baseline on testnet @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('keeps ANCHOR_SECTION_VERSION at version 0', function () {
        assert.strictEqual(ANCHOR_SECTION_VERSION, 0);
    });

    it('uses block_index reads for a BTC-origin row above the anchor-match activation', async function () {
        const ctx = selectionContext(157500);
        assert.strictEqual(await selectCheckpoint(transfer('BTC'), ctx), null);
        assertBlockIndexReads(ctx, 'BTC');
    });

    it('uses block_index reads for a DOGE-origin row below the anchor-match activation', async function () {
        const ctx = selectionContext(157000);
        assert.strictEqual(await selectCheckpoint(transfer('DOGE'), ctx), null);
        assertBlockIndexReads(ctx, 'DOGE');
    });

    it('uses anchor reads for a DOGE-origin row above the anchor-match activation', async function () {
        const ctx = selectionContext(157500);
        assert.strictEqual(await selectCheckpoint(transfer('DOGE'), ctx), null);
        assertAnchorReads(ctx, 'DOGE');
    });

    it('picks a returned version 0 anchor row with source anchor_actions', async function () {
        const ctx = selectionContext(157500);
        const anchor = {
            version: 0,
            chain: 'DOGE',
            network: NETWORK,
            block_index: 67964142,
            checkpoint_seq: 155056,
            snapshot_block: 155056,
            state_root: 'a'.repeat(64),
            state_root_version: 2,
        };
        ctx.indexerDb.getEarliestValidAnchorCheckpointAfterAnchor.resolves([anchor]);

        const picked = await selectCheckpoint(transfer('DOGE'), ctx);

        assertAnchorReads(ctx, 'DOGE');
        assert.strictEqual(anchor.version, 0);
        assert.strictEqual(picked.source, 'anchor_actions');
        assert.strictEqual(picked.block_index, anchor.block_index);
        assert.strictEqual(picked.snapshot_block, anchor.snapshot_block);
    });
});
