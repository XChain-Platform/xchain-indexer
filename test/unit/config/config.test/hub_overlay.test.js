// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The hub config overlay's startup apply: the full-coin-name tree key, the consensus
// params it must never apply (EXPIRATION_FEE_PER_DAY, GAS_PRICE, GAS_SCHEDULE, STAKING),
// an unreachable or disabled hub, and the { configs, seq } wrapper.
// Part of the hub config overlay suite; see ../config.test.js.

const assert = require('assert');
const sinon = require('sinon');
const { makeIndexer, restoreOverlay } = require('./helpers/overlay_indexer.js');

let indexer;

// ---------------------------------------------------------------------------
// Hub config overlay (applyHubConfigOverlay)
// ---------------------------------------------------------------------------

describe('XChainIndexer hub config overlay', function () {
    afterEach(restoreOverlay);

    // The hub keys its configs tree by FULL lowercase coin name, never by the ticker
    // config.COIN carries, so the overlay must map the ticker before indexing the tree.
    // Without the mapping the lookup resolves undefined on every poll and the overlay
    // silently delivers nothing, which would also make every exclusion test below pass
    // for the wrong reason (the param absent rather than deliberately withheld). The
    // hub stubs in this block are full-name-keyed for that reason.
    it('resolves the hub configs-tree key as the full coin name, not the ticker', function () {
        const { hubConfigCoinKey } = require('../../../../src/XChainIndexer.js');
        indexer = makeIndexer();
        assert.strictEqual(indexer.config.COIN, 'BTC');
        assert.strictEqual(hubConfigCoinKey('BTC'), 'bitcoin');
        assert.strictEqual(hubConfigCoinKey('LTC'), 'litecoin');
        assert.strictEqual(hubConfigCoinKey('DOGE'), 'dogecoin');
        assert.strictEqual(hubConfigCoinKey('NOPE'), 'NOPE'); // unregistered coin passes through
    });

    it('does NOT apply hub-served EXPIRATION_FEE_PER_DAY (consensus-critical, local-only)', async function () {
        indexer = makeIndexer();
        let localFee = indexer.config.EXPIRATION_FEE_PER_DAY;

        // EXPIRATION_FEE_PER_DAY is debited from balance rows and lands in hashed state, so a
        // live hub swap would let federation nodes charge divergent fees within the poll window
        // (soft fork). It changes only via a coordinated node upgrade.
        let hubStub = { configEnabled: true, getAllConfigs:sinon.stub().resolves({
            bitcoin: { regtest: { 'xchain-indexer': { EXPIRATION_FEE_PER_DAY: '0.00999999' } } }
        })};
        indexer.hubClient = hubStub;

        await indexer.applyHubConfigOverlay();

        assert.strictEqual(indexer.config.EXPIRATION_FEE_PER_DAY, localFee, 'EXPIRATION_FEE_PER_DAY must stay at the local default');
    });
});

describe('XChainIndexer hub config overlay', function () {
    afterEach(restoreOverlay);

    it('does NOT apply hub-served GAS_PRICE or GAS_SCHEDULE (consensus-critical, local-only)', async function () {
        indexer = makeIndexer();
        let localPrice    = indexer.config.GAS_PRICE;
        let localSchedule = indexer.config.GAS_SCHEDULE;

        // The hub serves divergent consensus values; the overlay must ignore both so every
        // federation node keeps processing blocks with the same schedule/price. A live swap
        // would let nodes diverge within the poll window (soft fork). These change only via a
        // coordinated node upgrade.
        let hubStub = { configEnabled: true, getAllConfigs:sinon.stub().resolves({
            bitcoin: { regtest: { 'xchain-indexer': {
                GAS_PRICE:    '0.00099',
                GAS_SCHEDULE: JSON.stringify({ ISSUE: 999999, ISSUE_SUBTOKEN: 999999 })
            } } }
        })};
        indexer.hubClient = hubStub;

        await indexer.applyHubConfigOverlay();

        assert.strictEqual(indexer.config.GAS_PRICE, localPrice, 'GAS_PRICE must stay at the local default');
        assert.strictEqual(indexer.config.GAS_SCHEDULE, localSchedule, 'GAS_SCHEDULE must stay the local object');
    });

    it('falls back gracefully when hub is unreachable', async function () {
        indexer = makeIndexer();
        let localPrice = indexer.config.GAS_PRICE;

        let hubStub = { configEnabled: true, getAllConfigs:sinon.stub().rejects(new Error('ECONNREFUSED')) };
        indexer.hubClient = hubStub;

        // Should not throw
        await indexer.applyHubConfigOverlay();

        // Local default is preserved
        assert.strictEqual(indexer.config.GAS_PRICE, localPrice);
    });
});

describe('XChainIndexer hub config overlay', function () {
    afterEach(restoreOverlay);

    it('does NOT apply a hub-served STAKING blob (consensus-critical, local-only)', async function () {
        indexer = makeIndexer();
        let localStaking = indexer.config.STAKING;
        let pushed = { COOLDOWN_BLOCKS: 2000, ACTIVATION_DELAY_BLOCKS: 12 };

        let hubStub = { configEnabled: true, getAllConfigs:sinon.stub().resolves({
            bitcoin: { regtest: { 'xchain-indexer': { STAKING: JSON.stringify(pushed) } } }
        })};
        indexer.hubClient = hubStub;

        await indexer.applyHubConfigOverlay();

        // STAKING (ACTIVATION_DELAY_BLOCKS / COOLDOWN_BLOCKS / MIN_STAKE) drives activation_block
        // and capability gating in hashed state; the overlay must leave the local object intact.
        assert.strictEqual(indexer.config.STAKING, localStaking, 'STAKING must stay the local object');
    });

    it('skips overlay when hub client is disabled', async function () {
        indexer = makeIndexer();
        let localPrice = indexer.config.GAS_PRICE;

        let hubStub = { configEnabled: false, getAllConfigs:sinon.stub().resolves({}) };
        indexer.hubClient = hubStub;

        await indexer.applyHubConfigOverlay();

        assert.strictEqual(indexer.config.GAS_PRICE, localPrice);
        assert.ok(!hubStub.getAllConfigs.called, 'getAllConfigs should not be invoked when disabled');
    });

    it('unwraps a { configs, seq } response and records the committed seq', async function () {
        indexer = makeIndexer();
        let localFee = indexer.config.EXPIRATION_FEE_PER_DAY;

        // The wrapper's job is to record the committed seq (the health age signal depends on it);
        // any consensus param it happens to carry must NOT be applied.
        let hubStub = { configEnabled: true, getAllConfigs:sinon.stub().resolves({
            configs: { bitcoin: { regtest: { 'xchain-indexer': { EXPIRATION_FEE_PER_DAY: '0.00077000' } } } },
            seq: 5
        })};
        indexer.hubClient = hubStub;

        await indexer.applyHubConfigOverlay();

        assert.strictEqual(indexer.lastHubConfigSeq, 5);
        assert.strictEqual(indexer.config.EXPIRATION_FEE_PER_DAY, localFee, 'consensus param must not be applied from the overlay');
    });
});
