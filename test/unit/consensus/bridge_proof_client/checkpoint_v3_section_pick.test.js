/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/consensus/bridge_proof_client/checkpoint_v3_section_pick.test.js
 *
 * After the archive fold a chain publishes its checkpoint sections as ANCHOR v3, so a
 * node with no mirrored state_checkpoints copy finds no v0 section and stalls every
 * bridge transfer. selectCheckpoint admits v3 sections from their own flag day, read at
 * the processing block. Here the mirror is empty and the only valid chain row is a v3
 * section: with the gate active the pick returns it from anchor_actions on both the
 * block_index axis (BTC origin) and the anchor-match axis (DOGE origin), and with the
 * gate inactive it returns null, which is today's stall.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const { selectCheckpoint, V3_SECTION_KEY } = require('../../../../src/consensus/bridge_proof_client/checkpoint_source.js');
const { ANCHOR_MATCH_KEY } = require('../../../../src/consensus/bridge_checkpoint_check/anchor_match.js');
const { stubActiveAt } = require('../../../helpers/gate_modules.js');

const NET = 'testnet';
const BLOCK = 157500;
const SNAP = 155055;

// One valid v3 section on the origin chain, the only checkpoint this node holds.
function v3Row(chain){
    return { chain, network: NET, block_index: SNAP + 10, checkpoint_seq: SNAP + 10, snapshot_block: SNAP + 10,
             state_root: 'b'.repeat(64), state_root_version: 2, version: 3 };
}

// The two anchor reads answer the v3 row only when their version list admits 3, as the
// SQL's a.version IN (...) would; the mirrored reads are empty.
function stubDb(chain){
    const reads = [];
    const anchorRead = name => async (versions, c, network, bound) => {
        reads.push({ name, versions: [].concat(versions), chain: c, network, bound });
        return [].concat(versions).includes(3) && c === chain ? [v3Row(chain)] : [];
    };
    return {
        reads,
        getEarliestValidAnchorCheckpoint:                anchorRead('getEarliestValidAnchorCheckpoint'),
        getEarliestValidAnchorCheckpointAfterAnchor:     anchorRead('getEarliestValidAnchorCheckpointAfterAnchor'),
        getMirroredStateCheckpointCandidates:            async () => [],
        getMirroredStateCheckpointCandidatesAfterAnchor: async () => [],
    };
}

function transfer(srcChain){
    return { transfer_id: 'ab'.repeat(32), snapshot_block: SNAP, network: NET, src_chain: srcChain,
             dest_chain: 'BTC', tick: 'T', decimals: 0, amount: '1' };
}

// Stub activeAt for the v3 section gate and the anchor-match gate; every other key reads
// the real registry. Returns the stub so a test can read the arguments each gate saw.
function gates(v3, anchorMatch){
    const stub = stubActiveAt(sinon, V3_SECTION_KEY, v3);
    stub.withArgs(ANCHOR_MATCH_KEY).returns(anchorMatch);
    return stub;
}

describe('selectCheckpoint reads ANCHOR v3 checkpoint sections from their flag day @regression @tier1', function(){
    afterEach(() => sinon.restore());

    const PATHS = [
        { axis: 'block_index', origin: 'BTC',  anchorMatch: false, read: 'getEarliestValidAnchorCheckpoint' },
        { axis: 'anchor-match', origin: 'DOGE', anchorMatch: true,  read: 'getEarliestValidAnchorCheckpointAfterAnchor' },
    ];

    for(const { axis, origin, anchorMatch, read } of PATHS){
        it(`returns the v3 section from anchor_actions on the ${axis} path with the gate active`, async function(){
            const stub = gates(true, anchorMatch);
            const db = stubDb(origin);
            const ctx = { indexerDb: db, coin: 'BTC', network: NET, blockIndex: BLOCK };
            const pick = await selectCheckpoint(transfer(origin), ctx);
            assert.ok(pick, 'the gate active picks the v3 section');
            assert.strictEqual(pick.source, 'anchor_actions');
            assert.strictEqual(pick.chain, origin);
            assert.strictEqual(pick.block_index, SNAP + 10);
            assert.strictEqual(pick.checkpoint_seq, SNAP + 10);
            assert.strictEqual(pick.state_root, 'b'.repeat(64));
            assert.deepStrictEqual(db.reads.map(r => r.name), [read]);
            assert.deepStrictEqual(db.reads[0].versions, [0, 3]);
            assert.ok(stub.calledWith(V3_SECTION_KEY, NET, 'BTC', BLOCK), 'the gate is read at the processing block');
        });

        it(`returns null on the ${axis} path with the gate inactive, reading v0 only`, async function(){
            gates(false, anchorMatch);
            const db = stubDb(origin);
            const ctx = { indexerDb: db, coin: 'BTC', network: NET, blockIndex: BLOCK };
            assert.strictEqual(await selectCheckpoint(transfer(origin), ctx), null);
            assert.deepStrictEqual(db.reads.map(r => r.name), [read]);
            assert.deepStrictEqual(db.reads[0].versions, [0]);
        });
    }

    it('ships the gate unarmed on testnet and mainnet and active from genesis on regtest', function(){
        const gateRegistry = require('../../../../src/consensus/gate_registry');
        assert.strictEqual(gateRegistry.activeAt(V3_SECTION_KEY, 'mainnet', 'BTC', 99999999, null), false);
        // Armed on testnet by the arming patch at BTC 157295, LTC 4931000 and DOGE 68015000.
        assert.strictEqual(gateRegistry.activeAt(V3_SECTION_KEY, 'testnet', 'BTC', 157294, null), false);
        assert.strictEqual(gateRegistry.activeAt(V3_SECTION_KEY, 'testnet', 'BTC', 157295, null), true);
        assert.strictEqual(gateRegistry.activeAt(V3_SECTION_KEY, 'testnet', 'DOGE', 68014999, null), false);
        assert.strictEqual(gateRegistry.activeAt(V3_SECTION_KEY, 'regtest', 'BTC', 0, null), true);
    });
});
