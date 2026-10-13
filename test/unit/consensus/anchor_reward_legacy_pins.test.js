'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const { mintProvenRow } = require('../../../src/consensus/anchor_reward_derive/mint_row.js');
const CHANGES = require('../../../src/protocol_changes/changes_5.js');

const ROW = { reward_type: 'anchor_bundle', round_reference: 10, snapshot_block: 10,
    publisher: 'AB', doge_anchor_txid: 'tx1', network: 'testnet' };
const PINS = [{ reward_type: 'anchor_bundle', round_reference: 10, snapshot_block: 10, publisher: 'ab', txid: 'tx1' }];

function db(){
    let calls = [];
    return { calls, createValidatorReward(...a){ calls.push(a); return { id: 1 }; } };
}
const proof = { proveMined: async () => 'verified' };

describe('LEGACY_ANCHOR_REWARD_PIN', function(){
    it('is declared unarmed on every network', function(){
        let row = CHANGES.find((c) => c[0] === 'LEGACY_ANCHOR_REWARD_PIN');
        assert.ok(row);
        assert.strictEqual(row[2], row[3]);
        assert.strictEqual(row[2], require('../../../src/protocol_changes/core.js').UNARMED);
    });
    it('mints a pinned tuple while the gate is off', async function(){
        let d = db();
        let r = await mintProvenRow(d, ROW, { blockIndex: 20, proof, minConfirmations: 1, amount: 5, legacyRewardPins: PINS });
        assert.ok(r);
        assert.strictEqual(d.calls.length, 1);
    });
    it('skips a pinned tuple once the gate is on', async function(){
        let d = db();
        let r = await mintProvenRow(d, ROW, { blockIndex: 20, proof, minConfirmations: 1, amount: 5,
            legacyAnchorRewardPin: true, legacyRewardPins: PINS });
        assert.strictEqual(r, false);
        assert.strictEqual(d.calls.length, 0);
    });
    it('mints an unpinned tuple with the gate on', async function(){
        let d = db();
        let r = await mintProvenRow(d, ROW, { blockIndex: 20, proof, minConfirmations: 1, amount: 5,
            legacyAnchorRewardPin: true, legacyRewardPins: [] });
        assert.ok(r);
        assert.strictEqual(d.calls.length, 1);
    });
    it('evaluates the gate through protocolChanges at the deriving block', async function(){
        let seen = [];
        let pc = { isEnabled: async (name, block) => { seen.push([name, block]); return block >= 20; } };
        let d = db();
        let r = await mintProvenRow(d, ROW, { blockIndex: 19, proof, minConfirmations: 1, amount: 5,
            protocolChanges: pc, legacyRewardPins: PINS });
        assert.ok(r);
        let r2 = await mintProvenRow(d, ROW, { blockIndex: 20, proof, minConfirmations: 1, amount: 5,
            protocolChanges: pc, legacyRewardPins: PINS });
        assert.strictEqual(r2, false);
        assert.strictEqual(d.calls.length, 1);
        assert.deepStrictEqual(seen, [['LEGACY_ANCHOR_REWARD_PIN', 19], ['LEGACY_ANCHOR_REWARD_PIN', 20]]);
    });
});
