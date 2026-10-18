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
// Multi-leg consolidation per-leg amount validation.
//
// SEND and DESTROY merge same-key legs BEFORE any leg's amount format is checked, so
// two 0.5 legs of a 0-decimals token summed to '1' and settled while either leg alone
// was rejected. A leg whose raw amount fails its tick's format is
// held out of the merge and reaches the per-leg check on its own.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const Send = require('../../../../../src/actions/send/index.js');
const { SOURCE, DEST, makeActionsCtx } = require('./consolidation_leg_amount.test/helpers/consolidation_leg_amount_suite.js');

let indexer, handler, rows;

async function parse(params) {
    const data = createBaseData({ ACTION: 'SEND', FORMAT: params[0] | 0, SOURCE });
    await handler.parse(params, data, null);
    return data['STATUS'];
}

function rejectedSendLegCases() {
    beforeEach(function () {
        indexer = createMockIndexer();
        handler = new Send(makeActionsCtx(indexer));
        rows    = [];

        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 }));
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getAddressBalances.resolves({ 1: 1000 });
        indexer.indexerDb.findMatchingDispensers.resolves([]);
        indexer.indexerDb.findDispenserSends.resolves([]);
        // `send` aliases `data`, so every call records the SAME object: snapshot each row at
        // call time or the assertions below would only ever see the last leg's state.
        indexer.indexerDb.createSend.callsFake(async (s) => {
            rows.push({ AMOUNT: String(s['AMOUNT']), STATUS: s['STATUS'], DESTINATION: s['DESTINATION'] });
        });
    });

    afterEach(function () { sinon.restore(); });

    it('a single 0.5 leg of a 0-decimals token is rejected (the rule that was being laundered)', async function () {
        assert.strictEqual(await parse(['0', 'TEST', '0.5', DEST, '']), 'invalid: AMOUNT (format)');
    });

    it('two 0.5 legs to one destination are each rejected instead of settling as 1', async function () {
        const status = await parse(['1', 'TEST', '0.5', DEST, '0.5', DEST, '']);
        assert.strictEqual(status, 'invalid: AMOUNT (format)');
        assert.strictEqual(rows.length, 2);
        assert.deepStrictEqual(rows.map(r => r.STATUS), ['invalid: AMOUNT (format)', 'invalid: AMOUNT (format)']);
    });

    it('an honest sibling leg still settles beside a rejected one', async function () {
        const status = await parse(['1', 'TEST', '0.5', DEST, '10', DEST, '']);
        assert.strictEqual(rows.length, 2);
        assert.deepStrictEqual(rows.map(r => r.STATUS).sort(),
            ['invalid: AMOUNT (format)', 'valid']);
        assert.strictEqual(status, 'valid');   // last leg parsed is the valid one
    });

}

describe('Multi-leg consolidation: per-leg amount format @regression @tier1', function () {
    describe('SEND', rejectedSendLegCases);
});
