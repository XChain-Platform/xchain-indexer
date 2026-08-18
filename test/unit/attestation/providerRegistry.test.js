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
 * test/unit/attestation/providerRegistry.test.js
 *
 * the indexer provider registry is DEFAULTS (http_get, llm) overlaid
 * with an optional consensus-versioned config block (config.ATTESTATION.PROVIDERS).
 * These tests pin two consensus-critical properties:
 *   1. With NO config the effective set is byte-identical to the built-in DEFAULTS
 *      (the shipping state must be a no-op relative to the old hard-coded map).
 *   2. A config overlay REPLACES a provider definition wholesale and can register a
 *      new provider, without leaking across instances or mutating the DEFAULTS.
 */

'use strict';

const assert = require('assert');

const ProviderRegistry = require('../../../src/attestation/providerRegistry.js');
const DEFAULTS         = ProviderRegistry.PROVIDERS;

describe('ProviderRegistry @regression @tier2', function () {

    describe('DEFAULTS (no config) matches the historical hard-coded map', function () {

        it('knows exactly http_get and llm', function () {
            const r = new ProviderRegistry();
            assert.deepStrictEqual(r.listProviderIds().sort(), ['http_get', 'llm']);
            assert.strictEqual(r.isKnown('http_get'), true);
            assert.strictEqual(r.isKnown('llm'), true);
            assert.strictEqual(r.isKnown('weather'), false);
        });

        it('validates redundancy / payload / deadline against the built-in limits', function () {
            const r = new ProviderRegistry();
            // http_get: allowed_redundancy [1,3,5], max_request_bytes 2048, window 100
            assert.strictEqual(r.isRedundancyAllowed('http_get', 3), true);
            assert.strictEqual(r.isRedundancyAllowed('http_get', 2), false);
            assert.strictEqual(r.isPayloadSizeAllowed('http_get', 2048), true);
            assert.strictEqual(r.isPayloadSizeAllowed('http_get', 2049), false);
            assert.strictEqual(r.isDeadlineAllowed('http_get', 1000, 1100), true);   // delta 100 == window
            assert.strictEqual(r.isDeadlineAllowed('http_get', 1000, 1101), false);  // delta 101 > window
            assert.strictEqual(r.isDeadlineAllowed('http_get', 1000, 1000), false);  // delta 0 not > 0
            // unknown provider is rejected on every check
            assert.strictEqual(r.isRedundancyAllowed('nope', 1), false);
            assert.strictEqual(r.isPayloadSizeAllowed('nope', 1), false);
            assert.strictEqual(r.isDeadlineAllowed('nope', 1, 2), false);
            assert.strictEqual(r.getProvider('nope'), null);
        });

        it('getDeadlineWindows exposes the per-provider windows', function () {
            const r = new ProviderRegistry();
            assert.deepStrictEqual(r.getDeadlineWindows(), { http_get: 100, llm: 20 });
        });

        it('an empty / non-object config resolves to DEFAULTS unchanged', function () {
            for (const cfg of [undefined, null, {}, { ATTESTATION: {} }, { ATTESTATION: { PROVIDERS: null } }, { ATTESTATION: { PROVIDERS: 'x' } }]) {
                const r = new ProviderRegistry(cfg);
                assert.deepStrictEqual(r.listProviderIds().sort(), ['http_get', 'llm'],
                    'config ' + JSON.stringify(cfg) + ' must leave DEFAULTS intact');
            }
        });
    });

    describe('config overlay', function () {

        it('registers a NEW provider from config.ATTESTATION.PROVIDERS', function () {
            const cfg = { ATTESTATION: { PROVIDERS: {
                weather: {
                    provider_id: 'weather', version: 1, consensus_strategy: 'trimmed_median',
                    max_request_bytes: 512, max_response_bytes: 256,
                    allowed_redundancy: [3, 5], deadline_window_blocks: 10
                }
            } } };
            const r = new ProviderRegistry(cfg);
            assert.strictEqual(r.isKnown('weather'), true);
            assert.strictEqual(r.isKnown('http_get'), true, 'defaults survive alongside overlay');
            assert.strictEqual(r.isRedundancyAllowed('weather', 3), true);
            assert.strictEqual(r.isRedundancyAllowed('weather', 1), false);
            assert.strictEqual(r.isPayloadSizeAllowed('weather', 512), true);
            assert.strictEqual(r.isPayloadSizeAllowed('weather', 513), false);
            assert.deepStrictEqual(r.getDeadlineWindows().weather, 10);
        });

        it('REPLACES a default definition wholesale (no stale field merge)', function () {
            const cfg = { ATTESTATION: { PROVIDERS: {
                http_get: {
                    provider_id: 'http_get', version: 2, consensus_strategy: 'byte_equality',
                    max_request_bytes: 4096, max_response_bytes: 65536,
                    allowed_redundancy: [1], deadline_window_blocks: 50
                }
            } } };
            const r = new ProviderRegistry(cfg);
            assert.strictEqual(r.isPayloadSizeAllowed('http_get', 4096), true);   // new max
            assert.strictEqual(r.isPayloadSizeAllowed('http_get', 4097), false);
            assert.strictEqual(r.isRedundancyAllowed('http_get', 3), false);      // 3 was default, gone now
            assert.strictEqual(r.isRedundancyAllowed('http_get', 1), true);
            assert.strictEqual(r.getDeadlineWindows().http_get, 50);              // new window, not the default 100
        });

        it('a non-object overlay entry is ignored (falls back to the DEFAULT for that id)', function () {
            const cfg = { ATTESTATION: { PROVIDERS: { http_get: 'garbage', weather: 42 } } };
            const r = new ProviderRegistry(cfg);
            assert.strictEqual(r.getDeadlineWindows().http_get, 100, 'garbage override ignored, default kept');
            assert.strictEqual(r.isKnown('weather'), false, 'non-object new provider not registered');
        });

        it('does not mutate the module-level DEFAULTS or bleed across instances', function () {
            const before = JSON.parse(JSON.stringify(DEFAULTS));
            const cfg = { ATTESTATION: { PROVIDERS: { http_get: {
                provider_id: 'http_get', version: 9, consensus_strategy: 'byte_equality',
                max_request_bytes: 1, max_response_bytes: 1, allowed_redundancy: [1], deadline_window_blocks: 1
            } } } };
            const overridden = new ProviderRegistry(cfg);
            assert.strictEqual(overridden.getDeadlineWindows().http_get, 1);
            // DEFAULTS untouched
            assert.deepStrictEqual(DEFAULTS, before);
            // a fresh no-config instance still sees the pristine defaults
            const fresh = new ProviderRegistry();
            assert.strictEqual(fresh.getDeadlineWindows().http_get, 100);
        });
    });

    // ---- block-anchored provider stake floor ----------------------------
    // The floor is consensus input at/above STAKE_WEIGHTED_QUORUM: the responsible-set
    // derivation drops sources below it, so a node that resolves a different floor for
    // the same block selects different responsible validators and forks.
    describe('getMinStake (block-anchored provider stake floor)', function () {

        it('ships the spec floors: http_get 10000, llm 25000', function () {
            const r = new ProviderRegistry();
            assert.strictEqual(r.getMinStake('http_get', 100, 'regtest'), '10000');
            assert.strictEqual(r.getMinStake('llm', 100, 'regtest'), '25000');
        });

        it('the llm floor is strictly above the http_get one (it is a per-provider bar, not a copy of the capability one)', function () {
            const r = new ProviderRegistry();
            assert.ok(Number(r.getMinStake('llm', 100, 'regtest')) > Number(r.getMinStake('http_get', 100, 'regtest')));
        });

        it('resolves the same floor at every block, because no activation is armed', function () {
            const r = new ProviderRegistry();
            for (const b of [0, 1, 960999, 961000, 5000000])
                assert.strictEqual(r.getMinStake('http_get', b, 'mainnet'), '10000',
                    'the frozen activation table is empty; a change here is a consensus flag day');
        });

        it('returns null for an unknown provider (caller must fail closed)', function () {
            const r = new ProviderRegistry();
            assert.strictEqual(r.getMinStake('nope', 100, 'regtest'), null);
        });

        it('returns null when an overlay entry carries no floor', function () {
            // An overlay REPLACES the default wholesale, so one that omits
            // min_stake_xchain leaves the provider floorless. That must read as
            // "unknown", never as 0, which would silently widen the serving set.
            const cfg = { ATTESTATION: { PROVIDERS: { http_get: {
                provider_id: 'http_get', version: 1, consensus_strategy: 'byte_equality',
                max_request_bytes: 1, max_response_bytes: 1, allowed_redundancy: [1], deadline_window_blocks: 1
            } } } };
            assert.strictEqual(new ProviderRegistry(cfg).getMinStake('http_get', 100, 'regtest'), null);
        });

        it('an overlay may set its own floor', function () {
            const cfg = { ATTESTATION: { PROVIDERS: { http_get: {
                provider_id: 'http_get', version: 1, consensus_strategy: 'byte_equality',
                max_request_bytes: 1, max_response_bytes: 1, allowed_redundancy: [1],
                min_stake_xchain: '777.5', deadline_window_blocks: 1
            } } } };
            assert.strictEqual(new ProviderRegistry(cfg).getMinStake('http_get', 100, 'regtest'), '777.5');
        });

        it('an armed activation takes effect only at and above its block', function () {
            // Exercised through the operator/test override rather than by editing the
            // frozen table, which is what the module documents as the only safe way in.
            const r = new ProviderRegistry();
            const override = { http_get: [{ activation_block: 500, value: '40000' }] };
            assert.strictEqual(r.getMinStake('http_get', 499, 'regtest', override), '10000');
            assert.strictEqual(r.getMinStake('http_get', 500, 'regtest', override), '40000');
            assert.strictEqual(r.getMinStake('http_get', 900, 'regtest', override), '40000');
        });
    });
});
