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
 * in claude/specs/spv-state-subtree-extension.md).
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

const COINS    = ['BTC', 'LTC', 'DOGE'];
const NETWORKS = ['mainnet', 'testnet', 'regtest'];
// Heights spanning genesis, every armed flag-day cohort, and far past any of them.
const HEIGHTS  = [0, 1, 145000, 958500, 962500, 3160000, 6335000, 67500000, 999999999];

// Deterministic stand-in sub-roots (any 32-byte hex works; these are not real trees).
function rootFor(tag){ return M.toHex(M.sha256(Buffer.from('subroot:' + tag, 'utf8'))); }

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

describe('state_root reserved sub-trees: gate is inert @regression', function(){

    it('every reserved slot is off on every chain, network and height', function(){
        for(const name of SUB.RESERVED_SUBTREES)
            for(const coin of COINS)
                for(const network of NETWORKS)
                    for(const h of HEIGHTS)
                        assert.strictEqual(SUB.isSubtreeActive(name, h, network, coin), false,
                            name + ' is armed at ' + coin + '/' + network + '@' + h + '; nothing may be armed yet');
    });

    it('the escrow locked-balance leaf is off on every chain, network and height', function(){
        for(const coin of COINS)
            for(const network of NETWORKS)
                for(const h of HEIGHTS)
                    assert.strictEqual(SUB.isEscrowLockedLeafActive(h, network, coin), false);
    });

    it('stateRootVersion reports 1 everywhere while the slots are inert', function(){
        for(const coin of COINS)
            for(const network of NETWORKS)
                for(const h of HEIGHTS)
                    assert.strictEqual(SUB.stateRootVersion(h, network, coin), 1);
        // Derived version agrees with the frozen constant the wire format declares.
        assert.strictEqual(M.STATE_ROOT_VERSION, 1);
    });

    it('every activation map is empty (arming is a code change, not config)', function(){
        for(const name of SUB.RESERVED_SUBTREES)
            assert.deepStrictEqual(Object.keys(SUB.STATE_SUBTREE_ACTIVATION[name]), []);
        assert.deepStrictEqual(Object.keys(SUB.ESCROW_LOCKED_LEAF_ACTIVATION), []);
    });

    it('every populated activation key is coin-qualified (<COIN>:<network>)', function(){
        // These heights are chain-local block indexes and the chains differ by
        // orders of magnitude, so a bare-network key arms three chains at one
        // number. The bare fallback exists only for shape parity with
        // state_commitment_activation.js; populated maps must never use it.
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

    it('drops every candidate while inert, returning null', function(){
        for(const coin of COINS)
            for(const network of NETWORKS)
                assert.strictEqual(SUB.gateSubRoots(candidates, 999999999, network, coin), null);
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
        // Proves the gate is not a permanent no-op. Mutates a scratch copy of the
        // real map and restores it, so the shipped map stays empty.
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
            delete map['BTC:regtest'];
        }
        // Restored: still inert.
        assert.strictEqual(SUB.isSubtreeActive('contract_state_root', 999999999, 'regtest', 'BTC'), false);
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

    it('falls back from <COIN>:<network> to the bare network key', function(){
        const map = SUB.STATE_SUBTREE_ACTIVATION.tokens_root;
        try {
            map.regtest = 10;
            for(const coin of COINS)
                assert.strictEqual(SUB.isSubtreeActive('tokens_root', 10, 'regtest', coin), true);
            map['BTC:regtest'] = 20;   // the specific key wins over the bare one
            assert.strictEqual(SUB.isSubtreeActive('tokens_root', 10, 'regtest', 'BTC'), false);
            assert.strictEqual(SUB.isSubtreeActive('tokens_root', 20, 'regtest', 'BTC'), true);
            assert.strictEqual(SUB.isSubtreeActive('tokens_root', 10, 'regtest', 'LTC'), true);
        } finally {
            delete map.regtest;
            delete map['BTC:regtest'];
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

    it('the gated block-path value is null today, so the committed root is the v1 root', function(){
        for(const coin of COINS)
            for(const network of NETWORKS){
                const gated = SUB.gateSubRoots({ contract_state_root: rootFor('cst') }, 999999999, network, coin);
                assert.strictEqual(gated, null);
                assert.strictEqual(SC.assembleStateRoot(bal, stk, gated), v1);
            }
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
