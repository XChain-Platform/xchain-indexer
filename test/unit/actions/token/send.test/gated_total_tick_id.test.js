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

const { createMockIndexer } = require('../../../../fixtures/mocks');

const Send = require('../../../../../src/actions/send/index.js');
const {
    SOURCE, DESTINATION, DEST2, makeActionsCtx, makeData, makeToken,
} = require('./helpers/send_harness.js');

const NEEDS_HANDOFF = 'invalid: gated token transfer requires key handoff message';
const PUB  = 'mpub1111111111111111111111111111111';
const HASH = 'a'.repeat(64);
const pack = { publisher: PUB, keyHash: HASH, threshold: '100' };

let indexer, handler;

const handoffTo = (destination) => ({
    action: 'MESSAGE', params: ['2', 'BTC', destination, 'ciphertext'],
});

function captureLegs() {
    const legs = [];
    indexer.indexerDb.createSend.callsFake(async (send) => {
        legs.push({ TICK: send.TICK, AMOUNT: String(send.AMOUNT), DESTINATION: send.DESTINATION, STATUS: send.STATUS });
    });
    return legs;
}

async function parseFullSend(params, siblings = []) {
    const legs = captureLegs();
    const data = makeData({ SOURCE, FORMAT: 2, SIBLING_ACTIONS: siblings });
    await handler.parse(params, data, null);
    return legs;
}

describe('Send handler: gated total by resolved tick ID @regression @tier1', function () {
    beforeEach(function () {
        indexer = createMockIndexer();
        handler = new Send(makeActionsCtx(indexer));

        indexer.indexerDb.getTokenInfo.callsFake(async (tick) =>
            tick === 'OTHER'
                ? makeToken({ TICK: 'OTHER', TICK_ID: 2 })
                : makeToken());
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.findMatchingDispensers.resolves([]);
        indexer.indexerDb.findDispenserSends.resolves([]);
        indexer.indexerDb.getAddressBalances.callsFake(async (address) =>
            address === SOURCE ? { 1: 1000, 2: 1000 } : { 1: 0, 2: 0 });
        indexer.indexerDb.getGatedPackThresholds.resolves([pack]);
    });

    afterEach(function () { sinon.restore(); });

    it('requires handoffs when spelling variants together cross the threshold', async function () {
        const legs = await parseFullSend(
            ['2', 'TEST', '60', DESTINATION, 'test', '60', DESTINATION, '']);

        assert.deepStrictEqual(legs, [
            { TICK: 'TEST', AMOUNT: '60', DESTINATION, STATUS: NEEDS_HANDOFF },
            { TICK: 'test', AMOUNT: '60', DESTINATION, STATUS: NEEDS_HANDOFF },
        ]);
    });

    it('accepts every spelling variant when the recipient has a handoff', async function () {
        const legs = await parseFullSend(
            ['2', 'TEST', '60', DESTINATION, 'test', '60', DESTINATION, ''],
            [handoffTo(DESTINATION)]);

        assert.deepStrictEqual(legs.map((leg) => leg.STATUS), ['valid', 'valid']);
    });

    it('does not combine one resolved tick across recipients', async function () {
        const legs = await parseFullSend(
            ['2', 'TEST', '60', DESTINATION, 'test', '60', DEST2, '']);

        assert.deepStrictEqual(legs.map((leg) => leg.STATUS), ['valid', 'valid']);
    });

    it('does not combine different resolved tick IDs for one recipient', async function () {
        const legs = await parseFullSend(
            ['2', 'TEST', '60', DESTINATION, 'OTHER', '60', DESTINATION, '']);

        assert.deepStrictEqual(legs.map((leg) => leg.STATUS), ['valid', 'valid']);
    });
});
