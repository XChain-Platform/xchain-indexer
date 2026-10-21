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
 * test/unit/consensus/bridge_proof_client/checkpoint_v3_section_pick.test.js
 *
 * selectCheckpoint reads the anchor_actions section versions [0, 3] at and above
 * BRIDGE_CHECKPOINT_V3_SECTION_ACTIVATION (activeAt at the settling block) and version 0
 * alone below it, on both the block_index axis and the anchor axis.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const CS     = require('../../../../src/consensus/bridge_proof_client/checkpoint_source.js');
const { stubGate } = require('../../../helpers/gate_modules.js');

const ROW = { src_chain: 'DOGE', network: 'regtest', snapshot_block: 100 };

function ctxWith(){
    const calls = [];
    const indexerDb = {
        getEarliestValidAnchorCheckpoint:           async (...a) => { calls.push(['block_index', ...a]); return []; },
        getEarliestValidAnchorCheckpointAfterAnchor: async (...a) => { calls.push(['anchor', ...a]); return []; },
        getMirroredStateCheckpointCandidates:           async () => [],
        getMirroredStateCheckpointCandidatesAfterAnchor: async () => []
    };
    return { calls, ctx: { indexerDb, coin: 'DOGE', network: 'regtest', blockIndex: 500 } };
}

describe('selectCheckpoint v3 section versions @regression @tier1', function () {
    afterEach(() => sinon.restore());

    function arm(v3, anchor){
        stubGate(sinon, CS.V3_SECTION_KEY, v3);
        stubGate(sinon, 'bridge_escrow_anchor_match_activation.BRIDGE_ESCROW_ANCHOR_MATCH_ACTIVATION', anchor);
    }

    it('reads [0, 3] on the block_index axis when the gate is active', async function () {
        arm(true, false);
        const { calls, ctx } = ctxWith();
        assert.strictEqual(await CS.selectCheckpoint(ROW, ctx), null);
        assert.deepStrictEqual(calls, [['block_index', [0, 3], 'DOGE', 'regtest', 100]]);
    });

    it('reads [0, 3] on the anchor axis when the gate is active', async function () {
        arm(true, true);
        const { calls, ctx } = ctxWith();
        await CS.selectCheckpoint(ROW, ctx);
        assert.deepStrictEqual(calls, [['anchor', [0, 3], 'DOGE', 'regtest', 100]]);
    });

    it('reads version 0 alone below the gate, on both axes', async function () {
        for (const anchor of [false, true]) {
            sinon.restore();
            arm(false, anchor);
            const { calls, ctx } = ctxWith();
            await CS.selectCheckpoint(ROW, ctx);
            assert.deepStrictEqual(calls, [[anchor ? 'anchor' : 'block_index', 0, 'DOGE', 'regtest', 100]]);
        }
    });

    it('tags a v3 section candidate with the anchor_actions source', async function () {
        arm(true, false);
        const { ctx } = ctxWith();
        ctx.indexerDb.getEarliestValidAnchorCheckpoint = async () => [{
            chain: 'DOGE', network: 'regtest', block_index: 101, checkpoint_seq: 4, snapshot_block: 105,
            state_root: 'aa', state_root_version: 1 }];
        const got = await CS.selectCheckpoint(ROW, ctx);
        assert.strictEqual(got.source, 'anchor_actions');
        assert.strictEqual(got.checkpoint_seq, 4);
    });
});
