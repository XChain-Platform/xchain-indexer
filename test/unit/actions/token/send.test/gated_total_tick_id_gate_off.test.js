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
//
// Send handler: gate-off behavior for gated totals by resolved tick ID.
// Part of the Send suite; see ../send.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../../../../fixtures/mocks');

const gateRegistry = require('../../../../../src/consensus/gate_registry');
const Send = require('../../../../../src/actions/send/index.js');
const {
    SOURCE, DESTINATION, makeActionsCtx, makeData, makeToken, makeBalances,
} = require('./helpers/send_harness.js');

const NEEDS_HANDOFF = 'invalid: gated token transfer requires key handoff message';

let indexer, actionsCtx, handler;

function captureLegs() {
    const legs = [];
    indexer.indexerDb.createSend.callsFake(async (send) => {
        legs.push({ TICK: send.TICK, AMOUNT: String(send.AMOUNT), STATUS: send.STATUS });
    });
    return legs;
}

async function parseFullSend(params) {
    const legs = captureLegs();
    const data = makeData({ SOURCE, FORMAT: 2 });
    await handler.parse(params, data, null);
    return legs;
}

describe('Send handler: resolved tick totals gate off @regression @tier1', function () {
    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Send(actionsCtx);

        indexer.indexerDb.getTokenInfo.resolves(makeToken());
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.findMatchingDispensers.resolves([]);
        indexer.indexerDb.findDispenserSends.resolves([]);
        indexer.indexerDb.getAddressBalances.callsFake(async (address) =>
            makeBalances(1, address === SOURCE ? 1000 : 0));
        indexer.indexerDb.getGatedPackThresholds.resolves([{ threshold: '100' }]);

        const activeAt = gateRegistry.activeAt;
        sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
            key.includes('SEND_GATED_TOTAL_TICK_ID') ? false : activeAt.call(gateRegistry, key, ...args));
        actionsCtx.protocolChanges.isEnabled.callsFake(async (name) =>
            name === 'SEND_GATED_TOTAL_TICK_ID' ? false : true);
    });

    afterEach(function () { sinon.restore(); });

    it('keeps differently cased legs below the threshold', async function () {
        const legs = await parseFullSend(
            ['2', 'TEST', '60', DESTINATION, 'test', '60', DESTINATION, '']);
        assert.deepStrictEqual(legs, [
            { TICK: 'TEST', AMOUNT: '60', STATUS: 'valid' },
            { TICK: 'test', AMOUNT: '60', STATUS: 'valid' },
        ]);
    });

    it('requires a handoff after identical spellings consolidate', async function () {
        const legs = await parseFullSend(
            ['2', 'TEST', '60', DESTINATION, 'TEST', '60', DESTINATION, '']);
        assert.deepStrictEqual(legs, [
            { TICK: 'TEST', AMOUNT: '120', STATUS: NEEDS_HANDOFF },
        ]);
    });

    it('resolves a lowercase spelling to the gated tick', async function () {
        const legs = await parseFullSend(['2', 'test', '120', DESTINATION, '']);
        assert.deepStrictEqual(legs, [
            { TICK: 'test', AMOUNT: '120', STATUS: NEEDS_HANDOFF },
        ]);
    });
});
