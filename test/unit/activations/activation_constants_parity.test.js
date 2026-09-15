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
 * test/unit/activations/activation_constants_parity.test.js
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
 *
 * THE LAYOUT. The height-ordering invariants read off the canon live beside this file in
 * test/unit/activation_constants_parity.test/height_ordering.test.js, and the canonical
 * checkout (its path, the verdict on it, the skip-or-throw decision and the before-all hook)
 * in that directory's helpers/canon_source.js. Every block repeats the suite title, so each
 * full test title is unchanged, and every block carries the hook, so a strict run on an
 * absent or refused checkout still fails rather than skipping.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
// The canonical checkout and the hook that loads it, shared with the height-ordering part.
const { CONSTANTS_PATH, canonExists, resolveCanonSource, loadCanon } =
    require('./activation_constants_parity.test/helpers/canon_source.js');

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
    // The zero-confirmation flip's ONE height, which gates three paths:
    // a one-sided edit forks confirmationsFor's leader/model index, the V2 ladder
    // selector and the applier fall-through all at once, on whichever side reads the stale copy.
    ['attest_zero_conf_activation.js',                  'ATTEST_ZERO_CONF_ACTIVATION'],
    // Not an activation MAP but the stage-2 ladder constants the same height selects:
    // headroom, startOffset and maxSlots decide WHO MAY SIGN above the flag-day exactly as
    // ATTEST_RESPONSIBLE_WIDENING does below it, so a one-sided edit forks v1 signature
    // admission the same way a one-sided height edit would.
    ['attest_responsible_widening_activation.js',       'ATTEST_RESPONSIBLE_WIDENING_V2'],
    ['anchor_reward_activation.js',         'ANCHOR_REWARD_DERIVE_ACTIVATION'],
    ['anchor_activation.js',                'ANCHOR_ACTIVATION'],
    // constants.js claims the whole anchor/archive reward block is "kept byte-identical to
    // the local copies ... by the cross-service regression suite"; these are the exports of
    // that block nothing else compared to canon (ARCHIVE_REWARD_ACTIVATION is locked by
    // flagday_placeholder_guard.test.js). The amounts and maturity are scalars, not maps.
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
    // The PLATFORM TRAIN gate, keyed by platform version
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
    // The tick-namespace flag day. It re-verdicts nothing below itself, but at
    // the boundary it decides whether an ISSUE of a short or listed name is 'invalid: TICK
    // (length)' / 'invalid: TICK (reserved)' or a live token row, so a one-sided height edit
    // has one node holding a root the next node just sold.
    ['tick_namespace_activation.js',       'TICK_NAMESPACE_ACTIVATION'],
    // Not an activation MAP but the reserved SET that gate reads, and the list equality is the
    // point: membership decides a verdict, so a name present on one side and absent on the
    // other forks the chain the first time anyone issues it. deepStrictEqual over the array
    // pins ORDER too, which a set comparison would let drift silently.
    ['consensus/reserved_roots.js',         'RESERVED_FUTURE_ROOTS'],
    ['snapshot_reorg_buffer.js',           'SNAPSHOT_BURIAL_ACTIVATION'],
    // The burial depth that gate reads; canon claims it byte-identical to the local copies.
    ['snapshot_reorg_buffer.js',           'CANONICAL_REORG_BUFFER'],
    // The time-keyed mirror barrier family. Both activation maps: the PRODUCER height decides
    // when a hub starts stamping a signed admission map into the canonical, the CONSUMER height
    // decides when an indexer starts binding rows by that map instead of by
    // effective_time <= t(B). A one-sided edit to either forks the family in the worst
    // direction the design has: one node binds a mirrored row at a block another node does not,
    // from the same signed bytes, and the invariant that every producer height sits strictly
    // below its consumer height for the same key is only checkable if both copies agree.
    ['mirror_admission_activation.js',     'MIRROR_ADMISSION_ACTIVATION'],
    ['mirror_admission_activation.js',     'MIRROR_ADMISSION_CONSUMER_ACTIVATION'],
    // Not activation MAPS but the consensus constants the same gate reads. The margins decide
    // WHICH BLOCK a row is admissible at exactly as the heights decide when the rule applies:
    // a drifted ADMIT_MARGIN_BLOCKS has a producer stamping a height its peers would refuse,
    // and a drifted ADMIT_MAX_FUTURE_BLOCKS has a follower rejecting an honest row. The
    // per-chain shape of the max map is the part that must not flatten (BTC 6 vs DOGE 60).
    ['mirror_admission_activation.js',     'ADMIT_MARGIN_BLOCKS'],
    ['mirror_admission_activation.js',     'ADMIT_MIN_FUTURE_BLOCKS'],
    ['mirror_admission_activation.js',     'ADMIT_MAX_FUTURE_BLOCKS'],
    // The regtest arming seam itself. The env NAME and the armed HEIGHT are what let one venue
    // lever arm the whole family; a drifted name means the lever silently arms one side only,
    // which is precisely the split a drill exists to rehearse and must never be its default.
    ['mirror_admission_activation.js',     'MIRROR_ADMISSION_REGTEST_ENV'],
    ['mirror_admission_activation.js',     'MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT'],
    // The family's anchor-attest member. The
    // margin is a LEDGER-adjacent input in the same sense as ANCHOR_REWARD_MIRROR_MATURITY: it
    // decides the block at which the barrier opens, so two nodes applying different values
    // certify completeness at different heights for the identical mirror.
    ['anchor_reward_activation.js',        'ANCHOR_ATTEST_ARRIVAL_MARGIN_S'],
    ['anchor_reward_activation.js',        'ANCHOR_ATTEST_BARRIER_ACTIVATION'],
];

// The canonical map, loaded by each block's before-all hook.
let canon = null;

describe('activation-gate constant parity to canonical constants.js @regression', function () {
    before(function () { canon = loadCanon(); });

    it('reports skipped and names the exact checkout path when the documentation checkout is absent', function () {
        const result = resolveCanonSource(false, false);
        assert.strictEqual(result.status, 'skipped');
        assert.strictEqual(result.reason, 'documentation checkout absent at ' + CONSTANTS_PATH);
    });

    it('throws rather than skipping on an absent checkout when XCHAIN_REQUIRE_SIBLINGS=1', function () {
        assert.throws(() => resolveCanonSource(false, true), /XCHAIN_REQUIRE_SIBLINGS=1/);
        assert.strictEqual(resolveCanonSource(true, true).status, 'checked');
    });

    // A refused checkout is present but untrusted, so the skip and the strict failure must carry
    // the verdict's reason rather than the absent-checkout wording, which would send a reader
    // looking for a file that is sitting right there.
    it('names the sibling refusal reason instead of an absent checkout when one is given', function () {
        const refusal = 'sibling xchain-documentation resolves through a symlink into the live main checkout /x';
        assert.strictEqual(resolveCanonSource(false, false, refusal).reason, refusal);
        assert.throws(() => resolveCanonSource(false, true, refusal),
            (e) => e.message === 'XCHAIN_REQUIRE_SIBLINGS=1 but ' + refusal);
        assert.strictEqual(resolveCanonSource(true, true, refusal).status, 'checked');
    });

    // The coverage floor. Every parity case below is skipped without the sibling, and each
    // one resolves its constant by string, so a renamed module or export would otherwise
    // surface only as a green run. This case runs either way and fails on both.
    it('resolves every gated constant from its local module, whatever the checkout state', function () {
        assert.ok(GATES.length >= 47, 'the gate list has shrunk; a dropped entry is an unpinned flag day');
        for (const [file, exportName] of GATES) {
            const local = require('../../../src/' + file)[exportName];
            assert.ok(local !== undefined,
                file + ' no longer exports ' + exportName + '; the parity case for it would compare ' +
                'undefined to undefined and pass vacuously');
        }
    });
});

describe('activation-gate constant parity to canonical constants.js @regression', function () {
    before(function () { canon = loadCanon(); });

    // The train gate is the one map here whose copies must be BYTE-identical rather than
    // merely value-identical, because the two copies are the same halt decision compiled
    // into two services: the indexer stops applying blocks and the sync follower stops
    // following, and the header text is what tells an operator which. Value parity to the
    // canon is covered by the GATES case below; this is the twin half of it.
    it('holds xchain-sync/src/train_activation.js byte-identical to this repo\'s copy', function () {
        const here = path.resolve(__dirname, '../../../src/train_activation.js');
        const twin = path.resolve(__dirname, '../../../../xchain-sync/src/train_activation.js');
        assert.ok(fs.existsSync(here), 'the indexer train-activation gate is missing at ' + here);
        const twinVerdict = siblingCheckout(__dirname, twin);
        if (!twinVerdict.usable)
            return skipOrFail(this, twinVerdict, 'the sync train-activation twin byte compare');
        assert.strictEqual(fs.readFileSync(twin, 'utf8'), fs.readFileSync(here, 'utf8'),
            'xchain-sync/src/train_activation.js has drifted from the indexer copy; the two are ' +
            'vendored twins and a one-sided edit forks the fleet at the train boundary.');
    });

    // mirror_admission_activation.js is the second module whose copies must be BYTE-identical
    // rather than value-identical, and the reason is sharper than the train gate's: since the
    // price rail joined the family the module carries the admission canonical ENCODER as well
    // as the heights. The hub SIGNS those bytes and this repo REBUILDS them to verify, and no
    // value-parity suite anywhere can compare two copies of a FUNCTION: they would both resolve,
    // both be callable, and disagree only on the bytes a quorum already signed. A byte compare is
    // the only check that sees an encoder edit landed on one side of the boundary.
    it('holds xchain-hub/src/mirror_admission_activation.js byte-identical to this repo\'s copy', function () {
        const here = path.resolve(__dirname, '../../../src/mirror_admission_activation.js');
        const twin = path.resolve(__dirname, '../../../../xchain-hub/src/mirror_admission_activation.js');
        assert.ok(fs.existsSync(here), 'the indexer admission activation module is missing at ' + here);
        const twinVerdict = siblingCheckout(__dirname, twin);
        if (!twinVerdict.usable)
            return skipOrFail(this, twinVerdict, 'the hub mirror-admission twin byte compare');
        assert.strictEqual(fs.readFileSync(twin, 'utf8'), fs.readFileSync(here, 'utf8'),
            'xchain-hub/src/mirror_admission_activation.js has drifted from the indexer copy; the two ' +
            'are byte-identical twins carrying the admission heights AND the canonical encoder, so a ' +
            'one-sided edit makes every signed admission field unverifiable on the other side.');
    });

    // The exported surface of that module, asserted on the LOCAL copy so it runs without the
    // hub sibling: the byte compare above proves the copies match, and this proves the thing
    // they match still carries the encoder the verifier calls. A rename would otherwise leave
    // every canonical rebuild throwing at runtime with both parity cases green.
    it('exports the admission canonical encoder and its era gate, callable and injective', function () {
        const m = require('../../../src/mirror_admission_activation.js');
        for (const name of ['encodeAdmitBlocks', 'decodeAdmitBlocks', 'isAdmissionEra', 'admissionCanonicalField'])
            assert.strictEqual(typeof m[name], 'function', 'mirror_admission_activation must export ' + name);
        assert.strictEqual(m.encodeAdmitBlocks({ DOGE: 23, BTC: 1 }), 'BTC:1,DOGE:23');
        assert.deepStrictEqual(m.decodeAdmitBlocks('BTC:1,DOGE:23'), { BTC: 1, DOGE: 23 });
        assert.strictEqual(m.decodeAdmitBlocks('DOGE:23,BTC:1'), null, 'the decoder admits one spelling only');
        // mainnet is inert in this train, so this is the legacy side of the era gate: no field.
        assert.strictEqual(m.admissionCanonicalField('PARITY', 'mainnet', 1, null), '');
    });
});

describe('activation-gate constant parity to canonical constants.js @regression', function () {
    before(function () { canon = loadCanon(); });

    // The shape of the reserved list itself, asserted on the LOCAL copy so it runs without the
    // documentation sibling. The parity case above proves the two copies match; this proves the
    // thing they match is usable as a case-folded membership test at all. A lower-case or
    // duplicated entry would not throw anywhere, it would just quietly fail to reserve a chain.
    it('holds RESERVED_FUTURE_ROOTS frozen, upper-case and duplicate-free at the surveyed width', function () {
        const roots = require('../../../src/consensus/reserved_roots.js').RESERVED_FUTURE_ROOTS;
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
        const { isReservedFutureRoot } = require('../../../src/consensus/reserved_roots.js');
        assert.strictEqual(isReservedFutureRoot('ETH'), true);
        assert.strictEqual(isReservedFutureRoot('eth'), true);
        assert.strictEqual(isReservedFutureRoot('EtH'), true);
        assert.strictEqual(isReservedFutureRoot('NEAR'), true);
        assert.strictEqual(isReservedFutureRoot('ABCD'), false);
        assert.strictEqual(isReservedFutureRoot('ETHX'), false, 'membership is exact, never a prefix');
        assert.strictEqual(isReservedFutureRoot(null), false, 'a non-string fails closed rather than throwing in a verdict path');
    });
});

describe('activation-gate constant parity to canonical constants.js @regression', function () {
    before(function () { canon = loadCanon(); });

    GATES.forEach(function ([file, exportName]) {
        const title = canonExists
            ? file + ' ' + exportName + ' is value-identical to xchain-documentation/protocol/constants.js'
            : 'SKIPPED: documentation checkout absent at ' + CONSTANTS_PATH + '; ' + file + ' ' +
              exportName + ' parity not verified this run';
        (canonExists ? it : it.skip)(title, function () {
            const local = require('../../../src/' + file)[exportName];
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
