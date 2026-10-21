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
 * selectCheckpoint reads anchor_actions sections [0, 3] at and above
 * BRIDGE_CHECKPOINT_V3_SECTION_ACTIVATION and version 0 alone below it, on both the
 * block_index axis (BTC origin) and the anchor axis (DOGE origin). The gate is read at
 * the settling chain's block through gate_registry activeAt.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const gates = require('../../../../src/consensus/gate_registry');
const { selectCheckpoint, V3_SECTION_KEY } = require('../../../../src/consensus/bridge_proof_client/checkpoint_source.js');

const ROW = { src_chain: 'BTC', network: 'regtest', snapshot_block: 100 };
const CP  = { chain: 'BTC', network: 'regtest', block_index: 105, checkpoint_seq: 4, snapshot_block: 105,
              state_root: 'a'.repeat(64), state_root_version: 1 };

function makeCtx(blockIndex){
    const calls = [];
    const rec = (name) => async (...args) => { calls.push({ name, args }); return [CP]; };
    return { calls, ctx: {
        network: 'regtest', coin: 'DOGE', blockIndex,
        indexerDb: {
            getEarliestValidAnchorCheckpoint:           rec('getEarliestValidAnchorCheckpoint'),
            getEarliestValidAnchorCheckpointAfterAnchor: rec('getEarliestValidAnchorCheckpointAfterAnchor'),
            getMirroredStateCheckpointCandidates:           async () => [],
            getMirroredStateCheckpointCandidatesAfterAnchor: async () => []
        } } };
}

// Arms the v3 gate at a height and leaves every other gate as registered.
function armV3At(height){
    const real = gates.activeAt;
    sinon.stub(gates, 'activeAt').callsFake((key, network, coin, blockIndex, extra) =>
        key === V3_SECTION_KEY ? blockIndex >= height : real.call(gates, key, network, coin, blockIndex, extra));
}

describe('selectCheckpoint v3 section pick @regression @tier1', function(){
    afterEach(() => sinon.restore());

    it('reads [0, 3] from anchor_actions at and above the flag day', async function(){
        armV3At(500);
        for(const bi of [500, 501]){
            const { ctx, calls } = makeCtx(bi);
            const picked = await selectCheckpoint(ROW, ctx);
            assert.strictEqual(picked.source, 'anchor_actions');
            assert.strictEqual(calls[0].name, 'getEarliestValidAnchorCheckpoint');
            assert.deepStrictEqual(calls[0].args[0], [0, 3]);
        }
    });

    it('reads version 0 alone below the flag day (negative control)', async function(){
        armV3At(500);
        const { ctx, calls } = makeCtx(499);
        await selectCheckpoint(ROW, ctx);
        assert.strictEqual(calls[0].args[0], 0);
    });

    it('applies the same list on the anchor axis for a DOGE origin, and only at the flag day', async function(){
        armV3At(500);
        const hi = makeCtx(500);
        await selectCheckpoint(Object.assign({}, ROW, { src_chain: 'DOGE' }), hi.ctx);
        assert.strictEqual(hi.calls[0].name, 'getEarliestValidAnchorCheckpointAfterAnchor');
        assert.deepStrictEqual(hi.calls[0].args[0], [0, 3]);
        const lo = makeCtx(499);
        await selectCheckpoint(Object.assign({}, ROW, { src_chain: 'DOGE' }), lo.ctx);
        assert.strictEqual(lo.calls[0].args[0], 0);
    });
});
