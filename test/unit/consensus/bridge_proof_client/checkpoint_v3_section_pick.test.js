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
 * selectCheckpoint binds the anchor_actions section versions [0, 3] from
 * BRIDGE_CHECKPOINT_V3_SECTION_ACTIVATION (read through gate_registry activeAt at the settling
 * chain's block) and the single version 0 below it, on both the block_index read and the
 * getEarliestValidAnchorCheckpointAfterAnchor read.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const PC     = require('../../../../src/consensus/bridge_proof_client.js');
const SRC    = require('../../../../src/consensus/bridge_proof_client/checkpoint_source.js');
const { ANCHOR_MATCH_KEY } = require('../../../../src/consensus/bridge_checkpoint_check/anchor_match.js');
const { stubGate } = require('../../../helpers/gate_modules.js');

const KEY = 'bridge_checkpoint_v3_section_activation.BRIDGE_CHECKPOINT_V3_SECTION_ACTIVATION';
const NET = 'testnet';
const ROW = (chain) => ({ src_chain: chain, network: NET, snapshot_block: 500 });
const CP  = { chain: 'BTC', network: NET, block_index: 510, checkpoint_seq: 7, snapshot_block: 516,
              state_root: 'a'.repeat(64), state_root_version: 2 };

function ctxWith(){
    const seen = {};
    const db = {
        getEarliestValidAnchorCheckpoint: async (v) => { seen.block = v; return [CP]; },
        getEarliestValidAnchorCheckpointAfterAnchor: async (v) => { seen.anchor = v; return [CP]; },
        getMirroredStateCheckpointCandidates: async () => [],
        getMirroredStateCheckpointCandidatesAfterAnchor: async () => [],
    };
    return { seen, ctx: { indexerDb: db, coin: 'BTC', network: NET, blockIndex: 900 } };
}

describe('selectCheckpoint reads v3 sections from the flag day @regression @tier1', function(){
    afterEach(() => sinon.restore());

    it('binds [0, 3] on the block_index read at and above the gate', async function(){
        const gate = stubGate(sinon, KEY, true);
        stubGate(sinon, ANCHOR_MATCH_KEY, false);
        const { seen, ctx } = ctxWith();
        const out = await PC.selectCheckpoint(ROW('BTC'), ctx);
        assert.deepStrictEqual(seen.block, [0, 3]);
        assert.strictEqual(out.source, 'anchor_actions');
        assert.ok(gate.calledWith(NET, 'BTC', 900, null), 'activeAt is read at the settling block');
    });

    it('binds only version 0 below the gate', async function(){
        stubGate(sinon, KEY, false);
        stubGate(sinon, ANCHOR_MATCH_KEY, false);
        const { seen, ctx } = ctxWith();
        await PC.selectCheckpoint(ROW('BTC'), ctx);
        assert.strictEqual(seen.block, 0);
    });

    it('binds [0, 3] on the anchor-axis read for a DOGE origin above the gate', async function(){
        stubGate(sinon, KEY, true);
        stubGate(sinon, ANCHOR_MATCH_KEY, true);
        const { seen, ctx } = ctxWith();
        await PC.selectCheckpoint(ROW('DOGE'), ctx);
        assert.deepStrictEqual(seen.anchor, [0, 3]);
        assert.strictEqual(seen.block, undefined);
    });

    it('keeps the single-version anchor-axis read below the gate', async function(){
        stubGate(sinon, KEY, false);
        stubGate(sinon, ANCHOR_MATCH_KEY, true);
        const { seen, ctx } = ctxWith();
        await PC.selectCheckpoint(ROW('DOGE'), ctx);
        assert.strictEqual(seen.anchor, 0);
    });

    it('ships unarmed on mainnet and testnet and armed on regtest from genesis', function(){
        const gates = require('../../../../src/consensus/gate_registry');
        sinon.restore();
        assert.strictEqual(gates.activeAt(KEY, 'mainnet', 'BTC', 99999999, null), false);
        assert.strictEqual(gates.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
        assert.strictEqual(SRC.sectionVersions({ coin: 'BTC', network: 'regtest', blockIndex: 0 }).length, 2);
    });
});
