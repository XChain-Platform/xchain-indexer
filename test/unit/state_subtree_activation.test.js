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
 **********************************************************************
 *
 * Reserved state_root sub-tree gate conformance, for SPV light
 * clients.
 *
 * The load-bearing assertion here is the INERTNESS one: the three-argument
 * assembleStateRoot must produce a state_root byte-identical to the old
 * two-argument form on every chain, or landing this carrier silently forks every
 * deployed light client. That is asserted from both ends: the gate answers "off"
 * everywhere, and the assembler treats null / absent / empty-root slots as the
 * same EMPTY_SMT_ROOT leaf.
 *
 * The second job is proving the plumbing is NOT a permanent no-op: a populated
 * reserved slot must change state_root, each slot must occupy its own leaf
 * position, and arming a height in a scratch copy of the map must actually let a
 * sub-root through. A gate that can never open would pass every inertness test.
 *
 * TWIN PAIR: this ENTRY file and xchain-sync/test/unit/stateSubtreeActivation.test.js
 * are kept BYTE-IDENTICAL apart from the src/<feature>/ depth of their requires (the
 * gate and assembler they cover are themselves byte-identical twins). Locked equal by
 * the cross-repo twin loop in xchain-sync/test/unit/rollback-coverage.test.js. The
 * suite outgrew the file-length limit, so the map, gateSubRoots and assembler blocks
 * now sit beside it in state_subtree_activation.test/. That parts directory is NOT in
 * the twin registry, so a change there reaches the sync half only by hand or
 * reconcile-twins.sh.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const M   = require('../../src/consensus/merkle.js');
const SC  = require('../../src/state_commitment/index.js');
const SUB = require('../../src/consensus/gates/state_subtree_gate.js');

// Snapshot of the REAL armed heights, taken before any test mutates the map, so
// a scratch-arm can restore rather than delete (deleting disarms the chain for
// every later test in the process).
const ARMED_LIVE = Object.assign({}, SUB.STATE_SUBTREE_ACTIVATION.contract_state_root);
const ESCROW_ARMED_LIVE = Object.assign({}, SUB.ESCROW_LOCKED_LEAF_ACTIVATION);
// Every slot map, so a helper that scratches a DIFFERENT slot restores that one
// rather than the armed one. Restoring from the wrong snapshot is not
// hypothetical: the bare-network test below scratches tokens_root and used to
// restore it from ARMED_LIVE, which silently ARMED tokens_root on BTC:regtest at
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

// Scratch-arm BOTH escrow-leaf maps on BTC:regtest for the duration of fn, then
// restore them. Snapshot both keys, because BTC:regtest carries a REAL armed
// height and the cleanup restores it rather than a `delete`. With an empty map,
// delete and restore were indistinguishable; the moment a height exists,
// deleting it silently DISARMS the chain for every later test in the process.
// That is not hypothetical: it is exactly what the Stage A arming hit, and it
// presented as an armed-height assertion failing while the same gate answered
// armed elsewhere in the run.
function withScratchEscrowHeights(shadowHeight, armedHeight, fn){
    const hadShadow = Object.prototype.hasOwnProperty.call(SUB.ESCROW_LOCKED_LEAF_SHADOW, 'BTC:regtest');
    const priorShadow = SUB.ESCROW_LOCKED_LEAF_SHADOW['BTC:regtest'];
    const hadArmed = Object.prototype.hasOwnProperty.call(SUB.ESCROW_LOCKED_LEAF_ACTIVATION, 'BTC:regtest');
    const priorArmed = SUB.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'];
    try {
        SUB.ESCROW_LOCKED_LEAF_SHADOW['BTC:regtest']     = shadowHeight;
        SUB.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'] = armedHeight;
        return fn();
    } finally {
        // RESTORE, never delete: see the snapshot comment above.
        if(hadShadow) SUB.ESCROW_LOCKED_LEAF_SHADOW['BTC:regtest'] = priorShadow;
        else delete SUB.ESCROW_LOCKED_LEAF_SHADOW['BTC:regtest'];
        if(hadArmed) SUB.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'] = priorArmed;
        else delete SUB.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'];
    }
}

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

describe('state_root reserved sub-trees: slot list @regression', function(){

    it('RESERVED_SUBTREES is exactly the non-v1 tail of merkle.STATE_SUBTREES, in order', function(){
        // The tail order IS the leaf order of the top-level fixed Merkle tree, so a
        // reordering here silently re-points every sub_root_path proof.
        assert.deepStrictEqual(SUB.RESERVED_SUBTREES, M.STATE_SUBTREES.slice(2));
        assert.deepStrictEqual(M.STATE_SUBTREES.slice(0, 2), ['balances_root', 'stakes_root']);
    });

    it('the frozen slot list has exactly five names (a sixth would change every historical state_root)', function(){
        // fixedMerkleRoot pads to 8 with EMPTY[0]; a named-but-empty slot commits
        // EMPTY_SMT_ROOT. Those constants differ, so naming a sixth slot rewrites
        // state_root for every block ever produced. Guard the count explicitly.
        assert.strictEqual(M.STATE_SUBTREES.length, 5);
        assert.notStrictEqual(M.toHex(M.EMPTY[0]), M.toHex(M.EMPTY_SMT_ROOT));
    });

    it('there is no escrow sub-root: the locked leaf lives inside balances_root', function(){
        // SPV state root: escrow is a parallel LEAF under escrowKey's
        // XCHAIN_ESC domain in the balances sub-tree, never a sixth slot.
        assert.ok(M.STATE_SUBTREES.every(n => !/escrow/i.test(n)));
        assert.strictEqual(typeof M.escrowKey, 'function');
        assert.notStrictEqual(M.toHex(M.escrowKey('BTC', 'regtest', 'addr1', 'XCHAIN')),
                              M.toHex(M.balanceKey('BTC', 'regtest', 'addr1', 'XCHAIN')));
    });
});

describe('state_root reserved sub-trees: gate is inert EXCEPT the armed set @regression', function(){

    // ARMED and isArmedChain are module-scoped: see the comment at their
    // definition for why the inertness loops must share one source of truth.

    it('exactly the armed set is armed, and nothing else on any chain or height', function(){
        for(const name of SUB.RESERVED_SUBTREES)
            for(const coin of COINS)
                for(const network of NETWORKS)
                    for(const h of HEIGHTS){
                        const threshold = (ARMED[name] || {})[coin + ':' + network];
                        const expected  = (threshold !== undefined) && h >= threshold;
                        assert.strictEqual(SUB.isSubtreeActive(name, h, network, coin), expected,
                            name + ' at ' + coin + '/' + network + '@' + h + ' should be ' +
                            (expected ? 'ARMED' : 'inert') + '; only the pinned set may be armed');
                    }
    });

    it('the armed height is a real boundary, and is chain-local', function(){
        // BTC:regtest at 10000 is the ONLY below/at/above boundary this slot still
        // has: every testnet chain arms at genesis, where there is no "below". So
        // this test carries the whole "the comparison is a real >=, not > and not
        // hardcoded true" property for the reserved-slot gate, and deleting it
        // would leave nothing proving the gate can answer false on an armed chain.
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 0,     'regtest', 'BTC'), false);
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 9999,  'regtest', 'BTC'), false);
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 10000, 'regtest', 'BTC'), true);
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 10001, 'regtest', 'BTC'), true);
        for(const coin of ['LTC', 'DOGE'])
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 10000, 'regtest', coin), false,
                'arming BTC regtest must not arm ' + coin);
        // Mainnet only in this direction. BTC:testnet is armed from genesis in its
        // own right, so it is no longer evidence about whether the regtest height
        // leaked across networks; the exhaustive test above still pins its value.
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 10000, 'mainnet', 'BTC'), false,
            'arming regtest must not arm mainnet at the REGTEST height');
    });
});

// Same title, continued: the readability limit splits the block, not the suite.
describe('state_root reserved sub-trees: gate is inert EXCEPT the armed set @regression', function(){

    it('all three testnet chains arm contract_state_root from GENESIS', function(){
        // Replaced BTC:testnet's 146500 boundary (2026-07-30), which the 2026-08-10
        // re-genesis left inert but readable as a boundary that no longer exists.
        // LTC and DOGE had no entry at all until this arming, so nothing pinned
        // them and an accidental removal would have gone unnoticed.
        //
        // Genesis arming has no "below", so the meaningful shape is different: prove
        // the slot is live at block 0, at block 1, and at an arbitrary far height, and
        // prove the arming is per chain rather than a blanket "testnet is on" that a
        // future bare-network fallback would also satisfy.
        for(const coin of ['BTC', 'LTC', 'DOGE']){
            assert.strictEqual(SUB.STATE_SUBTREE_ACTIVATION.contract_state_root[coin + ':testnet'], 0,
                coin + ':testnet must be armed at genesis');
            for(const h of [0, 1, 146500, 999999999])
                assert.strictEqual(SUB.isSubtreeActive('contract_state_root', h, 'testnet', coin), true,
                    coin + ':testnet must be live at ' + h);
        }
        // Precondition 1 in test form rather than prose: Stage A may never arm below
        // the chain's state_key_collation height, or the SMT is built over a
        // collation-FOLDED key set and forks against a binary-collation reader. All
        // three testnets are genesis-active there, so 0 is the lowest legal height
        // and this is the assertion that fails if either map moves off genesis alone.
        const gateRegistry = require('../../src/consensus/gate_registry');
        for(const coin of ['BTC', 'LTC', 'DOGE'])
            assert.ok(gateRegistry.activeAt('state_key_collation_activation.STATE_KEY_COLLATION_ACTIVATION', 'testnet', coin, 0, null),
                coin + ':testnet Stage A arms at 0, so its collation must be genesis-active too');
        // Genesis on testnet must not have leaked onto the other two networks: the
        // maps are read by an exact '<COIN>:<network>' key, and a genesis height is
        // the one value that arms EVERY height at once if it lands on a wrong key.
        for(const coin of ['BTC', 'LTC', 'DOGE'])
            for(const network of ['mainnet', 'regtest']){
                if(coin === 'BTC' && network === 'regtest') continue;   // its own armed height
                assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 0, network, coin), false,
                    'genesis arming leaked onto ' + coin + ':' + network);
            }
        // The escrow leaf is a SEPARATE flag day from Stage A, and this pins that it
        // does not ride along with a Stage A arming. The assertion is made against
        // MAINNET, the network where a silent ride-along would change a committed root.
        assert.strictEqual(SUB.isEscrowLockedLeafActive(0, 'mainnet', 'BTC'), false,
            'Stage B must not ride along with a Stage A arming');
    });
});

// Same title, continued: the readability limit splits the block, not the suite.
describe('state_root reserved sub-trees: gate is inert EXCEPT the armed set @regression', function(){

    it('MAINNET IS UNARMED for every slot, at every height (the launch guard)', function(){
        // The one assertion that must never be relaxed by a venue exercise.
        for(const name of SUB.RESERVED_SUBTREES)
            for(const coin of COINS)
                for(const h of [0, 1, 962500, 3160000, 6335000, 1e9])
                    assert.strictEqual(SUB.isSubtreeActive(name, h, 'mainnet', coin), false,
                        name + ' is armed on ' + coin + ' MAINNET at ' + h);
        for(const coin of COINS)
            for(const h of [0, 962500, 1e9])
                assert.strictEqual(SUB.isEscrowLockedLeafActive(h, 'mainnet', coin), false);
    });

    it('the escrow locked-balance leaf is off everywhere EXCEPT the armed chain', function(){
        // Scoped around the armed chain rather than deleted. A blanket "off everywhere"
        // assertion has to be REMOVED to arm anything, and removing it drops the
        // protection for every other chain at the same moment; pinning the exception
        // keeps an unintended arming anywhere else a failure.
        for(const coin of COINS)
            for(const network of NETWORKS)
                for(const h of HEIGHTS){
                    // Armed set as of 2026-08-18: BTC:regtest from 11200, plus ALL THREE
                    // testnet chains from genesis (pre-launch ruling, every feature live on
                    // testnet). Still scoped rather than blanket-removed, so an unintended
                    // arming on any other chain is still a failure.
                    const armed = (coin === 'BTC' && network === 'regtest' && h >= 11200)
                                  || network === 'testnet';
                    assert.strictEqual(SUB.isEscrowLockedLeafActive(h, network, coin), armed,
                        coin + '/' + network + '@' + h);
                }
        // The positive complement: a gate that never opens passes every "off" assertion
        // ever written, so the armed chain is checked at its exact boundary.
        assert.strictEqual(SUB.isEscrowLockedLeafActive(11199, 'regtest', 'BTC'), false);
        assert.strictEqual(SUB.isEscrowLockedLeafActive(11200, 'regtest', 'BTC'), true);
    });
});

// Same title, continued: the readability limit splits the block, not the suite.
describe('state_root reserved sub-trees: gate is inert EXCEPT the armed set @regression', function(){

    it('the escrow-leaf SHADOW window is CLOSED everywhere, and ARMED WINS when both maps name a height', function(){
        // The map is empty, so the predicate must answer false on every chain at
        // every height with no exception carved out. The BTC:testnet entry that sat
        // here at 148000 was dead the moment the leaf armed at genesis on all three
        // testnets (ARMED WINS over a shadow, so the window could never open), and a
        // shadow height below its own chain's arming height is unreachable by
        // construction. Sweeping without a skip is the point: a shadow window is
        // consensus-free but it starts the source's journal writer, and starting it
        // on a chain nobody meant to is how a "harmless" map entry becomes fleet-wide
        // work nobody scheduled.
        for(const coin of COINS)
            for(const network of NETWORKS)
                for(const h of HEIGHTS)
                    assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(h, network, coin), false,
                        coin + ':' + network + ' at ' + h + ' must not shadow');
        assert.deepStrictEqual(SUB.ESCROW_LOCKED_LEAF_SHADOW, {},
            'the shadow map must stay empty: opening a window is a reviewed code change');
        // The heights the retired entry straddled, checked explicitly rather than
        // left to the sweep's coarse list, so re-adding it would fail here first.
        assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(147999, 'testnet', 'BTC'), false);
        assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(148000, 'testnet', 'BTC'), false);
        // The committed output is what carries the behaviour now: the leaf is live at
        // every testnet height, so the launch exercises locked-balance proofs for real.
        assert.strictEqual(SUB.isEscrowLockedLeafActive(148000, 'testnet', 'BTC'), true);
        assert.strictEqual(SUB.isEscrowLockedLeafActive(0, 'testnet', 'BTC'), true);
        // Scratch-arm both: shadow answers true only BETWEEN its own height and
        // the armed height, so each height uses exactly one column and nothing
        // ever computes twice (same contract as isSubtreeShadowActive).
        withScratchEscrowHeights(500, 800, () => {
            assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(499, 'regtest', 'BTC'), false);
            assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(500, 'regtest', 'BTC'), true);
            assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(799, 'regtest', 'BTC'), true);
            assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(800, 'regtest', 'BTC'), false, 'armed wins');
            assert.strictEqual(SUB.isEscrowLockedLeafActive(800, 'regtest', 'BTC'), true);
            // Shadowing never moves the derived version: it is not committed.
            assert.strictEqual(SUB.stateRootVersion(600, 'regtest', 'BTC'), 1);
            assert.strictEqual(SUB.stateRootVersion(800, 'regtest', 'BTC'), 2);
            // Chain-local, as every map here is.
            assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(600, 'regtest', 'LTC'), false);
        });
        // And the real armed set survived this test, which is the assertion that
        // catches a regression in the restore itself.
        assert.strictEqual(SUB.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'], 11200,
            'restored to the real armed height, not wiped');
    });
});

// Same title, continued: the readability limit splits the block, not the suite.
describe('state_root reserved sub-trees: gate is inert EXCEPT the armed set @regression', function(){

    it('stateRootVersion reports 1 everywhere EXCEPT at and above an armed height', function(){
        for(const coin of COINS)
            for(const network of NETWORKS)
                for(const h of HEIGHTS){
                    const threshold = (ARMED.contract_state_root || {})[coin + ':' + network];
                    const armed = (threshold !== undefined) && h >= threshold;
                    // stateRootVersion is 2 when ANY reserved slot OR the escrow leaf is live,
                    // so an expectation derived from contract_state_root alone under-predicts
                    // on the testnet chains, where the escrow leaf is armed from genesis.
                    const escrowArmed = SUB.isEscrowLockedLeafActive(h, network, coin);
                    assert.strictEqual(SUB.stateRootVersion(h, network, coin),
                        (armed || escrowArmed) ? 2 : 1,
                        coin + '/' + network + '@' + h + ' version');
                }
        // The version is DERIVED, so each armed chain flips at exactly its own
        // boundary. Both are checked: a version derived from the wrong network's
        // threshold would still satisfy one of them.
        assert.strictEqual(SUB.stateRootVersion(9999,   'regtest', 'BTC'), 1);
        assert.strictEqual(SUB.stateRootVersion(10000,  'regtest', 'BTC'), 2);
        // No testnet chain has a version boundary at all any more: both stages arm at
        // genesis there, so the version is 2 from block 0 forward and there is no
        // height at which a testnet chain reports 1. The per-chain-boundary property
        // is carried by BTC:regtest above, which flips at exactly 10000.
        for(const coin of COINS)
            for(const h of [0, 1, 146500, 999999999])
                assert.strictEqual(SUB.stateRootVersion(h, 'testnet', coin), 2,
                    coin + ':testnet must report version 2 at ' + h);
        // Mainnet is the network with no armed slot at all, so it is the one that still
        // proves the version is not simply hardcoded to 2.
        assert.strictEqual(SUB.stateRootVersion(999999999, 'mainnet', 'BTC'), 1);
        // The frozen wire constant still declares 1: it is the FLOOR every chain
        // starts at, not a claim about armed chains, and merkle.js does not know
        // about heights. The per-height value is what api.js reports.
        assert.strictEqual(M.STATE_ROOT_VERSION, 1);
    });
});
