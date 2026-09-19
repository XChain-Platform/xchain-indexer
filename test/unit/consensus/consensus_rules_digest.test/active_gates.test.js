/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

// test/unit/consensus/consensus_rules_digest.test/active_gates.test.js
//
// Pins the ordered shared gate registry and the height-based activation helpers.

'use strict';

const { assert, crd, stubRegistryRow } = require('./helpers/consensus_rules_digest.js');

// The zero-confirmation flip's three appended SHARED_GATES rows, plus the two
// helpers a ROLLCALL v1 publisher and the rules-aware capability set filter both read.
// The hub copy carries the load-bearing knownGateKeys()/activeGatesAt() cases; this is
// the indexer's own instance of the same guard, so a one-sided edit here cannot pass by
// running only on the other repo.
describe('consensus_rules_digest: knownGateKeys() and activeGatesAt() (D88)', function () {
    it('is sorted, has 33 entries, and contains the gates the last three trains append', function () {
        const keys = crd.knownGateKeys();
        assert.strictEqual(keys.length, 33, 'SHARED_GATES total entry count moved; re-derive this floor before changing it');
        assert.deepStrictEqual(keys, [...keys].sort());
        for (const k of [
            'attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION',
            'attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING_V2',
            'rollcall_gates_activation.ROLLCALL_GATES_ACTIVATION',
            // The time-keyed mirror barrier family and its anchor-attest member: the hub
            // evaluates all of these, so they belong in the cross-repo comparison.
            'mirror_admission_activation.MIRROR_ADMISSION_ACTIVATION',
            'mirror_admission_activation.MIRROR_ADMISSION_CONSUMER_ACTIVATION',
            'mirror_admission_activation.ADMIT_MARGIN_BLOCKS',
            'mirror_admission_activation.ADMIT_MIN_FUTURE_BLOCKS',
            'mirror_admission_activation.ADMIT_MAX_FUTURE_BLOCKS',
            'anchor_reward_activation.ANCHOR_ATTEST_BARRIER_ACTIVATION',
            'anchor_reward_activation.ANCHOR_ATTEST_ARRIVAL_MARGIN_S',
            // The admission canonical encoder and its era gate. The price rail made the
            // encoder a cross-repo byte-twin, so an upgraded build signing the admission
            // field must read as a rules mismatch against peers that cannot rebuild it.
            'mirror_admission_activation.CHAIN_CODE_RE',
            'mirror_admission_activation.CANONICAL_HEIGHT_RE',
            'mirror_admission_activation.encodeAdmitBlocks',
            'mirror_admission_activation.decodeAdmitBlocks',
            'mirror_admission_activation.isAdmissionEra',
            'mirror_admission_activation.admissionCanonicalField'
        ]) assert.ok(keys.includes(k), 'missing ' + k);
    });
});

describe('consensus_rules_digest: knownGateKeys() and activeGatesAt() (D88)', function () {
    // The deploy-wave alarm, pinned to a value rather than only to itself. Cross-repo
    // equality alone cannot see a move both repos make together, which is exactly what a
    // one-train edit to a shared gate looks like, and the digest an un-upgraded peer
    // advertises is a literal on the wire. Re-derive with
    // `node -e "console.log(require('./src/consensus_rules_digest.js').computeConsensusRulesDigest().digest)"`
    // whenever a gate is deliberately added, and change it in the hub suite in the SAME
    // edit: the two values are one number.
    //
    // Computed with the regtest admission arming CLEARED, because that one gate resolves from
    // the environment: a venue process launched armed has a different, equally correct digest,
    // and a pin that moved with a drill lever would be a test of the launcher. The pinned value
    // is the fleet's: every shipped process reads the unarmed maps.
    it('digests to the pinned value, which moved when the v0.19.0 cut armed the bridge on testnet (and again at the 16:33Z ladder re-cut, and again when LTC:testnet mirror admission shipped null under dq4 (a))', function () {
        // Every gate module still on disk, not just the admission one: the family's arming
        // lever is shared, so the anchor-attest gate resolves from the same variable and a
        // cached copy of it would keep a drill's heights in the digest after the variable
        // was cleared. A SHARED_GATES stem whose shim W5 deleted has no module to purge
        // (its row is read from the registry), so the helper answers null for it.
        const { modulePathFor } = require('../../../helpers/gate_modules.js');
        const paths = [require.resolve('../../../../src/consensus_rules_digest.js')].concat(
            [...new Set(crd.SHARED_GATES.map(g => g[0]))].map(m => modulePathFor(m)).filter(p => p !== null)
                .map(p => require.resolve(p)));
        const saved = paths.map(p => [p, require.cache[p]]);
        const env   = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        try {
            delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
            for (const [p] of saved) delete require.cache[p];
            const fresh = require('../../../../src/consensus_rules_digest.js');
            assert.strictEqual(fresh.computeConsensusRulesDigest().digest,
                'b57eb9a867a8d3c914dc100b445fccb217c54efc8a7dd671a0ad176c83cebd4c',
                'the consensus rules digest moved; a gate was added, removed, reordered or re-armed');
        } finally {
            for (const [p, mod] of saved) { if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod; }
            if (env === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
            else process.env.XC_MIRROR_ADMISSION_ACTIVATION = env;
        }
    });
});

describe('consensus_rules_digest: knownGateKeys() and activeGatesAt() (D88)', function () {
    // The append is at the END, and this is what "at the end" has to mean operationally: the
    // preimage of every gate that was already registered is byte-for-byte where it was, so an
    // old build and a new build disagree ONLY about the rows the new build added. An insertion
    // mid-list would leave every later gate in a different preimage position and the digest
    // would move for reasons no operator could attribute to a gate.
    it('appends the family at the END, leaving the pre-existing gate order untouched', function () {
        const PRE_EXISTING = [
            'anchor_reward_activation', 'attest_relay_activation', 'checkpoint_commitment_activation',
            'cross_chain_royalty_activation', 'equivocation_header', 'price_pair_activation',
            'price_sig_tally_activation', 'retraction_signing_activation', 'rollcall_activation',
            'snapshot_reorg_buffer', 'stake_weighted_quorum', 'attest_responsible_widening_activation',
            'attest_response_mirror_activation', 'attest_zero_conf_activation',
            'attest_responsible_widening_activation', 'rollcall_gates_activation',
            // Landed by the bridge train while this one was in flight. Two trains appended to
            // one order-significant registry; this one lands SECOND, so the bridge gate is
            // pre-existing from here and the family sits after it, not before.
            'xchain_bridge_activation'
        ];
        const mods = crd.SHARED_GATES.map(g => g[0]);
        assert.deepStrictEqual(mods.slice(0, PRE_EXISTING.length), PRE_EXISTING,
            'a SHARED_GATES entry was inserted mid-list; that reorders the preimage of every gate after it');
        assert.deepStrictEqual(mods.slice(PRE_EXISTING.length),
            ['mirror_admission_activation', 'anchor_reward_activation', 'mirror_admission_activation'],
            'the family must be the LAST three entries, the encoder registration last of all');
    });

    // The 2026-09-09 genesis-arm ruling left no SHIPPED gate on the far-future sentinel,
    // so the exclusion branch is driven against a stubbed registry row instead of riding
    // whichever map happened to be unarmed. PRICE_PAIR_WIDEN_ACTIVATION, the last live
    // example before the arm, is the row stubbed here.
    it('excludes a far-future sentinel height, however high the chain climbs', function () {
        const CRD     = require.resolve('../../../../src/consensus_rules_digest.js');
        const realCrd = require.cache[CRD];
        const restore = stubRegistryRow('price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION',
            { mainnet: crd.FAR_FUTURE_HEIGHT_SENTINEL, testnet: 0, regtest: 0 });
        try {
            delete require.cache[CRD];                       // clears the module-level value cache
            const fresh = require('../../../../src/consensus_rules_digest.js');
            const at = fresh.activeGatesAt(fresh.FAR_FUTURE_HEIGHT_SENTINEL, 'mainnet');
            assert.ok(!at.includes('price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION'),
                'a sentinel height must read as inactive even at the sentinel itself');
            assert.ok(fresh.activeGatesAt(0, 'testnet').includes('price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION'),
                'the same stub is active on testnet, so the exclusion is the sentinel and not the stub');
        } finally {
            restore();
            require.cache[CRD]  = realCrd;
        }
    });
});

describe('consensus_rules_digest: knownGateKeys() and activeGatesAt() (D88)', function () {
    it('includes the gates this wave armed at genesis on mainnet, from block 0', function () {
        // The 2026-09-09 ruling: identity on the indexed mainnet history.
        for (const k of [
            'price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION',
            'snapshot_reorg_buffer.SNAPSHOT_BURIAL_ACTIVATION',
        ]) assert.ok(crd.activeGatesAt(0, 'mainnet').includes(k), k + ' must be active at mainnet block 0');
    });

    it('excludes a null (unratified) entry at any height', function () {
        for (const h of [0, 1000000, crd.FAR_FUTURE_HEIGHT_SENTINEL - 1]) {
            assert.ok(!crd.activeGatesAt(h, 'mainnet').includes('attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION'));
        }
    });

    it('excludes non-map exports (frozen ladder constants), never active in this sense', function () {
        for (const h of [0, 150780, 999999999]) {
            for (const net of ['mainnet', 'testnet', 'regtest']) {
                const at = crd.activeGatesAt(h, net);
                assert.ok(!at.includes('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING'));
                assert.ok(!at.includes('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING_V2'));
            }
        }
    });

    it('includes a gate exactly at its own activation height (<=, not <)', function () {
        assert.ok(crd.activeGatesAt(0, 'regtest').includes('attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION'));
    });

    it('returns [] for a non-finite height', function () {
        assert.deepStrictEqual(crd.activeGatesAt(NaN, 'regtest'), []);
        assert.deepStrictEqual(crd.activeGatesAt(undefined, 'regtest'), []);
        assert.deepStrictEqual(crd.activeGatesAt(Infinity, 'regtest'), []);
    });
});
