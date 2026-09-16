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
 * test/unit/state_subtree_activation.test/state_root_reserved_sub_trees_2.test.js
 *
 * Sibling block of the state_subtree_activation.test.js suite, carrying:
 *   state_root reserved sub-trees: gateSubRoots @regression
 *   assembleStateRoot: reserved-slot carrier is inert @regression
 *   assembleStateRoot: reserved-slot carrier is real @regression
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');
const M   = require('../../../src/consensus/merkle.js');
const SC  = require('../../../src/state_commitment/index.js');
const SUB = require('../../../src/consensus/gates/state_subtree_gate.js');

// Snapshot of the REAL armed heights, taken before any test mutates the map, so
// a scratch-arm can restore rather than delete (deleting disarms the chain for
// every later test in the process).
const ARMED_LIVE = Object.assign({}, SUB.STATE_SUBTREE_ACTIVATION.contract_state_root);
const ESCROW_ARMED_LIVE = Object.assign({}, SUB.ESCROW_LOCKED_LEAF_ACTIVATION);
// Every slot map, so a helper that scratches a DIFFERENT slot restores that one
// rather than the armed one. Restoring from the wrong snapshot is not
// hypothetical: the bare-network test below scratches tokens_root and restored
// it from ARMED_LIVE once, which silently ARMED tokens_root on BTC:regtest at
// 10000 for the rest of the process. It stayed invisible only because this file
// sorted last, and tokens_root has NO derivation, so anything that then read it
// would commit a slot nothing computes.
const SLOTS_LIVE = {};
for(const slot of SUB.RESERVED_SUBTREES)
    SLOTS_LIVE[slot] = Object.assign({}, SUB.STATE_SUBTREE_ACTIVATION[slot]);

const COINS    = ['BTC', 'LTC', 'DOGE'];
const NETWORKS = ['mainnet', 'testnet', 'regtest'];
// Heights spanning genesis, every armed flag-day cohort, and far past any of them.
const HEIGHTS  = [0, 1, 145000, 958500, 962500, 3160000, 6335000, 67500000, 999999999];

// THE ARMED SET for reserved slots, pinned exhaustively and in ONE place. A
// blanket inertness assertion cannot express this: arming anything forces it to
// be deleted, and deleting it drops the protection for every OTHER chain at the
// same time. Pinning the exact set keeps the guard at full strength, so an
// unintended arming anywhere still fails, while recording the intended one.
//
// It lives at module scope rather than inside the inertness describe because the
// "every INERT chain" loops below scope themselves around it. Those loops must
// derive their exclusions from this set rather than hardcoding a pair, or they
// silently narrow: the loop would claim every other chain gates to null while
// walking over chains that do not. What is inert here is mainnet plus the two
// non-BTC regtests.
const ARMED = { contract_state_root: {
    'BTC:regtest': 10000, 'BTC:testnet': 0, 'LTC:testnet': 0, 'DOGE:testnet': 0 } };

// Is this chain armed for ANY reserved slot, at any height?
function isArmedChain(coin, network){
    return Object.values(ARMED).some(m => Object.prototype.hasOwnProperty.call(m, coin + ':' + network));
}

// Deterministic stand-in sub-roots (any 32-byte hex works; these are not real trees).
function rootFor(tag){ return M.toHex(M.sha256(Buffer.from('subroot:' + tag, 'utf8'))); }

// THE NET UNDER ALL OF IT. Every scratch-arm helper here restores what it
// touched, and this proves the whole file did: a delete-instead-of-restore is
// invisible to the test that commits it (its own assertions pass) and surfaces
// as an unrelated suite failing later in the same process, which is expensive to
// diagnose and has already happened twice. Asserting the maps are as-found makes
// the offending FILE fail instead of its innocent neighbour.
after(function(){
    for(const slot of SUB.RESERVED_SUBTREES)
        assert.deepStrictEqual(SUB.STATE_SUBTREE_ACTIVATION[slot], SLOTS_LIVE[slot],
            'a test in this file left the ' + slot + ' map altered');
    assert.deepStrictEqual(SUB.ESCROW_LOCKED_LEAF_ACTIVATION, ESCROW_ARMED_LIVE,
        'a test in this file left the escrow-leaf map altered');
});

describe('state_root reserved sub-trees: gateSubRoots @regression', function(){

    it('an armed escrow leaf flips the derived version to 2 (leaf-set changes are never version-invisible)', function(){
        // Stage B moves the contents of balances_root, not the slot list, but a
        // changed committed leaf set must be visible in state_root_version all
        // the same.
        try {
            SUB.ESCROW_LOCKED_LEAF_ACTIVATION['DOGE:regtest'] = 700;
            assert.strictEqual(SUB.isEscrowLockedLeafActive(700, 'regtest', 'DOGE'), true);
            assert.strictEqual(SUB.stateRootVersion(699, 'regtest', 'DOGE'), 1);
            assert.strictEqual(SUB.stateRootVersion(700, 'regtest', 'DOGE'), 2);
            // Scoped to the armed chain; slots stay untouched by the escrow map.
            assert.strictEqual(SUB.stateRootVersion(700, 'regtest', 'BTC'), 1);
            for(const name of SUB.RESERVED_SUBTREES)
                assert.strictEqual(SUB.isSubtreeActive(name, 700, 'regtest', 'DOGE'), false);
        } finally {
            delete SUB.ESCROW_LOCKED_LEAF_ACTIVATION['DOGE:regtest'];
        }
        assert.strictEqual(SUB.stateRootVersion(999999999, 'regtest', 'DOGE'), 1);
    });

    it('a bare-network key arms nothing (coin-qualified keys are the only lookup)', function(){
        // The gate deliberately drops state_commitment_activation.js's
        // bare-network fallback: one bare key arming three chains at one
        // number is near-certainly wrong on two of them.
        const map = SUB.STATE_SUBTREE_ACTIVATION.tokens_root;
        try {
            map.regtest = 10;
            for(const coin of COINS)
                for(const h of [10, 999999999])
                    assert.strictEqual(SUB.isSubtreeActive('tokens_root', h, 'regtest', coin), false,
                        'bare key "regtest" must arm nothing (' + coin + '@' + h + ')');
            map['BTC:regtest'] = 20;   // a coin-qualified key beside it works normally
            assert.strictEqual(SUB.isSubtreeActive('tokens_root', 20, 'regtest', 'BTC'), true);
            assert.strictEqual(SUB.isSubtreeActive('tokens_root', 20, 'regtest', 'LTC'), false);
        } finally {
            // Restore from THIS slot's snapshot. Using ARMED_LIVE here (the
            // contract_state_root snapshot) armed tokens_root instead of clearing it.
            delete map.regtest;
            if(Object.prototype.hasOwnProperty.call(SLOTS_LIVE.tokens_root, 'BTC:regtest'))
                map['BTC:regtest'] = SLOTS_LIVE.tokens_root['BTC:regtest'];
            else delete map['BTC:regtest'];
        }
    });
});

describe('assembleStateRoot: reserved-slot carrier is inert @regression', function(){

    const bal = rootFor('balances');
    const stk = rootFor('stakes');
    const EMPTY = SC.EMPTY_ROOT_HEX;
    const v1 = SC.assembleStateRoot(bal, stk);

    it('still matches merkle.stateRoot for the two v1 sub-roots', function(){
        assert.strictEqual(v1, M.toHex(M.stateRoot({ balances_root: bal, stakes_root: stk })));
    });

    it('null / undefined / empty extraSubRoots are byte-identical to the two-argument form', function(){
        for(const extra of [null, undefined, {}])
            assert.strictEqual(SC.assembleStateRoot(bal, stk, extra), v1);
    });

    it('explicitly EMPTY reserved sub-roots are byte-identical to the two-argument form', function(){
        // This is the property the whole carrier rests on: a named-but-empty slot
        // and an absent slot commit the same EMPTY_SMT_ROOT leaf.
        assert.strictEqual(SC.assembleStateRoot(bal, stk, {
            ownership_root: EMPTY, tokens_root: EMPTY, contract_state_root: EMPTY }), v1);
        // Mixed null/empty/absent, same answer.
        assert.strictEqual(SC.assembleStateRoot(bal, stk, {
            ownership_root: null, contract_state_root: EMPTY }), v1);
    });

    it('ignores keys that are not reserved slot names', function(){
        // Only RESERVED_SUBTREES names are copied through, so a stray key can never
        // reach merkle.stateRoot and offers no path for smuggling a slot in.
        assert.strictEqual(SC.assembleStateRoot(bal, stk, {
            escrow_root: rootFor('esc'), contract_root: rootFor('con'), balances_root: rootFor('evil') }), v1);
    });

    it('the gated block-path value is null on every INERT chain, so its root is the v1 root', function(){
        // Scoped around the ARMED chain (BTC:regtest at 10000) rather than
        // deleted: every other chain must still gate to null, which is the
        // property that keeps "landing this changes nothing" true for them.
        for(const coin of COINS)
            for(const network of NETWORKS){
                if(isArmedChain(coin, network)) continue;                 // armed, see ARMED
                const gated = SUB.gateSubRoots({ contract_state_root: rootFor('cst') }, 999999999, network, coin);
                assert.strictEqual(gated, null);
                assert.strictEqual(SC.assembleStateRoot(bal, stk, gated), v1);
            }
    });

    it('the ARMED chain commits a DIFFERENT root, which is the whole point of arming', function(){
        const gated = SUB.gateSubRoots({ contract_state_root: rootFor('cst') }, 10000, 'regtest', 'BTC');
        assert.ok(gated);
        const armedRoot = SC.assembleStateRoot(bal, stk, gated);
        assert.notStrictEqual(armedRoot, v1, 'an armed slot must move state_root');
        // ...and below the height the same chain still produces the v1 root, so
        // history before the flag day is untouched.
        assert.strictEqual(SC.assembleStateRoot(bal, stk,
            SUB.gateSubRoots({ contract_state_root: rootFor('cst') }, 9999, 'regtest', 'BTC')), v1);
    });
});

describe('assembleStateRoot: reserved-slot carrier is real @regression', function(){

    const bal = rootFor('balances');
    const stk = rootFor('stakes');
    const v1  = SC.assembleStateRoot(bal, stk);

    it('a populated reserved sub-root changes state_root', function(){
        for(const name of SUB.RESERVED_SUBTREES){
            const extra = {};
            extra[name] = rootFor(name);
            assert.notStrictEqual(SC.assembleStateRoot(bal, stk, extra), v1,
                name + ' did not move state_root; the carrier is a no-op');
        }
    });

    it('each reserved slot occupies its own leaf position', function(){
        const seen = new Set([v1]);
        const shared = rootFor('same-value-different-slot');
        for(const name of SUB.RESERVED_SUBTREES){
            const extra = {};
            extra[name] = shared;   // identical value, so only the POSITION differs
            const root = SC.assembleStateRoot(bal, stk, extra);
            assert.ok(!seen.has(root), name + ' collides with another slot position');
            seen.add(root);
        }
    });

    it('assembleStateRoot agrees with merkle.stateRoot when slots are populated', function(){
        const extra = { ownership_root: rootFor('own'), tokens_root: rootFor('tok'), contract_state_root: rootFor('cst') };
        assert.strictEqual(SC.assembleStateRoot(bal, stk, extra),
            M.toHex(M.stateRoot(Object.assign({ balances_root: bal, stakes_root: stk }, extra))));
    });

    it('stateRootProof verifies a reserved sub-root against the assembled root', function(){
        // The sub_root_path a light client would use once a slot is armed.
        const extra = { ownership_root: rootFor('own'), tokens_root: rootFor('tok'), contract_state_root: rootFor('cst') };
        const subRoots = Object.assign({ balances_root: bal, stakes_root: stk }, extra);
        const root = SC.assembleStateRoot(bal, stk, extra);
        for(const name of M.STATE_SUBTREES){
            const p = M.stateRootProof(subRoots, name);
            assert.ok(M.verifyFixedMerkleProof(root, M.toBuf(subRoots[name]), p.index, p.siblings),
                'sub_root_path did not verify for ' + name);
        }
    });

    it('an EMPTY reserved slot still proves as EMPTY_SMT_ROOT against the v1 root', function(){
        // Non-membership story for a slot that is reserved but not yet armed: the
        // client proves the slot is committed EMPTY rather than absent.
        const subRoots = { balances_root: bal, stakes_root: stk };
        for(const name of SUB.RESERVED_SUBTREES){
            const p = M.stateRootProof(subRoots, name);
            assert.ok(M.verifyFixedMerkleProof(v1, M.EMPTY_SMT_ROOT, p.index, p.siblings),
                'EMPTY sub_root_path did not verify for ' + name);
        }
    });
});
