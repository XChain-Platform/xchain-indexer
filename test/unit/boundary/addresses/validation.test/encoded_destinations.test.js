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

// test/unit/boundary/addresses/validation.test/encoded_destinations.test.js
//
// Covers encoded and wrong-network destinations through the SEND handler.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const Send = require('../../../../../src/actions/send/index.js');

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

let indexer, actionsCtx, handler;

// ---------------------------------------------------------------------------
// SEND DESTINATION validation (end-to-end through the Send handler)
// ---------------------------------------------------------------------------

describe('Address validation boundary tests via SEND handler @regression @tier3', function () {
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
