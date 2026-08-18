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
 * Reserved state_root sub-tree gate conformance (SPV spec §4.1, §10 D1; design
 * in).
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
 * TWIN PAIR: xchain-indexer/test/unit/stateSubtreeActivation.test.js and
 * xchain-sync/test/unit/stateSubtreeActivation.test.js are kept BYTE-IDENTICAL
 * (both repos resolve the same relative src paths, and the gate and assembler
 * they cover are themselves byte-identical twins). Locked equal by the cross-repo
 * twin loop in xchain-sync/test/unit/rollback-coverage.test.js.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const M   = require('../../src/merkle.js');
const SC  = require('../../src/stateCommitment.js');
const SUB = require('../../src/state_subtree_activation.js');

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

// THE ARMED SET for reserved slots, pinned exhaustively and in ONE place. This
// suite used to assert blanket inertness, which was the right guard while nothing
// was armed and the wrong one the moment something was: a blanket assertion has
// to be deleted to arm, and deleting it removes the protection for every OTHER
// chain at the same time. Pinning the exact set keeps the guard at full strength
// (an unintended arming anywhere still fails) while recording the intended one.
//
// It lives at module scope rather than inside the inertness describe because the
// "every INERT chain" loops further down have to scope themselves around it. They
// used to skip a hardcoded BTC/regtest pair, which was correct while exactly one
// chain was armed and became a silently narrowed assertion the moment a second
// one was (BTC:testnet, 2026-07-30): the loop would have claimed every other
// chain gates to null while quietly walking over a chain that does not.
const ARMED = { contract_state_root: { 'BTC:regtest': 10000, 'BTC:testnet': 146500 } };

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
        // SPV spec §4.2 D2 (revised): escrow is a parallel LEAF under escrowKey's
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
        // Below/at/above, plus the sibling chains that must NOT have moved.
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 9999,  'regtest', 'BTC'), false);
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 10000, 'regtest', 'BTC'), true);
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 10001, 'regtest', 'BTC'), true);
        for(const coin of ['LTC', 'DOGE'])
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 10000, 'regtest', coin), false,
                'arming BTC regtest must not arm ' + coin);
        for(const network of ['mainnet', 'testnet'])
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 10000, network, 'BTC'), false,
                'arming regtest must not arm ' + network + ' at the REGTEST height');
    });

    it('BTC:testnet has its own boundary at 146500, above its collation height', function(){
        // The second height ever set in this file (2026-07-30). Its own boundary,
        // not the regtest one: a per-network map that accidentally shared a
        // threshold would pass the exhaustive test above by symmetry, so the two
        // networks are pinned apart here.
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 146499, 'testnet', 'BTC'), false);
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 146500, 'testnet', 'BTC'), true);
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 146501, 'testnet', 'BTC'), true);
        // Precondition 1 in test form rather than prose: Stage A may never arm
        // below the chain's state_key_collation height, or the SMT is built over a
        // collation-FOLDED key set and forks against a binary-collation reader.
        const COLLATION_BTC_TESTNET = 146000;
        assert.ok(SUB.STATE_SUBTREE_ACTIVATION.contract_state_root['BTC:testnet'] >= COLLATION_BTC_TESTNET,
            'BTC:testnet Stage A height must be at or above its collation height');
        // Chain-local in the other two directions too: the other testnet chains
        // stay inert at this height, and BTC mainnet stays inert at every height.
        for(const coin of ['LTC', 'DOGE'])
            assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 146500, 'testnet', coin), false,
                'arming BTC testnet must not arm ' + coin + ' testnet');
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 146500, 'mainnet', 'BTC'), false);
        // The escrow leaf is a SEPARATE flag day from Stage A, and this pins that it does
        // not ride along with a Stage A arming. The assertion is made against MAINNET,
        // which carries a Stage A height and no escrow arming, so it is the network where
        // a silent ride-along would actually change a committed root.
        assert.strictEqual(SUB.isEscrowLockedLeafActive(146500, 'mainnet', 'BTC'), false,
            'Stage B must not ride along with a Stage A arming');
    });

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

    it('the escrow-leaf SHADOW window is open on BTC:testnet ONLY, and ARMED WINS when both maps name a height', function(){
        // The window opened on BTC:testnet at 148000 (2026-08-11): the
        // re-seeded chain's locking ORDERs land above it, so they are journaled by
        // the ordinary per-block incremental path rather than by the window-start
        // replay. Every OTHER chain must stay off, and that is the half worth
        // sweeping: a shadow window is consensus-free but it starts the source's
        // journal writer, and starting it on a chain nobody meant to is how a
        // "harmless" map entry becomes fleet-wide work nobody scheduled.
        for(const coin of COINS)
            for(const network of NETWORKS)
                for(const h of HEIGHTS){
                    if(coin === 'BTC' && network === 'testnet') continue;
                    assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(h, network, coin), false,
                        coin + ':' + network + ' at ' + h + ' must not shadow');
                }
        assert.deepStrictEqual(Object.keys(SUB.ESCROW_LOCKED_LEAF_SHADOW), ['BTC:testnet']);
        // The one open chain, at its exact boundary, so an off-by-one in the
        // threshold cannot hide behind the sweep's coarse height list.
        // The shadow entry still names BTC:testnet, but the chain is now ARMED FROM
        // GENESIS (2026-08-18), and ARMED WINS, so the window can never open again: the
        // predicate answers false on BOTH sides of its own threshold. Kept as an entry
        // rather than deleted, because deleting map keys mid-suite is the exact footgun
        // the scratch-arm block below documents.
        assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(147999, 'testnet', 'BTC'), false);
        assert.strictEqual(SUB.isEscrowLockedLeafShadowActive(148000, 'testnet', 'BTC'), false);
        // The committed output DID change, deliberately: the leaf is live at every
        // testnet height so the launch exercises locked-balance proofs for real.
        assert.strictEqual(SUB.isEscrowLockedLeafActive(148000, 'testnet', 'BTC'), true);
        assert.strictEqual(SUB.isEscrowLockedLeafActive(0, 'testnet', 'BTC'), true);
        // Scratch-arm both: shadow answers true only BETWEEN its own height and
        // the armed height, so each height uses exactly one column and nothing
        // ever computes twice (spec §7; same contract as isSubtreeShadowActive).
        // Snapshot both keys, because BTC:regtest now carries a REAL armed height and
        // the cleanup below used to `delete` them. While the map was empty, delete and
        // restore were indistinguishable; the moment a height exists, deleting it
        // silently DISARMS the chain for every later test in the process. That is not
        // hypothetical: it is exactly what the Stage A arming hit, and it presented as
        // an armed-height assertion failing while the same gate answered armed
        // elsewhere in the run.
        const hadShadow = Object.prototype.hasOwnProperty.call(SUB.ESCROW_LOCKED_LEAF_SHADOW, 'BTC:regtest');
        const priorShadow = SUB.ESCROW_LOCKED_LEAF_SHADOW['BTC:regtest'];
        const hadArmed = Object.prototype.hasOwnProperty.call(SUB.ESCROW_LOCKED_LEAF_ACTIVATION, 'BTC:regtest');
        const priorArmed = SUB.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'];
        try {
            SUB.ESCROW_LOCKED_LEAF_SHADOW['BTC:regtest']     = 500;
            SUB.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'] = 800;
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
        } finally {
            // RESTORE, never delete: see the snapshot comment above.
            if(hadShadow) SUB.ESCROW_LOCKED_LEAF_SHADOW['BTC:regtest'] = priorShadow;
            else delete SUB.ESCROW_LOCKED_LEAF_SHADOW['BTC:regtest'];
            if(hadArmed) SUB.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'] = priorArmed;
            else delete SUB.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'];
        }
        // And the real armed set survived this test, which is the assertion that
        // catches a regression in the restore itself.
        assert.strictEqual(SUB.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'], 11200,
            'restored to the real armed height, not wiped');
    });

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
        // BTC:testnet has no version boundary at its Stage A height, because the escrow
        // leaf is armed there from genesis and any live slot mints version 2. The
        // per-chain-boundary property is carried by BTC:regtest above, which flips at
        // exactly 10000.
        assert.strictEqual(SUB.stateRootVersion(146499, 'testnet', 'BTC'), 2);
        assert.strictEqual(SUB.stateRootVersion(146500, 'testnet', 'BTC'), 2);
        assert.strictEqual(SUB.stateRootVersion(0, 'testnet', 'BTC'), 2);
        // Mainnet is the network with no armed slot at all, so it is the one that still
        // proves the version is not simply hardcoded to 2.
        assert.strictEqual(SUB.stateRootVersion(999999999, 'mainnet', 'BTC'), 1);
        // The frozen wire constant still declares 1: it is the FLOOR every chain
        // starts at, not a claim about armed chains, and merkle.js does not know
        // about heights. The per-height value is what api.js reports.
        assert.strictEqual(M.STATE_ROOT_VERSION, 1);
    });

    it('the activation maps hold EXACTLY the armed set (arming is a code change, not config)', function(){
        assert.deepStrictEqual(SUB.STATE_SUBTREE_ACTIVATION.ownership_root, {});
        assert.deepStrictEqual(SUB.STATE_SUBTREE_ACTIVATION.tokens_root, {});
        assert.deepStrictEqual(SUB.STATE_SUBTREE_ACTIVATION.contract_state_root,
            { 'BTC:regtest': 10000, 'BTC:testnet': 146500 });
        // Stage B armed on the same chain, above Stage A's height: it cannot arm before
        // Stage A holds, and 11200 > 10000 pins that ordering here rather than in prose.
        // It is deliberately still REGTEST-ONLY: each stage is its own flag day, so a
        // Stage A testnet arming must not drag Stage B onto testnet with it.
        assert.deepStrictEqual(SUB.ESCROW_LOCKED_LEAF_ACTIVATION,
            // All three testnet chains armed at genesis 2026-08-18 (pre-launch ruling:
            // every feature live on testnet). Pinned exactly, so an arming anywhere else
            // - mainnet above all - still fails here.
            { 'BTC:regtest': 11200, 'BTC:testnet': 0, 'LTC:testnet': 0, 'DOGE:testnet': 0 });
        assert.ok(SUB.ESCROW_LOCKED_LEAF_ACTIVATION['BTC:regtest'] >
                  SUB.STATE_SUBTREE_ACTIVATION.contract_state_root['BTC:regtest'],
            'Stage B must not arm below the Stage A height on the same chain');
        // The §7 shadow window, which is deliberately NOT the same kind of entry as
        // the two maps above: it commits nothing, so it is not a flag day, but it
        // does start the source's journal writer on the named chain and it must be
        // registered here for the same reason arming is - so that opening one is a
        // reviewed code change and never a quiet config edit.
        assert.deepStrictEqual(SUB.ESCROW_LOCKED_LEAF_SHADOW, { 'BTC:testnet': 148000 });
        // The window must sit ABOVE the chain's own first indexed block (147500
        // after the 2026-08-10 re-genesis), or its start block is a height the
        // chain will never reach going forward and the window never opens at all.
        assert.ok(SUB.ESCROW_LOCKED_LEAF_SHADOW['BTC:testnet'] > 147500,
            'the shadow window must start above BTC:testnet\'s post-re-genesis first block');
    });

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
        const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../src/state_subtree_activation.js'), 'utf8');
        assert.ok(!/process\.env/.test(src), 'state_subtree_activation.js must not read process.env');
    });
});

describe('state_root reserved sub-trees: gateSubRoots @regression', function(){

    const candidates = {
        ownership_root:      rootFor('own'),
        tokens_root:         rootFor('tok'),
        contract_state_root: rootFor('cst')
    };

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
        const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../src/stateCommitment.js'), 'utf8');
        const sites = src.match(/assembleStateRoot\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*\)/g) || [];
        assert.ok(sites.length >= 1, 'no three-argument assembleStateRoot site found in stateCommitment.js');
        for(const s of sites)
            assert.ok(/,\s*extraSubRoots\s*\)$/.test(s), 'assembleStateRoot site "' + s + '" does not pass extraSubRoots');
        const assigns = src.match(/extraSubRoots\s*=[^=][^\n;]*/g) || [];
        assert.ok(assigns.length >= 1, 'no extraSubRoots assignment found in stateCommitment.js');
        for(const a of assigns)
            assert.ok(/SUB\.gateSubRoots\(/.test(a), 'extraSubRoots assigned outside the gate: ' + a);
    });

    it('an armed escrow leaf flips the derived version to 2 (leaf-set changes are never version-invisible)', function(){
        // Stage B moves the contents of balances_root, not the slot list, but a
        // changed committed leaf set must be visible in state_root_version all
        // the same (design doc §3 Stage B, version decision).
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
        // reach merkle.stateRoot and cannot be used to smuggle a slot in.
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
        // The §4.4 sub_root_path a light client would use once a slot is armed.
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
