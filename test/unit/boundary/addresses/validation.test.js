'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const Send = require('../../../../src/actions/send.js');

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

const SOURCE      = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt'; // 34 chars - valid P2PKH
const DESTINATION = '1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9'; // 35 chars - valid P2PKH

// ---------------------------------------------------------------------------
// Utility-level isCryptoAddress() boundary tests
// ---------------------------------------------------------------------------

describe('Utility isCryptoAddress() boundary tests @regression @tier3', function () {
    let util;

    before(function () {
        const indexer = createMockIndexer();
        util = indexer.util;
    });

    // P2PKH lower boundary (26 chars)
    it('isCryptoAddress: 26 chars → valid (P2PKH minimum)', function () {
        assert.strictEqual(util.isCryptoAddress('A'.repeat(26)), true);
    });

    it('isCryptoAddress: 25 chars → invalid (below P2PKH minimum)', function () {
        assert.strictEqual(util.isCryptoAddress('A'.repeat(25)), false);
    });

    // P2PKH upper boundary (35 chars)
    it('isCryptoAddress: 35 chars → valid (P2PKH maximum)', function () {
        assert.strictEqual(util.isCryptoAddress('A'.repeat(35)), true);
    });

    it('isCryptoAddress: 36 chars → invalid (above P2PKH max, below Segwit)', function () {
        assert.strictEqual(util.isCryptoAddress('A'.repeat(36)), false);
    });

    // Mid-range inside P2PKH window
    it('isCryptoAddress: 30 chars → valid (inside P2PKH window)', function () {
        assert.strictEqual(util.isCryptoAddress('A'.repeat(30)), true);
    });

    // Segwit exact boundary (42 chars)
    it('isCryptoAddress: 42 chars → valid (Segwit exact)', function () {
        assert.strictEqual(util.isCryptoAddress('A'.repeat(42)), true);
    });

    // Segwit off-by-one boundaries
    it('isCryptoAddress: 41 chars → invalid (one below Segwit)', function () {
        assert.strictEqual(util.isCryptoAddress('A'.repeat(41)), false);
    });

    it('isCryptoAddress: 43 chars → invalid (one above Segwit)', function () {
        assert.strictEqual(util.isCryptoAddress('A'.repeat(43)), false);
    });
});

// ---------------------------------------------------------------------------
// SEND DESTINATION validation — end-to-end through the Send handler
// ---------------------------------------------------------------------------

describe('Address validation boundary tests via SEND handler @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer     = createMockIndexer();
        actionsCtx  = makeActionsCtx(indexer);
        handler     = new Send(actionsCtx);

        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 }));
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.findDispenserSends.resolves([]);
    });

    afterEach(function () { sinon.restore(); });

    it('ADR-01: DESTINATION at 26 chars (P2PKH minimum) → valid', async function () {
        const dest   = 'A'.repeat(26);
        // Format 0: VERSION|TICK|AMOUNT|DESTINATION|MEMO
        const params = ['0', 'TEST', '1', dest, ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('ADR-02: DESTINATION at 35 chars (P2PKH maximum) → valid', async function () {
        const dest   = 'A'.repeat(35);
        const params = ['0', 'TEST', '1', dest, ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('ADR-03: DESTINATION at 25 chars (too short) → invalid DESTINATION', async function () {
        const dest   = 'A'.repeat(25);
        const params = ['0', 'TEST', '1', dest, ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('ADR-04: DESTINATION at 36 chars (between P2PKH max and Segwit) → invalid', async function () {
        const dest   = 'A'.repeat(36);
        const params = ['0', 'TEST', '1', dest, ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('ADR-05: DESTINATION at exactly 42 chars (Segwit) → valid', async function () {
        const dest   = 'A'.repeat(42);
        const params = ['0', 'TEST', '1', dest, ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('ADR-06a: DESTINATION at 41 chars (one below Segwit) → invalid', async function () {
        const dest   = 'A'.repeat(41);
        const params = ['0', 'TEST', '1', dest, ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('ADR-06b: DESTINATION at 43 chars (one above Segwit) → invalid', async function () {
        const dest   = 'A'.repeat(43);
        const params = ['0', 'TEST', '1', dest, ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });
});
