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
 * test/unit/state_subtree_activation.test/state_root_reserved_sub_trees_armed_set.test.js
 *
 * Sibling block of the state_subtree_activation.test.js suite, carrying one
 * vector of:
 *   state_root reserved sub-trees: gate is inert EXCEPT the armed set @regression
 *
 * The exact-armed-set pin, moved out of state_root_reserved_sub_trees.test.js so
 * that describe stays under the function-length limit. It only reads the
 * activation maps, so it carries none of the scratch-arm snapshots or the
 * as-found net the mutating parts keep. The block repeats its parent describe
 * title, so the full test titles are the ones the entry collected before the
 * split.
 */
'use strict';

const assert = require('assert');
const SUB = require('../../../src/consensus/gates/state_subtree_gate.js');

describe('state_root reserved sub-trees: gate is inert EXCEPT the armed set @regression', function(){

    it('the activation maps hold EXACTLY the armed set (arming is a code change, not config)', function(){
        assert.deepStrictEqual(SUB.STATE_SUBTREE_ACTIVATION.ownership_root, {});
        assert.deepStrictEqual(SUB.STATE_SUBTREE_ACTIVATION.tokens_root, {});
        // All three testnet chains armed at genesis 2026-08-20. BTC:testnet's 146500
        // was left inert by the 2026-08-10 re-genesis; LTC and DOGE had no entry.
        assert.deepStrictEqual(SUB.STATE_SUBTREE_ACTIVATION.contract_state_root,
            { 'BTC:regtest': 10000, 'BTC:testnet': 0, 'LTC:testnet': 0, 'DOGE:testnet': 0 });
        // Stage B armed on regtest above Stage A's height: it cannot arm before Stage A
        // holds, and 11200 > 10000 pins that ordering here rather than in prose. The
        // same ordering rule holds trivially on the testnet chains, where both stages
        // sit at genesis, and that is asserted below rather than assumed.
        assert.deepStrictEqual(SUB.ESCROW_LOCKED_LEAF_ACTIVATION,
            // All three testnet chains armed at genesis 2026-08-18 (pre-launch ruling:
            // every feature live on testnet). Pinned exactly, so an arming anywhere else
            // - mainnet above all - still fails here.
            { 'BTC:regtest': 11200, 'BTC:testnet': 0, 'LTC:testnet': 0, 'DOGE:testnet': 0 });
        // Stage B at or above Stage A on EVERY chain that carries both, not just on
        // regtest: a chain armed for the escrow leaf below its own reserved-slot
        // height would run Stage B against a chain that is still assembling v1.
        for(const key of Object.keys(SUB.ESCROW_LOCKED_LEAF_ACTIVATION)){
            const stageA = SUB.STATE_SUBTREE_ACTIVATION.contract_state_root[key];
            assert.notStrictEqual(stageA, undefined, key + ' arms Stage B with no Stage A height');
            assert.ok(SUB.ESCROW_LOCKED_LEAF_ACTIVATION[key] >= stageA,
                'Stage B must not arm below the Stage A height on ' + key);
        }
        // The shadow window, which is deliberately NOT the same kind of entry as
        // the two maps above: it commits nothing, so it is not a flag day, but it
        // does start the source's journal writer on the named chain and it must be
        // registered here for the same reason arming is - so that opening one is a
        // reviewed code change and never a quiet config edit. It is EMPTY: an entry
        // below its own chain's arming height is unreachable (ARMED WINS), so the
        // only honest way to record "no window is open" is to hold no keys at all.
        assert.deepStrictEqual(SUB.ESCROW_LOCKED_LEAF_SHADOW, {});
        assert.deepStrictEqual(SUB.STATE_SUBTREE_SHADOW,
            { ownership_root: {}, tokens_root: {}, contract_state_root: {} });
        // A shadow entry on an ARMED chain is only ever meaningful BELOW that chain's
        // arming height; on an unarmed chain any height works. This is the rule any
        // future entry has to satisfy. It holds vacuously today and is what catches an
        // entry re-added onto a genesis-armed chain, which is how the retired
        // BTC:testnet 148000 window came to read as open while it never could be.
        for(const key of Object.keys(SUB.ESCROW_LOCKED_LEAF_SHADOW)){
            const armedAt = SUB.ESCROW_LOCKED_LEAF_ACTIVATION[key];
            if(armedAt === undefined) continue;                  // unarmed chain, any window works
            assert.ok(SUB.ESCROW_LOCKED_LEAF_SHADOW[key] < armedAt,
                key + ' shadows at or above its own arming height, so the window can never open');
        }
    });
});
