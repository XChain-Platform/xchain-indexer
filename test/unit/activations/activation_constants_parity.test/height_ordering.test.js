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
 * The height-ordering invariants between activation maps, read straight off the canonical
 * xchain-documentation/protocol/constants.js so a canon that itself violated one is caught:
 * zero-conf above mirror and widening, token bridge above XCHAIN bridge, policy inheritance
 * above the token bridge and the list-edit resolution, and the tick namespace below the
 * token bridge. Part of the suite whose entry is test/unit/activation_constants_parity.test.js;
 * every case is pending when the documentation checkout is absent or refused.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

// The canonical checkout verdict and the before-all hook shared with the suite entry.
const { canonExists, loadCanon } = require('./helpers/canon_source.js');

// The threshold a chain identified by `key` actually reads out of `map`: the exact key when
// the map declares one, otherwise the bare network half of a '<COIN>:<network>' key. This is
// the same fallback xchain_bridge_activation._activationThreshold and
// stake_key_reuse_activation._activationThreshold implement, restated here because the
// ordering invariants below compare two maps that are keyed at DIFFERENT granularities and a
// bare-key-only comparison would silently stop covering the coin-keyed slots.
function resolveChainKey(map, key) {
    if (map[key] !== undefined) return map[key];
    const net = key.indexOf(':') >= 0 ? key.slice(key.indexOf(':') + 1) : key;
    return map[net];
}

// The canonical map, loaded by each block's before-all hook.
let canon = null;

describe('activation-gate constant parity to canonical constants.js @regression', function () {
    before(function () { canon = loadCanon(); });

    // The indexer half of the height-ordering invariant the hub asserts at boot
    // (attest_zero_conf_activation.assertZeroConfOrdering). Read straight off the canon, not
    // off the local copies, so this case would catch a canon that itself violated the rule.
    // Runs over EVERY network the canon declares, never a hardcoded list, so a network added
    // later is covered automatically; the not-vacuous check pins today's live case (regtest).
    it('holds the zero-conf >= max(mirror, widening) ordering over the canonical constants.js', function () {
        if (!canonExists) { this.skip(); return; }
        const zc       = canon.ATTEST_ZERO_CONF_ACTIVATION;
        const mirror    = canon.ATTEST_RESPONSE_MIRROR_ACTIVATION;
        const widening  = canon.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION;
        const armedNets = Object.keys(zc).filter(net => zc[net] !== null && zc[net] !== undefined);
        assert.ok(armedNets.includes('regtest'), 'not vacuous: regtest must be armed at this milestone');
        for (const net of armedNets) {
            assert.ok(mirror[net] !== null && mirror[net] !== undefined,
                'ATTEST_ZERO_CONF_ACTIVATION.' + net + ' is armed but ATTEST_RESPONSE_MIRROR_ACTIVATION.' + net + ' is not');
            assert.ok(widening[net] !== null && widening[net] !== undefined,
                'ATTEST_ZERO_CONF_ACTIVATION.' + net + ' is armed but ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.' + net + ' is not');
            assert.ok(zc[net] >= Math.max(mirror[net], widening[net]),
                'ATTEST_ZERO_CONF_ACTIVATION.' + net + ' (' + zc[net] + ') is below max(mirror ' +
                mirror[net] + ', widening ' + widening[net] + ')');
        }
    });
});

describe('activation-gate constant parity to canonical constants.js @regression', function () {
    before(function () { canon = loadCanon(); });

    // Token-bridge ordering: the general formats ride the XCHAIN bridge's engine,
    // its mirrored bridge_transfers table and its settle pass, so v3 can never be legal on a
    // chain where v0 is not. Read straight off the canon, not off the local copies, so a
    // canon that itself violated the rule is caught.
    //
    // PER CHAIN KEY, not per network (row 28). XCHAIN_BRIDGE_ACTIVATION is keyed
    // '<COIN>:<network>' with a bare network fallback while TOKEN_BRIDGE_ACTIVATION is still
    // network-keyed, so comparing the bare keys alone would leave every coin-keyed bridge
    // height unchecked the moment the arming train writes one. The union of both maps' keys
    // is walked and each side is resolved through the SAME fallback the predicates use, so a
    // 'DOGE:testnet' bridge height is compared against the height a DOGE testnet chain
    // actually reads out of the token map.
    it('holds TOKEN_BRIDGE_ACTIVATION >= XCHAIN_BRIDGE_ACTIVATION for every chain key', function () {
        if (!canonExists) { this.skip(); return; }
        const token  = canon.TOKEN_BRIDGE_ACTIVATION;
        const bridge = canon.XCHAIN_BRIDGE_ACTIVATION;
        assert.ok(token && bridge, 'constants.js must export both bridge activation maps');
        const keys = [...new Set([...Object.keys(token), ...Object.keys(bridge)])];
        const compared = [];
        for (const key of keys) {
            const here  = resolveChainKey(token, key);
            const there = resolveChainKey(bridge, key);
            if (here === null || here === undefined) continue;
            assert.ok(there !== null && there !== undefined,
                'TOKEN_BRIDGE_ACTIVATION resolves ' + key + ' but XCHAIN_BRIDGE_ACTIVATION does not');
            compared.push(key);
            assert.ok(here >= there,
                'TOKEN_BRIDGE_ACTIVATION for ' + key + ' (' + here + ') is below XCHAIN_BRIDGE_ACTIVATION for ' +
                key + ' (' + there + '); a train arming v3 with no engine behind it admits locks ' +
                'nothing can finalize');
        }
        assert.ok(compared.includes('regtest'), 'not vacuous: regtest must be armed at this milestone');
        assert.ok(compared.some(k => k.indexOf(':') >= 0),
            'not vacuous: the coin-keyed slots must be compared, not just the bare network keys');
    });
});

describe('activation-gate constant parity to canonical constants.js @regression', function () {
    before(function () { canon = loadCanon(); });

    // Policy ordering, invariant one of two: inheritance cannot arm before the
    // token bridge, because there are no bridged copies for a policy to bind until v3 locks
    // are legal, and a snapshot signed with nothing to apply it to is a row every destination
    // carries forward forever. Read off the canon, not the local copies, so a canon that
    // itself violated the rule is caught. Every network the canon declares, never a hardcoded
    // list; the not-vacuous check pins today's live case.
    it('holds TOKEN_POLICY_INHERITANCE_ACTIVATION >= TOKEN_BRIDGE_ACTIVATION over the canonical constants.js', function () {
        if (!canonExists) { this.skip(); return; }
        const policy = canon.TOKEN_POLICY_INHERITANCE_ACTIVATION;
        const token  = canon.TOKEN_BRIDGE_ACTIVATION;
        assert.ok(policy && token, 'constants.js must export both the policy and the token-bridge activation maps');
        const nets = Object.keys(policy).filter(net => policy[net] !== null && policy[net] !== undefined);
        assert.ok(nets.includes('regtest'), 'not vacuous: regtest must be armed at this milestone');
        for (const net of nets) {
            assert.ok(token[net] !== null && token[net] !== undefined,
                'TOKEN_POLICY_INHERITANCE_ACTIVATION.' + net + ' is armed but TOKEN_BRIDGE_ACTIVATION.' + net + ' is not');
            assert.ok(policy[net] >= token[net],
                'TOKEN_POLICY_INHERITANCE_ACTIVATION.' + net + ' (' + policy[net] + ') is below TOKEN_BRIDGE_ACTIVATION.' +
                net + ' (' + token[net] + '); a train arming inheritance with no bridged copies to bind signs ' +
                'snapshots nothing can apply');
        }
    });

    // Invariant two of two: the snapshot read resolves a list AS OF origin_block by walking
    // the edit chain (getListAtBlock), and below LIST_EDIT_RESOLUTION_ACTIVATION the legacy
    // create-index read runs instead, so the membership the federation would sign is not the
    // membership the origin chain enforced. That map is indexer-local and keyed
    // '<COIN>:<network>' with a bare network fallback, so every chain key is checked against
    // its network's single policy height; the policy map comes off the canon.
    it('holds TOKEN_POLICY_INHERITANCE_ACTIVATION >= LIST_EDIT_RESOLUTION_ACTIVATION for every chain key', function () {
        if (!canonExists) { this.skip(); return; }
        const policy = canon.TOKEN_POLICY_INHERITANCE_ACTIVATION;
        const lists  = require('../../../../src/consensus/gate_registry').get('list_edit_resolution_activation.LIST_EDIT_RESOLUTION_ACTIVATION');
        assert.ok(policy && lists, 'both maps must resolve');
        let compared = 0;
        for (const key of Object.keys(lists)) {
            const listHeight = lists[key];
            if (listHeight === null || listHeight === undefined) continue;
            // 'BTC:mainnet' -> mainnet; a bare 'regtest' key is its own network.
            const net = key.indexOf(':') >= 0 ? key.slice(key.indexOf(':') + 1) : key;
            const here = policy[net];
            if (here === null || here === undefined) continue;
            compared++;
            assert.ok(here >= listHeight,
                'TOKEN_POLICY_INHERITANCE_ACTIVATION.' + net + ' (' + here + ') is below ' +
                'LIST_EDIT_RESOLUTION_ACTIVATION.' + key + ' (' + listHeight + '); getListAtBlock would fall back ' +
                'to the legacy create-index read and the federation would sign a membership the chain never held');
        }
        assert.ok(compared >= 4, 'not vacuous: expected at least the three mainnet chain keys plus regtest, compared ' + compared);
    });
});

describe('activation-gate constant parity to canonical constants.js @regression', function () {
    before(function () { canon = loadCanon(); });

    // Tick namespace ordering: the namespace is deliberately NOT keyed on the bridge's own
    // height, because the bridge arms only after the base bridge's checkpoint cross-check
    // while the namespace has to close BEFORE anyone squats, not after. Sizing it after the
    // bridge would leave a window in which foreign assets are being rooted on this chain and
    // the roots they need are still purchasable, which is the one ordering that defeats the
    // reservation. Read off the canon so a canon that itself violated the rule is caught.
    // PER CHAIN KEY since the v0.20.0 arming train re-keyed TOKEN_BRIDGE_ACTIVATION to
    // '<COIN>:<network>', and TICK_NAMESPACE_ACTIVATION followed it, but either map may carry
    // a chain key the other resolves only by fallback, so each side is resolved through the SAME
    // fallback the predicates use. A bare-key walk would fail on the shape ('BTC:mainnet is
    // armed but the namespace is not') and never reach the question the case exists to ask,
    // which is whether the chain a coin actually reads closes its namespace first.
    it('holds TICK_NAMESPACE_ACTIVATION <= TOKEN_BRIDGE_ACTIVATION over the canonical constants.js', function () {
        if (!canonExists) { this.skip(); return; }
        const ns    = canon.TICK_NAMESPACE_ACTIVATION;
        const token = canon.TOKEN_BRIDGE_ACTIVATION;
        assert.ok(ns && token, 'constants.js must export both the namespace and the token-bridge maps');
        const keys = [...new Set([...Object.keys(token), ...Object.keys(ns)])];
        const compared = [];
        for (const key of keys) {
            const here  = resolveChainKey(token, key);
            const there = resolveChainKey(ns, key);
            if (here === null || here === undefined) continue;
            assert.ok(there !== null && there !== undefined,
                'TOKEN_BRIDGE_ACTIVATION resolves ' + key + ' but TICK_NAMESPACE_ACTIVATION does not');
            compared.push(key);
            assert.ok(there <= here,
                'TICK_NAMESPACE_ACTIVATION for ' + key + ' (' + there + ') is above TOKEN_BRIDGE_ACTIVATION for ' +
                key + ' (' + here + '); the bridge would be rooting foreign assets while the roots ' +
                'they need are still on sale');
        }
        assert.ok(compared.includes('regtest'), 'not vacuous: regtest must be armed at this milestone');
        assert.ok(compared.some(k => k.indexOf(':') >= 0),
            'not vacuous: the coin-keyed slots must be compared, not just the bare network keys');
    });
});
