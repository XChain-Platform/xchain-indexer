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
 * test/unit/state_subtree_activation.test/state_root_reserved_sub_trees.test.js
 *
 * Sibling block of the state_subtree_activation.test.js suite, carrying:
 *   state_root reserved sub-trees: gate is inert EXCEPT the armed set @regression
 *   state_root reserved sub-trees: gateSubRoots @regression
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');
const M   = require('../../../src/consensus/merkle.js');
const SC  = require('../../../src/stateCommitment.js');
const SUB = require('../../../src/state_subtree_activation.js');

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

describe('state_root reserved sub-trees: gate is inert EXCEPT the armed set @regression', function(){

    // ARMED and isArmedChain are module-scoped: see the comment at their
    // definition for why the inertness loops must share one source of truth.

    it('every populated activation key is coin-qualified (<COIN>:<network>)', function(){
        // These heights are chain-local block indexes and the chains differ by
        // orders of magnitude, so a bare-network key arms three chains at one
        // number. Unlike state_commitment_activation.js there is NO bare-network
        // fallback in this gate at all; this pins the key shape.
        const maps = Object.values(SUB.STATE_SUBTREE_ACTIVATION).concat([SUB.ESCROW_LOCKED_LEAF_ACTIVATION]);
        for(const map of maps)
            for(const key of Object.keys(map))
                assert.ok(/^[A-Z0-9]+:(mainnet|testnet|regtest)$/.test(key),
                    'activation key "' + key + '" is not coin-qualified');
    });

    it('no environment variable can arm a slot', function(){
        // An env-tunable consensus height is a fork switch on an operator's shell.
        // Nothing in the module may read process.env at all.
        const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../../src/state_subtree_activation.js'), 'utf8');
        assert.ok(!/process\.env/.test(src), 'state_subtree_activation.js must not read process.env');
    });
});

// Shared by the three gateSubRoots blocks below. They repeat ONE describe title
// instead of holding one 136-line callback: mocha flattens identically titled
// siblings, so the full test titles this file collects, and their order, are the
// ones the single block collected.
const candidates = {
    ownership_root:      rootFor('own'),
    tokens_root:         rootFor('tok'),
    contract_state_root: rootFor('cst')
};

describe('state_root reserved sub-trees: gateSubRoots @regression', function(){

    it('drops every candidate on every INERT chain, returning null', function(){
        // Scoped around the ARMED chain (BTC:regtest at 10000) rather than
        // deleted: every other chain must still gate to null, which is the
        // property that keeps "landing this changes nothing" true for them.
        for(const coin of COINS)
            for(const network of NETWORKS){
                if(isArmedChain(coin, network)) continue;                 // armed, see ARMED
                assert.strictEqual(SUB.gateSubRoots(candidates, 999999999, network, coin), null);
            }
    });

    it('passes ONLY the armed slot through on the armed chain', function(){
        // The complement of the assertion above: the gate is not a no-op, and it
        // still drops the slots that are NOT armed even on the armed chain.
        const gated = SUB.gateSubRoots(candidates, 10000, 'regtest', 'BTC');
        assert.deepStrictEqual(Object.keys(gated), ['contract_state_root']);
        assert.strictEqual(gated.contract_state_root, candidates.contract_state_root);
        assert.strictEqual(SUB.gateSubRoots(candidates, 9999, 'regtest', 'BTC'), null,
            'one block below the armed height nothing passes');
    });

    it('returns null for null / empty candidates', function(){
        assert.strictEqual(SUB.gateSubRoots(null, 100, 'regtest', 'BTC'), null);
        assert.strictEqual(SUB.gateSubRoots(undefined, 100, 'regtest', 'BTC'), null);
        assert.strictEqual(SUB.gateSubRoots({}, 100, 'regtest', 'BTC'), null);
    });

    it('throws on an unknown slot name rather than dropping it silently', function(){
        // A silently dropped slot AFTER its height is armed is a fork, so a typo
        // must be loud at the first call, not at the flag day.
        assert.throws(() => SUB.gateSubRoots({ escrow_root: rootFor('esc') }, 100, 'regtest', 'BTC'),
                      /unknown reserved sub-tree escrow_root/);
        assert.throws(() => SUB.isSubtreeActive('contract_root', 100, 'regtest', 'BTC'),
                      /unknown reserved sub-tree contract_root/);
    });

    it('fails closed on an unparseable height', function(){
        for(const bad of [null, undefined, NaN, 'abc', {}])
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', bad, 'regtest', 'BTC'), false);
    });

});

describe('state_root reserved sub-trees: gateSubRoots @regression', function(){

    it('opens for exactly the armed slot, chain and height once a height is set', function(){
        // Proves the gate is not a permanent no-op. Mutates the real map to a
        // SCRATCH height (500, deliberately below the live 10000 so the override
        // is observable) and restores the live value afterwards.
        const map = SUB.STATE_SUBTREE_ACTIVATION.contract_state_root;
        try {
            map['BTC:regtest'] = 500;
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 499, 'regtest', 'BTC'), false);
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 500, 'regtest', 'BTC'), true);
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 501, 'regtest', 'BTC'), true);
            // Scoped to the armed chain and slot only.
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 501, 'regtest', 'LTC'), false);
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 501, 'mainnet', 'BTC'), false);
            assert.strictEqual(SUB.isSubtreeActive('ownership_root', 501, 'regtest', 'BTC'), false);
            // Version derives from the gate, and only for the armed chain.
            assert.strictEqual(SUB.stateRootVersion(501, 'regtest', 'BTC'), 2);
            assert.strictEqual(SUB.stateRootVersion(501, 'regtest', 'LTC'), 1);
            // The gate passes only the armed slot through.
            assert.deepStrictEqual(SUB.gateSubRoots(candidates, 501, 'regtest', 'BTC'),
                                   { contract_state_root: candidates.contract_state_root });
            assert.strictEqual(SUB.gateSubRoots(candidates, 499, 'regtest', 'BTC'), null);
            // Lax parses stay closed even while armed: parseInt would read
            // '501abc' as 501 (open) and '1e3' as 1; Number() would read '1e3'
            // as 1000 (open). The gate must read every one of these as OFF.
            for(const bad of ['501abc', '1e3', '', ' 501', '501 ', -1, 500.5])
                assert.strictEqual(SUB.isSubtreeActive('contract_state_root', bad, 'regtest', 'BTC'), false,
                    JSON.stringify(bad) + ' must fail closed while a height is armed');
        } finally {
            if(Object.prototype.hasOwnProperty.call(ARMED_LIVE, 'BTC:regtest')) map['BTC:regtest'] = ARMED_LIVE['BTC:regtest']; else delete map['BTC:regtest'];
        }
        // RESTORED to the real armed set, not wiped. This assertion is what
        // catches a helper that "cleans up" with delete: before BTC:regtest was
        // armed, deleting and restoring looked identical, and a later suite would
        // silently run against a disarmed gate.
        assert.deepStrictEqual(SUB.STATE_SUBTREE_ACTIVATION.contract_state_root, ARMED_LIVE);
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 999999999, 'regtest', 'BTC'), true);
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 9999, 'regtest', 'BTC'), false);
    });

});

describe('state_root reserved sub-trees: gateSubRoots @regression', function(){

    it('fails closed on a malformed MAP threshold, not just a malformed query height', function(){
        // The map side is the sneaky one: raw JS relational comparison coerces,
        // so `b >= "1e3"` arms at 1000 and `b >= null` arms from genesis (null
        // survives the !== undefined lookup and coerces to 0). true, -1 and 1.5
        // are the same class. Every one of these must read as OFF at heights
        // that would coerce open.
        const map = SUB.STATE_SUBTREE_ACTIVATION.contract_state_root;
        for(const bad of ['1e3', null, true, -1, 1.5, '501abc', '', ' 500'])
            try {
                map['BTC:regtest'] = bad;
                for(const h of [0, 5, 1500, 999999999])
                    assert.strictEqual(SUB.isSubtreeActive('contract_state_root', h, 'regtest', 'BTC'), false,
                        'threshold ' + JSON.stringify(bad) + ' must fail closed at height ' + h);
                assert.strictEqual(SUB.stateRootVersion(1500, 'regtest', 'BTC'), 1);
            } finally {
                if(Object.prototype.hasOwnProperty.call(ARMED_LIVE, 'BTC:regtest')) map['BTC:regtest'] = ARMED_LIVE['BTC:regtest']; else delete map['BTC:regtest'];
            }
        // Same rule on the escrow-leaf map.
        try {
            SUB.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'] = null;
            assert.strictEqual(SUB.isEscrowLockedLeafActive(1500, 'regtest', 'BTC'), false);
        } finally {
            // RESTORE, never delete: BTC:regtest carries the REAL 11200 height, and
            // deleting it disarms the chain for every test that runs after this one
            // in the same process. Harmless while the suite happened to run last
            // alphabetically, and a landmine the moment anything reorders it.
            if(Object.prototype.hasOwnProperty.call(ESCROW_ARMED_LIVE, 'BTC:regtest'))
                SUB.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'] = ESCROW_ARMED_LIVE['BTC:regtest'];
            else delete SUB.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'];
        }
    });

    it('the block paths hand assembleStateRoot only gateSubRoots output (the gate is the only permitted writer)', function(){
        // assembleStateRoot cannot enforce this itself (it has no height context
        // and accepts any extraSubRoots object), so the routing is pinned at the
        // source level: every call site passes the extraSubRoots local, and that
        // local is only ever assigned from SUB.gateSubRoots().
        const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../../src/stateCommitment.js'), 'utf8');
        const sites = src.match(/assembleStateRoot\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*\)/g) || [];
        assert.ok(sites.length >= 1, 'no three-argument assembleStateRoot site found in stateCommitment.js');
        for(const s of sites)
            assert.ok(/,\s*extraSubRoots\s*\)$/.test(s), 'assembleStateRoot site "' + s + '" does not pass extraSubRoots');
        const assigns = src.match(/extraSubRoots\s*=[^=][^\n;]*/g) || [];
        assert.ok(assigns.length >= 1, 'no extraSubRoots assignment found in stateCommitment.js');
        for(const a of assigns)
            assert.ok(/SUB\.gateSubRoots\(/.test(a), 'extraSubRoots assigned outside the gate: ' + a);
    });
});
