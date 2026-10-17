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
 **********************************************************************/

'use strict';

const assert = require('assert');
const path = require('path');
const { loadLegacyRewardPins, isLegacyRewardPinned, loadDefaultPins } =
    require('../../../../src/consensus/anchor_reward_derive/legacy_reward_pins.js');

const FIXTURE = [
    { reward_type: 'anchor', round_reference: 'r1', snapshot_block: 100, publisher: 'pubA', txid: 'tx1' },
    { reward_type: 'trust', round_reference: 'r2', snapshot_block: 200, publisher: 'pubB', txid: 'tx2' }
];

describe('legacy_reward_pins', function(){
    it('answers true for a pinned tuple', function(){
        let pins = loadLegacyRewardPins(FIXTURE);
        assert.strictEqual(pins.size, 2);
        assert.strictEqual(pins.isPinned(FIXTURE[0]), true);
        assert.strictEqual(pins.isPinned(FIXTURE[1]), true);
    });

    it('matches numeric and string snapshot blocks alike', function(){
        let pins = loadLegacyRewardPins(FIXTURE);
        assert.strictEqual(pins.isPinned(Object.assign({}, FIXTURE[0], { snapshot_block: '100' })), true);
    });

    it('answers false when any single field differs', function(){
        let pins = loadLegacyRewardPins(FIXTURE);
        for(let field of ['reward_type', 'round_reference', 'snapshot_block', 'publisher', 'txid']){
            let changed = Object.assign({}, FIXTURE[0], { [field]: 'other' });
            assert.strictEqual(pins.isPinned(changed), false, field);
        }
    });

    it('answers false for incomplete or non-object tuples', function(){
        let pins = loadLegacyRewardPins(FIXTURE);
        assert.strictEqual(pins.isPinned({ reward_type: 'anchor' }), false);
        assert.strictEqual(pins.isPinned(null), false);
        assert.strictEqual(pins.isPinned(undefined), false);
    });

    it('does not collide across field boundaries', function(){
        let pins = loadLegacyRewardPins([
            { reward_type: 'a', round_reference: 'b|c', snapshot_block: 1, publisher: 'p', txid: 't' }
        ]);
        assert.strictEqual(pins.isPinned(
            { reward_type: 'a|b', round_reference: 'c', snapshot_block: 1, publisher: 'p', txid: 't' }), false);
        assert.strictEqual(pins.isPinned(
            { reward_type: 'a', round_reference: 'b|c', snapshot_block: 1, publisher: 'p', txid: 't' }), true);
    });

    it('supports the one-shot helper and an empty list', function(){
        assert.strictEqual(isLegacyRewardPinned(FIXTURE[1], FIXTURE), true);
        assert.strictEqual(isLegacyRewardPinned(FIXTURE[1], []), false);
    });

    it('rejects malformed pin lists', function(){
        assert.throws(() => loadLegacyRewardPins({}), TypeError);
        assert.throws(() => loadLegacyRewardPins([{ reward_type: 'anchor' }]), TypeError);
    });

    it('treats a missing default file as no pins', function(){
        assert.deepStrictEqual(loadDefaultPins(path.join(__dirname, 'no_such_pins.json')), []);
    });
});
