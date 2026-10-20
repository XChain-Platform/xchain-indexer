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
 * test/unit/attestation/provider_overlay_boot_refusal.test.js
 *
 * The effective provider map feeds consensus but CONSENSUS_CONFIG_PIN does not
 * cover config.ATTESTATION.PROVIDERS, so the indexer refuses to boot with an
 * overlay. These tests pin the refusal and its negative control: a config with
 * no overlay still reaches the consensus pin check.
 */

'use strict';

const assert = require('assert');
const ProviderRegistry = require('../../../src/attestation/provider_registry.js');
const config = require('../../../src/config.js');
const coins = require('../../../src/coins');
const runtimeConfig = require('../../../src/XChainIndexer/runtime_config.js');
const { getTestConfig } = require('../../fixtures/config');

const OVERLAY = {
    weather: { provider_id: 'weather', version: 1, allowed_redundancy: [1], deadline_window_blocks: 5 }
};

// Run resolveRuntimeConfig over `cfg`, recording whether it reached the pin check.
function resolveWith(cfg) {
    const realGet = config.getConfig;
    const realPin = coins.verifyConsensusPin;
    let pinReached = false;
    config.getConfig = () => cfg;
    coins.verifyConsensusPin = () => { pinReached = true; };
    let error = null;
    try {
        runtimeConfig.resolveRuntimeConfig.call({});
    } catch (e) {
        error = e;
    } finally {
        config.getConfig = realGet;
        coins.verifyConsensusPin = realPin;
    }
    return { error, pinReached };
}

describe('ATTESTATION.PROVIDERS overlay boot refusal @regression @tier1', function () {
    it('overlayIds names only the object-valued entries the registry would apply', function () {
        for (const cfg of [undefined, null, {}, { ATTESTATION: {} }, { ATTESTATION: { PROVIDERS: null } },
            { ATTESTATION: { PROVIDERS: 'x' } }, { ATTESTATION: { PROVIDERS: { http_get: 'garbage', w: 42 } } }])
            assert.deepStrictEqual(ProviderRegistry.overlayIds(cfg), []);
        const cfg = { ATTESTATION: { PROVIDERS: Object.assign({ junk: 7 }, OVERLAY) } };
        assert.deepStrictEqual(ProviderRegistry.overlayIds(cfg), ['weather']);
        assert.ok(new ProviderRegistry(cfg).isKnown('weather'), 'the id it names is one the registry applies');
    });

    it('refuses a config carrying a provider overlay before the consensus pin check', function () {
        const cfg = getTestConfig();
        cfg['ATTESTATION'] = { PROVIDERS: OVERLAY };
        const { error, pinReached } = resolveWith(cfg);
        assert.ok(error, 'boot must refuse an overlay');
        assert.match(error.message, /ATTESTATION\.PROVIDERS overlays weather/);
        assert.strictEqual(pinReached, false);
    });

    it('boots past the refusal to the consensus pin check when no overlay is present', function () {
        const { error, pinReached } = resolveWith(getTestConfig());
        assert.strictEqual(error, null);
        assert.strictEqual(pinReached, true);
    });
});
