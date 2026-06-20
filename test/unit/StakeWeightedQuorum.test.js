/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/StakeWeightedQuorum.test.js
 *
 * Indexer-side mirror of xchain-hub/test/unit/StakeWeightedQuorum.test.js.
 *
 * CONSENSUS-CRITICAL: this predicate decides every cross-chain settlement gate
 * (cross_settle, xexec, xcall, anchor) + the recovery verifier under
 * STAKE_WEIGHTED_QUORUM. The copy is vendored byte-identically across five repos
 * from xchain-documentation/protocol/reference-impl; the byte-identity is enforced
 * by ConsensusPrimitiveConformance.test.js. This suite adds behavioral property
 * coverage (sybil resistance, delegation source-dedup, 500-snapshot cross-repo
 * agreement vs the hub copy) beyond the canonical vectors, with the expected stake
 * total recomputed through the indexer's own bcmath (Utility) as an independent
 * oracle. The final block also asserts the indexer's activation map equals the
 * canonical xchain-documentation/protocol/constants.js value (drift = fork).
 */

'use strict';

const assert  = require('assert');
const swq     = require('../../src/stake_weighted_quorum.js');

// Loads BTC/regtest config into the env so `new Utility()` can resolve its COIN
// config (same fixture the db unit tests use).
require('../fixtures/config').getTestConfig();
const Utility = require('../../src/utility');

// Real indexer bcmath (the production path). The hub uses its own bcmath; using
// the live Utility here is what makes this a meaningful cross-engine mirror
// rather than a re-test of the same arithmetic.
const util = new Utility();

// S1 = 6000 across TWO keys (a, b): one staking source, additive DELEGATE.
// S2 = 3000 (c), S3 = 3000 (d). Total S = 12000.
const V = [
    { pubkey: 'a', source: 'S1', weight: '6000' },
    { pubkey: 'b', source: 'S1', weight: '6000' },
    { pubkey: 'c', source: 'S2', weight: '3000' },
    { pubkey: 'd', source: 'S3', weight: '3000' },
];

describe('stake_weighted_quorum (indexer)', function () {

    describe('meetsStakeThreshold', function () {

        it('returns false for an empty signer set', function () {
            assert.strictEqual(swq.meetsStakeThreshold(V, []), false);
        });

        it('SECURITY: fails CLOSED when any snapshot row has a blank/missing source (no 1-of-N collapse)', function () {
            // A blank '' source (the snapshot schema's NOT NULL DEFAULT '') or undefined source
            // would collapse all rows into one dedupe bucket → a single signature finalizes.
            const blank = [
                { pubkey: 'a', source: '',   weight: '6000' },
                { pubkey: 'b', source: '',   weight: '6000' },
                { pubkey: 'c', source: 'S2', weight: '3000' },
            ];
            assert.strictEqual(swq.meetsStakeThreshold(blank, ['a']), false);
            assert.strictEqual(swq.meetsStakeThreshold(blank, ['a', 'b', 'c']), false);
            assert.strictEqual(swq.meetsStakeThreshold([{ pubkey: 'x', weight: '9000' }], ['x']), false);            // undefined source
            assert.strictEqual(swq.meetsStakeThreshold([{ pubkey: 'y', source: '   ', weight: '9000' }], ['y']), false); // whitespace
        });

        it('a LEGITIMATE single non-blank source still finalizes on its own signature', function () {
            assert.strictEqual(swq.meetsStakeThreshold([{ pubkey: 's', source: 'S1', weight: '9000' }], ['s']), true);
        });

        it('SECURITY: a source\'s multiple keys count its stake ONCE (no delegation inflation)', function () {
            // a + b are both S1 → 6000, not 12000. 3·6000 = 18000 !> 2·12000 = 24000.
            assert.strictEqual(swq.meetsStakeThreshold(V, ['a', 'b']), false);
        });

        it('exactly 2/3 of stake is NOT enough (strictly greater required)', function () {
            // P=5000 of S=7500 = 2/3 exactly → false; P+Q = whole snapshot → true.
            const D = [
                { pubkey: 'p', source: 'P', weight: '5000.00000000' },
                { pubkey: 'q', source: 'Q', weight: '2500.00000000' },
            ];
            assert.strictEqual(swq.meetsStakeThreshold(D, ['p']), false);        // 3·5000 = 15000 !> 2·7500 = 15000
            assert.strictEqual(swq.meetsStakeThreshold(D, ['p', 'q']), true);
        });

        it('strictly more than 2/3 finalizes', function () {
            // S1 + S2 = 9000 of 12000 = 3/4. 3·9000 = 27000 > 24000.
            assert.strictEqual(swq.meetsStakeThreshold(V, ['a', 'c']), true);
        });

        it('counts a source once even when several of its keys sign, plus another source', function () {
            assert.strictEqual(swq.meetsStakeThreshold(V, ['a', 'b', 'c']), true); // 6000 + 3000
        });

        it('ignores duplicate signer pubkeys', function () {
            assert.strictEqual(swq.meetsStakeThreshold(V, ['a', 'a']), false);
        });

        it('ignores signers not present in the snapshot', function () {
            assert.strictEqual(swq.meetsStakeThreshold(V, ['zzz']), false);
        });

        it('a single source IS the whole snapshot: finalizes on its own signature', function () {
            const one = [{ pubkey: 'x', source: 'X', weight: '5000' }];
            assert.strictEqual(swq.meetsStakeThreshold(one, ['x']), true);        // 3·5000 > 2·5000
        });

        it('S = 0 (empty snapshot) is disabled and never finalizes', function () {
            assert.strictEqual(swq.meetsStakeThreshold([], ['x']), false);
        });

        it('is case-insensitive on signer pubkeys', function () {
            assert.strictEqual(swq.meetsStakeThreshold(V, ['A', 'C']), true);
        });
    });

    describe('isStakeWeightedQuorumActive', function () {
        it('regtest + testnet activate at genesis', function () {
            assert.strictEqual(swq.isStakeWeightedQuorumActive(0, 'regtest'), true);
            assert.strictEqual(swq.isStakeWeightedQuorumActive(0, 'testnet'), true);
        });
        it('mainnet is placeholder-disabled until a flag-day height is set', function () {
            assert.strictEqual(swq.isStakeWeightedQuorumActive(0, 'mainnet'), false);
        });
        it('unknown network is off (safe default)', function () {
            assert.strictEqual(swq.isStakeWeightedQuorumActive(5, 'bogus'), false);
        });
        it('non-numeric snapshot block is off', function () {
            assert.strictEqual(swq.isStakeWeightedQuorumActive(undefined, 'regtest'), false);
        });
    });

    // Cross-service activation parity: the indexer's LOCAL activation map must
    // equal the canonical map in xchain-documentation/protocol/constants.js. The
    // hub suite asserts the same against its own copy, so transitively
    // hub == canonical == indexer. A drift here means the hub and indexers would
    // flip stake-weighting on different blocks → guaranteed ledger fork.
    describe('cross-service activation parity', function () {
        it('indexer activation map == canonical constants.js', function () {
            // Monorepo-relative; the canonical doc is always present alongside the
            // services. A missing/unreadable canonical is a hard failure (NOT a
            // skip). A silent skip would be a false green on a fork-class invariant.
            const canonical = require('../../../xchain-documentation/protocol/constants.js')
                .STAKE_WEIGHTED_QUORUM_ACTIVATION;
            assert.deepStrictEqual(swq.STAKE_WEIGHTED_QUORUM_ACTIVATION, canonical);
        });
    });

    // Adversarial, determinism, and delegation invariants. The determinism block
    // runs every fixture through BOTH the indexer predicate (this bcmath) AND the
    // hub predicate (its own independent bcmath) and asserts an identical decision.
    // Fixtures are generated by a SEEDED PRNG so any failure reproduces exactly.
    describe('adversarial Sybil resistance (§3.7)', function () {
        it('40 min-stake Sybil sources cannot reach quorum; a smaller majority-stake honest set can', function () {
            const MIN = '1000';
            const sybils = [];
            for (let i = 0; i < 40; i++)
                sybils.push({ pubkey: 'syb' + i, source: 'SYB' + i, weight: MIN }); // 40 distinct sources × 1000 = 40000
            const honest = [
                { pubkey: 'h1', source: 'H1', weight: '30000' },
                { pubkey: 'h2', source: 'H2', weight: '30000' },
                { pubkey: 'h3', source: 'H3', weight: '30000' },
            ]; // 90000 of S = 130000
            const V = sybils.concat(honest);

            // All 40 Sybils sign: 3·40000 = 120000 !> 2·130000 = 260000 → cannot finalize,
            // even though 40 signatures would trivially win a COUNT-based 2f+1 vote.
            assert.strictEqual(swq.meetsStakeThreshold(V, sybils.map(s => s.pubkey)), false);
            // Three honest sources alone: 3·90000 = 270000 > 260000 → finalize.
            assert.strictEqual(swq.meetsStakeThreshold(V, honest.map(h => h.pubkey)), true);
        });
    });

    describe('cross-engine determinism (§3.7)', function () {
        // Cross-repo agreement: the hub and indexer copies are vendored
        // byte-identically from xchain-documentation/protocol/reference-impl, so this
        // asserts on 500 random snapshots that the two physical copies agree. A drift
        // in either forks the chain (also gated by the byte-identity conformance suite).
        const hubSwq = require('../../../xchain-hub/src/stake_weighted_quorum.js');

        // Deterministic PRNG (mulberry32): fixed seed, reproducible fixtures.
        function rng(seed) {
            return function () {
                seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
                let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        // Build a snapshot of S sources (1–8), each with 1–4 delegated keys sharing
        // the source's weight, plus a random signer subset of the keys.
        function fixture(rand) {
            const nSources = 1 + Math.floor(rand() * 8);
            const validators = [];
            for (let s = 0; s < nSources; s++) {
                const weight = String(1 + Math.floor(rand() * 100000)); // base-unit integer stake
                const nKeys = 1 + Math.floor(rand() * 4);
                for (let k = 0; k < nKeys; k++)
                    validators.push({ pubkey: `s${s}k${k}`, source: `S${s}`, weight });
            }
            const signers = validators.filter(() => rand() < 0.5).map(v => v.pubkey);
            return { validators, signers };
        }

        it('hub and indexer predicates agree on 500 seeded random snapshots', function () {
            const rand = rng(0x5EED1);
            for (let i = 0; i < 500; i++) {
                const { validators, signers } = fixture(rand);
                const idx = swq.meetsStakeThreshold(validators, signers);
                const hub = hubSwq.meetsStakeThreshold(validators, signers);
                assert.strictEqual(idx, hub,
                    `engine disagreement on fixture #${i}: indexer=${idx} hub=${hub} ` +
                    `validators=${JSON.stringify(validators)} signers=${JSON.stringify(signers)}`);
            }
        });
    });

    describe('delegation source-dedup invariant (§3.7, R-2)', function () {
        const hubSwq = require('../../../xchain-hub/src/stake_weighted_quorum.js');

        function rng(seed) {
            return function () {
                seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
                let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        it('S = Σ weight over DISTINCT sources, independent of delegated key count', function () {
            const rand = rng(0xD3F);
            for (let i = 0; i < 200; i++) {
                const nSources = 1 + Math.floor(rand() * 6);
                const validators = [];
                let expectedS = '0';
                for (let s = 0; s < nSources; s++) {
                    const weight = String(1 + Math.floor(rand() * 50000));
                    expectedS = util.bcadd(expectedS, weight);
                    const nKeys = 1 + Math.floor(rand() * 5); // many delegated keys, same weight
                    for (let k = 0; k < nKeys; k++)
                        validators.push({ pubkey: `s${s}k${k}`, source: `S${s}`, weight });
                }
                assert.strictEqual(String(hubSwq.totalStake(validators)), String(expectedS),
                    `totalStake counted delegated keys instead of sources on fixture #${i}`);
            }
        });

        it('adding more keys of an ALREADY-signing source never changes the decision (no (N+1)·A inflation)', function () {
            const rand = rng(0xA11CE);
            for (let i = 0; i < 200; i++) {
                // One "fat" source with several keys + a few other sources.
                const fatWeight = String(1 + Math.floor(rand() * 40000));
                const fatKeys = 2 + Math.floor(rand() * 4);
                const validators = [];
                for (let k = 0; k < fatKeys; k++)
                    validators.push({ pubkey: `fat${k}`, source: 'FAT', weight: fatWeight });
                const nOther = Math.floor(rand() * 4);
                for (let s = 0; s < nOther; s++) {
                    const w = String(1 + Math.floor(rand() * 40000));
                    validators.push({ pubkey: `o${s}`, source: `O${s}`, weight: w });
                }
                // Signing ONE fat key vs ALL fat keys must yield the identical decision,
                // because the source's weight is counted once either way.
                const oneKey = ['fat0'].concat(validators.filter(v => v.source !== 'FAT' && rand() < 0.5).map(v => v.pubkey));
                const allKeys = validators.filter(v => v.source === 'FAT').map(v => v.pubkey)
                    .concat(oneKey.filter(pk => !pk.startsWith('fat')));
                assert.strictEqual(
                    swq.meetsStakeThreshold(validators, oneKey),
                    swq.meetsStakeThreshold(validators, allKeys),
                    `delegation inflation on fixture #${i}: signing extra keys of one source changed the outcome`);
            }
        });
    });
});
