'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
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

const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH'; // 34 chars - valid P2PKH
const DESTINATION = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs'; // 35 chars - valid P2PKH

// ---------------------------------------------------------------------------
// Utility-level isCryptoAddress() boundary tests
// ---------------------------------------------------------------------------

describe('Utility isCryptoAddress() boundary tests @regression @tier3', function () {
    let util;

    before(function () {
        const indexer = createMockIndexer();
        util = indexer.util;
    });

    // Valid regtest addresses across every supported encoding
    it('isCryptoAddress: valid P2PKH → valid', function () {
        assert.strictEqual(util.isCryptoAddress(SOURCE), true);
    });

    it('isCryptoAddress: valid P2SH → valid', function () {
        assert.strictEqual(util.isCryptoAddress('2NETsvK6gpTRsvxt3z4oJJLVof6BkA9AHmQ'), true);
    });

    it('isCryptoAddress: valid bech32 P2WPKH (20-byte program) → valid', function () {
        assert.strictEqual(util.isCryptoAddress('bcrt1qe6l04hhwjg98fmggptdm0cemj6lm7hhwzahaul'), true);
    });

    it('isCryptoAddress: valid bech32 P2WSH (32-byte program) → valid', function () {
        assert.strictEqual(util.isCryptoAddress('bcrt1qg2zrk70aelwvua5v5e06lca4mqdmnta7gt3pymurghg8wsw8z69q3p3pcw'), true);
    });

    it('isCryptoAddress: valid bech32m P2TR (taproot) → valid', function () {
        assert.strictEqual(util.isCryptoAddress('bcrt1pxqgcx65hqkd9c7y6wulyfv2wlwawqx62n3ufwxkjhjpas2jtqxmsglytaf'), true);
    });

    // Checksum boundaries: a single flipped character must invalidate
    it('isCryptoAddress: base58 checksum flip → invalid', function () {
        assert.strictEqual(util.isCryptoAddress(SOURCE.slice(0, -1) + (SOURCE.endsWith('H') ? 'J' : 'H')), false);
    });

    it('isCryptoAddress: bech32 checksum flip → invalid', function () {
        assert.strictEqual(util.isCryptoAddress('bcrt1qe6l04hhwjg98fmggptdm0cemj6lm7hhwzahauf'), false);
    });

    // Wrong network / wrong coin
    it('isCryptoAddress: mainnet P2PKH on regtest → invalid', function () {
        assert.strictEqual(util.isCryptoAddress('17Roegnpwqam4FwwXsM47bX3Tf1jFyyKMt'), false);
    });

    it('isCryptoAddress: testnet HRP (tb1) on regtest → invalid', function () {
        assert.strictEqual(util.isCryptoAddress('tb1q8fhc7yh0d9mr78hy4z8hlgndtwyemdnuwl6np6'), false);
    });

    // Garbage strings of previously "valid" lengths
    it('isCryptoAddress: 26/30/35/42-char garbage → invalid', function () {
        assert.strictEqual(util.isCryptoAddress('A'.repeat(26)), false);
        assert.strictEqual(util.isCryptoAddress('A'.repeat(30)), false);
        assert.strictEqual(util.isCryptoAddress('A'.repeat(35)), false);
        assert.strictEqual(util.isCryptoAddress('A'.repeat(42)), false);
    });

    it('isCryptoAddress: base58 with out-of-alphabet characters (0, O, I, l) → invalid', function () {
        assert.strictEqual(util.isCryptoAddress('m0OIl3iRkfcWj9onyGFzyDSpfRwga2WtxH'), false);
    });

    it('isCryptoAddress: mixed-case bech32 → invalid', function () {
        assert.strictEqual(util.isCryptoAddress('bcrt1Qe6l04hhwjg98fmggptdm0cemj6lm7hhwzahaul'), false);
    });
});

// ---------------------------------------------------------------------------
// SEND DESTINATION validation (end-to-end through the Send handler)
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

    it('ADR-01: valid P2PKH DESTINATION → valid', async function () {
        // Format 0: VERSION|TICK|AMOUNT|DESTINATION|MEMO
        const params = ['0', 'TEST', '1', DESTINATION, ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('ADR-02: valid P2SH DESTINATION → valid', async function () {
        const params = ['0', 'TEST', '1', '2NETsvK6gpTRsvxt3z4oJJLVof6BkA9AHmQ', ''];
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

    it('ADR-04: address-length garbage DESTINATION (bad checksum) → invalid', async function () {
        const dest   = 'A'.repeat(34);
        const params = ['0', 'TEST', '1', dest, ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('ADR-05: valid bech32 segwit DESTINATION → valid', async function () {
        const params = ['0', 'TEST', '1', 'bcrt1qe6l04hhwjg98fmggptdm0cemj6lm7hhwzahaul', ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('ADR-06a: valid bech32m taproot DESTINATION → valid', async function () {
        const params = ['0', 'TEST', '1', 'bcrt1pxqgcx65hqkd9c7y6wulyfv2wlwawqx62n3ufwxkjhjpas2jtqxmsglytaf', ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('ADR-06b: checksum-flipped DESTINATION → invalid', async function () {
        const dest   = DESTINATION.slice(0, -1) + (DESTINATION.endsWith('s') ? 't' : 's');
        const params = ['0', 'TEST', '1', dest, ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('ADR-07: wrong-network DESTINATION (mainnet P2PKH on regtest) → invalid', async function () {
        const params = ['0', 'TEST', '1', '17Roegnpwqam4FwwXsM47bX3Tf1jFyyKMt', ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });
});
