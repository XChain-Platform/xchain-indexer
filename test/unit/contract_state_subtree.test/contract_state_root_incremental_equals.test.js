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
 * test/unit/contract_state_subtree.test/contract_state_root_incremental_equals.test.js
 *
 * Sibling block of the contract_state_subtree.test.js suite, carrying:
 *   contract_state_root: incremental equals full build @regression
 *   contract_state_root: shadow-compute window @regression
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');

const SUB = require('../../../src/state_subtree_activation.js');
const CST = require('../../../src/consensus/contract_state_subtree.js');

const { FakeDb, CHAIN, NETWORK } = require('./helpers/fake_db');
const { shadowFrom } = require('./helpers/shadow_window');

describe('contract_state_root: incremental equals full build @regression', function(){

    it('key insertion order does not change the root (the SMT is key-addressed)', async function(){
        const a = new FakeDb(), b = new FakeDb();
        a.write(1, 7, 'k1', '"v1"'); a.write(1, 7, 'k2', '"v2"'); a.write(1, 9, 'k3', '"v3"');
        b.write(1, 9, 'k3', '"v3"'); b.write(1, 7, 'k2', '"v2"'); b.write(1, 7, 'k1', '"v1"');
        assert.strictEqual(await CST.buildFullContractStateRoot(a, a.smt(), CHAIN, NETWORK),
                           await CST.buildFullContractStateRoot(b, b.smt(), CHAIN, NETWORK));
    });
});

describe('contract_state_root: shadow-compute window @regression', function(){

    const SHADOW_FROM = 300, ARMED = 400;

    it('ships inert: nothing shadows on any chain, network or height', function(){
        for(const slot of SUB.RESERVED_SUBTREES){
            assert.deepStrictEqual(Object.keys(SUB.STATE_SUBTREE_SHADOW[slot]), [], 'slot ' + slot);
            for(const coin of ['BTC', 'LTC', 'DOGE'])
                for(const h of [0, 962500, 999999999])
                    assert.strictEqual(SUB.isSubtreeShadowActive(slot, h, 'mainnet', coin), false);
        }
    });

    it('ARMED WINS: a height that is both shadowing and armed shadows nothing', async function(){
        // Otherwise the same block derives twice and writes both columns, and the
        // shadow column silently becomes a second opinion about committed state.
        await shadowFrom(SHADOW_FROM, ARMED, async () => {
            assert.strictEqual(SUB.isSubtreeShadowActive('contract_state_root', ARMED, NETWORK, CHAIN), false);
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', ARMED, NETWORK, CHAIN), true);
            // ...and below the armed height it is the other way round.
            assert.strictEqual(SUB.isSubtreeShadowActive('contract_state_root', ARMED - 1, NETWORK, CHAIN), true);
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', ARMED - 1, NETWORK, CHAIN), false);
        });
    });
});
