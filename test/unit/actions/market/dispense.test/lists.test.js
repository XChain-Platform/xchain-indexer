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
// DISPENSE unit suite: the dispenser, GIVE-token and GET-token allow and block
// lists. One part of dispense.test.js; the shared fixtures are in
// helpers/dispense_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const { makeDispenserInfo, OWNER_ADDR, BUYER_ADDR, BLOCK_TIME, freshDispenseSuite } = require('./helpers/dispense_suite.js');

// The suite's fixtures. Every same-title block below runs freshSuite before
// each test, so each test starts from the same fixtures as the rest of the suite.
let indexer, dispense;
function freshSuite() {
    ({ indexer, dispense } = freshDispenseSuite());
}

// ─── GET-token (token-priced dispenser) ALLOW/BLOCK list enforcement ───
// A token-priced dispenser sets GET_TICK; the GET-token's lists then gate
// the buyer's DESTINATION + the dispenser GET_ADDRESS.
function tokenPricedDispenser(getTokenOverrides) {
    indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GET_TICK: 'PAYTOK', GET_COIN: 'BTC' }));
    indexer.indexerDb.getTokenInfo
        .withArgs('PAYTOK', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'PAYTOK', TICK_ID: 20, ...getTokenOverrides }));
}

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── Allow/block list checks ─────────────────────────────────────────

    it('dispenser ALLOW_LIST excludes SOURCE: dispense invalid', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ ALLOW_LIST: '5' }));
        // The list does NOT include BUYER_ADDR
        indexer.indexerDb.getList.resolves([OWNER_ADDR]);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(dispenseRecord['STATUS'] !== 'valid');
    });

    it('dispenser BLOCK_LIST includes SOURCE: dispense invalid', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ BLOCK_LIST: '6' }));
        // BLOCK_LIST includes BUYER_ADDR
        indexer.indexerDb.getList.resolves([BUYER_ADDR]);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(dispenseRecord['STATUS'] !== 'valid');
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    it('GIVE_TOKEN ALLOW_LIST includes SOURCE: dispense valid', async function () {
        // Give token has an ALLOW_LIST that includes both BUYER and OWNER
        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({
                TICK:       'JDOG',
                TICK_ID:    10,
                ALLOW_LIST: '3',
                BLOCK_LIST: null,
            }));
        // Both addresses in allow list
        indexer.indexerDb.getList.resolves([BUYER_ADDR, OWNER_ADDR]);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(dispenseRecord['STATUS'], 'valid');
    });

    it('GIVE_TOKEN BLOCK_LIST includes SOURCE: dispense invalid', async function () {
        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({
                TICK:       'JDOG',
                TICK_ID:    10,
                ALLOW_LIST: null,
                BLOCK_LIST: '4',
            }));
        // BUYER is on block list
        indexer.indexerDb.getList.resolves([BUYER_ADDR]);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(dispenseRecord['STATUS'] !== 'valid');
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── GIVE-token ALLOW/BLOCK list enforcement ──────────────────────────
    it('rejects a buyer absent from the GIVE-token ALLOW_LIST', async function () {
        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, ALLOW_LIST: 60, BLOCK_LIST: null }));
        indexer.indexerDb.getList.callsFake(async (id) => (id === 60 ? ['1OtherOnlyXXXXXXXXXXXXXXXXXXXX'] : []));

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(String(rec['STATUS']).includes('GIVE_TOKEN allow list'));
    });

    it('rejects a buyer present on the GIVE-token BLOCK_LIST', async function () {
        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, ALLOW_LIST: null, BLOCK_LIST: 61 }));
        indexer.indexerDb.getList.callsFake(async (id) => (id === 61 ? [BUYER_ADDR] : []));

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(String(rec['STATUS']).includes('GIVE_TOKEN block list'));
    });

    it('rejects a buyer absent from the GET-token ALLOW_LIST', async function () {
        tokenPricedDispenser({ ALLOW_LIST: 70, BLOCK_LIST: null });
        indexer.indexerDb.getList.callsFake(async (id) => (id === 70 ? ['1OtherOnlyXXXXXXXXXXXXXXXXXXXX'] : []));

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(String(rec['STATUS']).includes('GET_TOKEN allow list'));
    });

    it('rejects a buyer present on the GET-token BLOCK_LIST', async function () {
        tokenPricedDispenser({ ALLOW_LIST: null, BLOCK_LIST: 71 });
        indexer.indexerDb.getList.callsFake(async (id) => (id === 71 ? [BUYER_ADDR] : []));

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(String(rec['STATUS']).includes('GET_TOKEN block list'));
    });
});
