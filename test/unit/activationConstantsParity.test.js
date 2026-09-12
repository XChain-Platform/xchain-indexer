/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/activationConstantsParity.test.js
 *
 * Arms the byte-equality claim each snapshot-block activation module's header
 * makes but that no suite previously enforced (review 2757 checkpoint_commitment,
 * 2758 cross_chain_royalty). Each module is a LOCAL COPY of the canonical map in
 * xchain-documentation/protocol/constants.js; a one-sided edit of any copy's
 * mainnet/testnet/regtest height forks the signed checkpoint / XMATCH canonical at
 * the flag-day with no CI failure. These modules are NOT in the reference-impl
 * conformance loop (no reference-impl copy exists) and cross_chain_royalty is not
 * vendored into xchain-sync, so the guard is anchored on the canonical constants.js
 * map that IS present. Skips green when the docs sibling is absent, unless
 * XCHAIN_REQUIRE_SIBLINGS=1 (CI) forces a hard failure.
 *
 * THE ABSENT-CHECKOUT BRANCH IS ITSELF A TEST CASE. A guard whose only behaviour on a
 * missing sibling is a bare skip reports a green run over nothing, and this guard is
 * what arming a network's flag day rests on. So the decision is a pure function asserted
 * below whatever the checkout state is, the parity cases name the exact path they looked
 * for in their titles rather than collapsing into a generic pending line, and a coverage
 * floor case runs unconditionally so a renamed module or export cannot quietly leave the
 * suite comparing nothing.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CONSTANTS_PATH = path.resolve(__dirname, '../../../xchain-documentation/protocol/constants.js');

// module filename in src/ -> the named export it and constants.js share.
const GATES = [
    ['checkpoint_commitment_activation.js', 'CHECKPOINT_COMMITMENT_ACTIVATION'],
    ['cross_chain_royalty_activation.js',   'CROSS_CHAIN_ROYALTY_ACTIVATION'],
    ['attest_admission_activation.js',      'ATTEST_ADMISSION_ACTIVATION'],
    ['attest_request_cap_activation.js',    'ATTEST_REQUEST_CAP_ACTIVATION'],
    // Not an activation MAP but the consensus constants that gate reads: the caps decide
    // which requests are admitted at the flag-day exactly as the heights decide when.
    ['attest_request_cap_activation.js',    'ATTEST_REQUEST_CAPS'],
    ['attest_relay_activation.js',          'ATTEST_RELAY_ACTIVATION'],
    ['attest_broadcast_fee_activation.js',  'ATTEST_BROADCAST_FEE_ACTIVATION'],
    // Not an activation MAP but a consensus constant the same gate reads: the cap clamps the
    // escrow carve-out, so a one-sided edit changes the amount paid at the flag-day exactly as a
    // one-sided height edit changes when it is paid.
    ['attest_broadcast_fee_activation.js',  'ATTEST_BROADCAST_FEE_CAP'],
    ['attest_responsible_widening_activation.js',      'ATTEST_RESPONSIBLE_WIDENING_ACTIVATION'],
    // Not an activation MAP but the consensus constants the same gate reads: the ladder's
    // confirmations and maxSlots decide WHICH validators may sign at the flag-day exactly as
    // the heights decide when, so a one-sided edit forks v1 signature admission.
    ['attest_responsible_widening_activation.js',      'ATTEST_RESPONSIBLE_WIDENING'],
    // The height that decides whether a finalized response reaches indexers as an on-chain
    // ATTEST v1 or through the hub mirror. It also selects which CANONICAL the responsible set
    // signs, so a one-sided edit forks attestation settlement AND signature admission at once.
    ['attest_response_mirror_activation.js',           'ATTEST_RESPONSE_MIRROR_ACTIVATION'],
    // The zero-confirmation flip's ONE height (spec attest-zero-confirmation-flip.md §8, D9,
    // D19): a one-sided edit forks confirmationsFor's leader/model index, the V2 ladder
    // selector and the applier fall-through all at once, on whichever side reads the stale copy.
    ['attest_zero_conf_activation.js',                  'ATTEST_ZERO_CONF_ACTIVATION'],
    // Not an activation MAP but the stage-2 ladder constants the same height selects (D30):
    // headroom, startOffset and maxSlots decide WHO MAY SIGN above the flag-day exactly as
    // ATTEST_RESPONSIBLE_WIDENING does below it, so a one-sided edit forks v1 signature
    // admission the same way a one-sided height edit would.
    ['attest_responsible_widening_activation.js',       'ATTEST_RESPONSIBLE_WIDENING_V2'],
    ['anchor_reward_activation.js',         'ANCHOR_REWARD_DERIVE_ACTIVATION'],
    ['anchor_activation.js',                'ANCHOR_ACTIVATION'],
    // constants.js claims the whole anchor/archive reward block is "kept byte-identical to
    // the local copies ... by the cross-service regression suite"; these are the exports of
    // that block nothing else compared to canon (ARCHIVE_REWARD_ACTIVATION is locked by
    // flagdayPlaceholderGuard.test.js). The amounts and maturity are scalars, not maps.
    ['anchor_reward_activation.js',         'ANCHOR_REWARD_ACTIVATION'],
    ['anchor_reward_activation.js',         'ANCHOR_REWARD_AMOUNT'],
    ['anchor_reward_activation.js',         'ARCHIVE_REWARD_AMOUNT'],
    ['anchor_reward_activation.js',         'ANCHOR_REWARD_MIRROR_MATURITY'],
    ['price_pair_activation.js',            'PRICE_PAIR_WIDEN_ACTIVATION'],
    // The consensus wire-format bounds that gate selects between: canon says a change is
    // "a one-line edit here plus the byte-equal edit in the vendored copies", so lock them.
    ['price_pair_activation.js',            'PRICE_PAIR_TICKER_MAX_LEGACY'],
    ['price_pair_activation.js',            'PRICE_PAIR_TICKER_MAX_WIDE'],
    ['price_sig_tally_activation.js',       'PRICE_SIG_TALLY_ACTIVATION'],
    // The height at which fee pricing stops selecting rounds the chain has not yet shown
    // the node. A one-sided edit forks fee validity between a hub-connected node and a
    // chain-only node at the boundary, which is the divergence the gate exists to close.
    ['price_fee_batch_landed_activation.js', 'PRICE_FEE_BATCH_LANDED_ACTIVATION'],
    // The PLATFORM TRAIN gate (release-management section 13), keyed by platform version
    // rather than by feature. A one-sided edit here is worse than a one-sided feature-gate
    // edit: this map is what decides whether a node HALTS at a train boundary or applies
    // the block under the old rules, so a drifted copy is a node that forks at the one
    // boundary the mechanism exists to make safe. The twin lives in xchain-sync.
    ['train_activation.js',                'TRAIN_ACTIVATION'],
    // The height at which a retired signing key stops being permanently burned: below it
    // STAKE v1 refuses any pubkey that ever held a valid stakes row, at/above it a pubkey
    // whose every row is deactivated and past cooldown is admitted. A one-sided edit forks
    // STAKE v1 admission, and with it the bond debit, the escrow row and capability-set
    // membership, all of which land in hashed history.
    ['stake_key_reuse_activation.js',      'STAKE_KEY_REUSE_ACTIVATION'],
    // The height at which a SWEEP stops writing a zero-amount debit and credit leg for a
    // held tick with nothing to move. Those rows are in the per-block ledger hash, so a
    // one-sided edit forks the ledger hash at the first zero-balance sweep past the boundary.
    ['sweep_zero_leg_activation.js',       'SWEEP_ZERO_LEG_ACTIVATION'],
    // The XCHAIN bridge flag day. A one-sided edit forks the bridge at the boundary in the
    // worst direction available: the destination chain mints from a transfer record the
    // source chain's copy says was never legal to sign, or refuses one it did sign.
    ['xchain_bridge_activation.js',        'XCHAIN_BRIDGE_ACTIVATION'],
    // The general token-bridge flag day (XBRIDGE v3/v4/v5, ISSUE format 7). Same fork
    // surface, plus the ordering invariant asserted separately below.
    ['token_bridge_activation.js',         'TOKEN_BRIDGE_ACTIVATION'],
    // The policy-inheritance flag day. It decides whether a mirrored policy_snapshots row is
    // applied at all, so a one-sided edit has one destination enforcing an issuer's block list
    // on a bridged copy while another still admits the transfer, from the same signed row.
    // Both ordering invariants it owes are asserted separately below.
    ['token_policy_activation.js',         'TOKEN_POLICY_INHERITANCE_ACTIVATION'],
    // The LIST owner check. It re-verdicts every historical third-party LIST edit,
    // and list_items is a hashed DERIVED table, so a one-sided edit forks the chain at the
    // boundary in the most ordinary traffic there is.
    ['list_owner_activation.js',           'LIST_OWNER_ACTIVATION'],
    // Not activation MAPS but the consensus constants the bridge and policy passes read: the
    // per-block caps decide WHICH rows land in WHICH block (an action-index change, so a hash
    // change), and XPOLICY_MAX_MEMBERS decides which opt-in is refused. A one-sided edit to any
    // of the three diverges two nodes running the same flag day.
    ['protocol/constants.js',              'XBRIDGE_MAX_PER_BLOCK'],
    ['protocol/constants.js',              'XPOLICY_MAX_PER_BLOCK'],
    ['protocol/constants.js',              'XPOLICY_MAX_MEMBERS'],
    // The tick-namespace flag day (R8). It re-verdicts nothing below itself, but at
    // the boundary it decides whether an ISSUE of a short or listed name is 'invalid: TICK
    // (length)' / 'invalid: TICK (reserved)' or a live token row, so a one-sided height edit
    // has one node holding a root the next node just sold.
    ['tick_namespace_activation.js',       'TICK_NAMESPACE_ACTIVATION'],
    // Not an activation MAP but the reserved SET that gate reads, and the list equality is the
    // point: membership decides a verdict, so a name present on one side and absent on the
    // other forks the chain the first time anyone issues it. deepStrictEqual over the array
    // pins ORDER too, which a set comparison would let drift silently.
    ['reservedRoots.js',                   'RESERVED_FUTURE_ROOTS'],
    ['snapshot_reorg_buffer.js',           'SNAPSHOT_BURIAL_ACTIVATION'],
    // The burial depth that gate reads; canon claims it byte-identical to the local copies.
    ['snapshot_reorg_buffer.js',           'CANONICAL_REORG_BUFFER'],
];

// What this suite does about the canonical checkout, isolated from fs and from mocha's
// own skip machinery so both branches are directly assertable. The suite cannot delete a
// sibling repo to reach the absent branch, so the branch is tested here instead.
function resolveCanonSource(canonExists, requireSiblings) {
    if (canonExists) return { status: 'checked' };
    if (requireSiblings)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but canonical constants not found at ' + CONSTANTS_PATH);
    return { status: 'skipped', reason: 'documentation checkout absent at ' + CONSTANTS_PATH };
}

describe('activation-gate constant parity to canonical constants.js @regression', function () {
    const canonExists = fs.existsSync(CONSTANTS_PATH);

    it('reports skipped and names the exact checkout path when the documentation checkout is absent', function () {
        const result = resolveCanonSource(false, false);
        assert.strictEqual(result.status, 'skipped');
        assert.strictEqual(result.reason, 'documentation checkout absent at ' + CONSTANTS_PATH);
    });

    it('throws rather than skipping on an absent checkout when XCHAIN_REQUIRE_SIBLINGS=1', function () {
        assert.throws(() => resolveCanonSource(false, true), /XCHAIN_REQUIRE_SIBLINGS=1/);
        assert.strictEqual(resolveCanonSource(true, true).status, 'checked');
    });

    // The coverage floor. Every parity case below is skipped without the sibling, and each
    // one resolves its constant by string, so a renamed module or export would otherwise
    // surface only as a green run. This case runs either way and fails on both.
    it('resolves every gated constant from its local module, whatever the checkout state', function () {
        assert.ok(GATES.length >= 25, 'the gate list has shrunk; a dropped entry is an unpinned flag day');
        for (const [file, exportName] of GATES) {
            const local = require('../../src/' + file)[exportName];
            assert.ok(local !== undefined,
                file + ' no longer exports ' + exportName + '; the parity case for it would compare ' +
                'undefined to undefined and pass vacuously');
        }
    });

    // The train gate is the one map here whose copies must be BYTE-identical rather than
    // merely value-identical, because the two copies are the same halt decision compiled
    // into two services: the indexer stops applying blocks and the sync follower stops
    // following, and the header text is what tells an operator which. Value parity to the
    // canon is covered by the GATES case below; this is the twin half of it.
    it('holds xchain-sync/src/train_activation.js byte-identical to this repo\'s copy', function () {
        const here = path.resolve(__dirname, '../../src/train_activation.js');
        const twin = path.resolve(__dirname, '../../../xchain-sync/src/train_activation.js');
        assert.ok(fs.existsSync(here), 'the indexer train-activation gate is missing at ' + here);
        if (!fs.existsSync(twin)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the sync twin is absent at ' + twin);
            this.skip();
            return;
        }
        assert.strictEqual(fs.readFileSync(twin, 'utf8'), fs.readFileSync(here, 'utf8'),
            'xchain-sync/src/train_activation.js has drifted from the indexer copy; the two are ' +
            'vendored twins and a one-sided edit forks the fleet at the train boundary.');
    });

    // §3.2 b, D9: the indexer half of the height-ordering invariant the hub asserts at boot
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

    // Token-bridge spec section 8, D25: the general formats ride the XCHAIN bridge's engine,
    // its mirrored bridge_transfers table and its settle pass, so v3 can never be legal on a
    // network where v0 is not. Read straight off the canon, not off the local copies, so a
    // canon that itself violated the rule is caught. Runs over every network the canon
    // declares rather than a hardcoded list; the not-vacuous check pins today's live case.
    it('holds TOKEN_BRIDGE_ACTIVATION >= XCHAIN_BRIDGE_ACTIVATION over the canonical constants.js', function () {
        if (!canonExists) { this.skip(); return; }
        const token  = canon.TOKEN_BRIDGE_ACTIVATION;
        const bridge = canon.XCHAIN_BRIDGE_ACTIVATION;
        assert.ok(token && bridge, 'constants.js must export both bridge activation maps');
        const nets = Object.keys(token).filter(net => token[net] !== null && token[net] !== undefined);
        assert.ok(nets.includes('regtest'), 'not vacuous: regtest must be armed at this milestone');
        for (const net of nets) {
            assert.ok(bridge[net] !== null && bridge[net] !== undefined,
                'TOKEN_BRIDGE_ACTIVATION.' + net + ' is armed but XCHAIN_BRIDGE_ACTIVATION.' + net + ' is not');
            assert.ok(token[net] >= bridge[net],
                'TOKEN_BRIDGE_ACTIVATION.' + net + ' (' + token[net] + ') is below XCHAIN_BRIDGE_ACTIVATION.' +
                net + ' (' + bridge[net] + '); a train arming v3 with no engine behind it admits locks ' +
                'nothing can finalize');
        }
    });

    // Policy spec section 9, D28, invariant one of two: inheritance cannot arm before the
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
        const lists  = require('../../src/list_edit_resolution_activation.js').LIST_EDIT_RESOLUTION_ACTIVATION;
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

    // Token spec section 3, R8: the namespace is deliberately NOT keyed on the bridge's own
    // height, because the bridge arms only after the base spec's D2 checkpoint cross-check
    // while the namespace has to close BEFORE anyone squats, not after. Sizing it after the
    // bridge would leave a window in which foreign assets are being rooted on this chain and
    // the roots they need are still purchasable, which is the one ordering that defeats the
    // reservation. Read off the canon so a canon that itself violated the rule is caught.
    it('holds TICK_NAMESPACE_ACTIVATION <= TOKEN_BRIDGE_ACTIVATION over the canonical constants.js', function () {
        if (!canonExists) { this.skip(); return; }
        const ns    = canon.TICK_NAMESPACE_ACTIVATION;
        const token = canon.TOKEN_BRIDGE_ACTIVATION;
        assert.ok(ns && token, 'constants.js must export both the namespace and the token-bridge maps');
        const nets = Object.keys(token).filter(net => token[net] !== null && token[net] !== undefined);
        assert.ok(nets.includes('regtest'), 'not vacuous: regtest must be armed at this milestone');
        for (const net of nets) {
            assert.ok(ns[net] !== null && ns[net] !== undefined,
                'TOKEN_BRIDGE_ACTIVATION.' + net + ' is armed but TICK_NAMESPACE_ACTIVATION.' + net + ' is not');
            assert.ok(ns[net] <= token[net],
                'TICK_NAMESPACE_ACTIVATION.' + net + ' (' + ns[net] + ') is above TOKEN_BRIDGE_ACTIVATION.' +
                net + ' (' + token[net] + '); the bridge would be rooting foreign assets while the roots ' +
                'they need are still on sale');
        }
    });

    // The shape of the reserved list itself, asserted on the LOCAL copy so it runs without the
    // documentation sibling. The parity case above proves the two copies match; this proves the
    // thing they match is usable as a case-folded membership test at all. A lower-case or
    // duplicated entry would not throw anywhere, it would just quietly fail to reserve a chain.
    it('holds RESERVED_FUTURE_ROOTS frozen, upper-case and duplicate-free at the surveyed width', function () {
        const roots = require('../../src/reservedRoots.js').RESERVED_FUTURE_ROOTS;
        assert.ok(Array.isArray(roots), 'RESERVED_FUTURE_ROOTS must be an array');
        assert.ok(Object.isFrozen(roots), 'RESERVED_FUTURE_ROOTS must be frozen; a reserved set a caller can push to is not a rule');
        // 47 measured free on 2026-09-11 plus the 6 squatted in the mainnet genesis manifests.
        assert.strictEqual(roots.length, 53, 'the surveyed list is 47 free names plus 6 reclaimed ones');
        for (const t of roots) {
            assert.ok(/^[A-Z]{2,}$/.test(t), 'reserved root ' + JSON.stringify(t) + ' is not an upper-case ticker; ' +
                'the guard folds the candidate up, so a lower-case entry can never match');
        }
        assert.strictEqual(new Set(roots).size, roots.length, 'RESERVED_FUTURE_ROOTS carries a duplicate');
    });

    // The membership test the ISSUE guard will call, driven rather than described: it is the
    // case fold that matters (every tick lookup is LOWER(tick), so an exact-case test would
    // leave 'eth' free to take the row getTokenInfo('ETH') returns).
    it('refuses a listed root in any case and admits an unlisted one', function () {
        const { isReservedFutureRoot } = require('../../src/reservedRoots.js');
        assert.strictEqual(isReservedFutureRoot('ETH'), true);
        assert.strictEqual(isReservedFutureRoot('eth'), true);
        assert.strictEqual(isReservedFutureRoot('EtH'), true);
        assert.strictEqual(isReservedFutureRoot('NEAR'), true);
        assert.strictEqual(isReservedFutureRoot('ABCD'), false);
        assert.strictEqual(isReservedFutureRoot('ETHX'), false, 'membership is exact, never a prefix');
        assert.strictEqual(isReservedFutureRoot(null), false, 'a non-string fails closed rather than throwing in a verdict path');
    });

    let canon = null;
    before(function () {
        if (resolveCanonSource(canonExists, process.env.XCHAIN_REQUIRE_SIBLINGS === '1').status !== 'checked') return;
        canon = require(CONSTANTS_PATH);
    });

    GATES.forEach(function ([file, exportName]) {
        const title = canonExists
            ? file + ' ' + exportName + ' is value-identical to xchain-documentation/protocol/constants.js'
            : 'SKIPPED: documentation checkout absent at ' + CONSTANTS_PATH + '; ' + file + ' ' +
              exportName + ' parity not verified this run';
        (canonExists ? it : it.skip)(title, function () {
            const local = require('../../src/' + file)[exportName];
            // Presence, not shape: the list carries scalar consensus constants as well as
            // activation maps. The checks stay so a mistyped export name cannot compare
            // undefined to undefined and pass vacuously on both sides.
            assert.ok(local !== undefined, file + ' must export ' + exportName);
            assert.ok(canon[exportName] !== undefined,
                'constants.js must export ' + exportName + ' (the canonical authority for this gate)');
            assert.deepStrictEqual(local, canon[exportName],
                file + ' has drifted from the canonical ' + exportName + ' in ' +
                'xchain-documentation/protocol/constants.js; a one-sided flag-day edit forks consensus at the boundary.');
        });
    });
});
