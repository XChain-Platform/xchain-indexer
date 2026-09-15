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
// Valid SEND consolidation and DESTROY leg validation coverage. One part of
// consolidation_leg_amount.test.js; the shared fixtures are in
// helpers/consolidation_leg_amount_suite.js.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');

const Send       = require('../../../../../src/actions/send/index.js');
const Destroy    = require('../../../../../src/actions/destroy/index.js');
const {
    GATE_OFF_NETWORK, SOURCE, DEST, DEST2, makeActionsCtx,
} = require('./helpers/consolidation_leg_amount_suite.js');

let indexer, handler, rows;

async function parse(params, opts = {}) {
    if (opts.network) indexer.config['NETWORK'] = opts.network;
    const data = createBaseData({ ACTION: 'SEND', FORMAT: params[0] | 0, SOURCE });
    await handler.parse(params, data, null);
    return data['STATUS'];
}

function validSendConsolidationCases() {
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

    it('two well-formed legs to one destination still consolidate, gate on', async function () {
        const status = await parse(['1', 'TEST', '50', DEST, '30', DEST, '']);
        assert.strictEqual(status, 'valid');
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(indexer.util.bcformat(rows[0].AMOUNT, 0), '80');
    });

    it('record order follows first-occurrence order, gate on and gate off alike', async function () {
        const params = ['1', 'TEST', '5', DEST, '7', DEST2, '9', DEST, ''];
        await parse(params);
        const on = rows.map(r => r.DESTINATION);
        rows = [];
        await parse(params, { network: GATE_OFF_NETWORK });
        assert.deepStrictEqual(on, rows.map(r => r.DESTINATION));
        assert.deepStrictEqual(on, [DEST, DEST2]);
    });
}

function destroyLegValidationCases() {

    let indexer, handler, rows;

    beforeEach(function () {
        indexer = createMockIndexer();
        handler = new Destroy(makeActionsCtx(indexer));
        rows    = [];

        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 }));
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressBalances.resolves({ 1: 1000 });
        indexer.indexerDb.createDestroy.callsFake(async (d) => {
            rows.push({ AMOUNT: String(d['AMOUNT']), STATUS: d['STATUS'] });
        });
    });

    afterEach(function () { sinon.restore(); });

    async function parse(params, opts = {}) {
        if (opts.network) indexer.config['NETWORK'] = opts.network;
        const data = createBaseData({ ACTION: 'DESTROY', FORMAT: params[0] | 0, SOURCE });
        await handler.parse(params, data, null);
        return data['STATUS'];
    }

    it('two 0.5 legs of one tick are each rejected instead of merging to 1', async function () {
        const status = await parse(['1', 'TEST', '0.5', 'TEST', '0.5', '']);
        assert.strictEqual(status, 'invalid: AMOUNT (format)');
        assert.strictEqual(rows.length, 2);
        assert.deepStrictEqual(rows.map(r => r.STATUS), ['invalid: AMOUNT (format)', 'invalid: AMOUNT (format)']);
    });

    it('control: below the threshold the same two legs still burn a valid 1', async function () {
        const status = await parse(['1', 'TEST', '0.5', 'TEST', '0.5', ''], { network: GATE_OFF_NETWORK });
        assert.strictEqual(status, 'valid');
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(indexer.util.bcformat(rows[0].AMOUNT, 0), '1');
    });

    it('two well-formed legs of one tick still consolidate, gate on', async function () {
        const status = await parse(['1', 'TEST', '20', 'TEST', '30', '']);
        assert.strictEqual(status, 'valid');
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(indexer.util.bcformat(rows[0].AMOUNT, 0), '50');
    });
}

describe('Multi-leg consolidation: per-leg amount format @regression @tier1', function () {
    describe('SEND', validSendConsolidationCases);
    describe('DESTROY', destroyLegValidationCases);
});
