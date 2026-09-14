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
// ORDER handler, format 0 creation: a valid order and its escrow and match,
// the EXPIRATION column range, coin and tick checks, balance and expiry. The
// later creation rules, the cancel, edit, field and fee blocks live beside it
// in order.test/; every file opens the same 'Order action handler @regression @tier2' describe, so
// each full test title stays under one suite name.
// order.test/helpers/order_context.js holds the addresses, block time and the
// mock indexer every block starts from.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../fixtures/mocks');
const { OWNER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, makeOrderContext } = require('./order.test/helpers/order_context.js');

let indexer;
let actionsCtx;
let order;

// Each test starts from its own mock indexer and ORDER handler.
function freshOrder() {
    ({ indexer, actionsCtx, order } = makeOrderContext());
}

// ─── Test suite ───────────────────────────────────────────────────────────────

// ─── Format 0: Create Order ───────────────────────────────────────────

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Format 0 – Create Order', function () {
        it('valid order creation calls createOrder and createOrderStatus', async function () {
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createOrder);
            sinon.assert.calledOnce(indexer.indexerDb.createOrderStatus);
        });

        // An EXPIRATION the BIGINT UNSIGNED column cannot represent clears isNumeric and
        // isInteger (+'18446744073709551616' is a whole float) and is not in the past, so
        // without the range clause it would be a VALID order stored with a NULL expiration,
        // i.e. an escrow that never expires.
        it('rejects an EXPIRATION the expiration column cannot represent', async function () {
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|18446744073709551616|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'invalid: EXPIRATION (format)');
        });

        // The boundary value itself still clears the format check. It fails later on the
        // duration-priced fee, which is a separate rule; what matters here is that the range
        // clause is a strict inequality and does not reject the largest storable value.
        it('does not reject the largest EXPIRATION the column can hold on format', async function () {
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|18446744073709551615|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.notStrictEqual(data['STATUS'], 'invalid: EXPIRATION (format)');
        });
    });
});

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Format 0 – Create Order', function () {
        it('valid order triggers processAction ORDER_MATCH', async function () {
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            sinon.assert.calledOnce(actionsCtx.processAction);
            const [actionName] = actionsCtx.processAction.firstCall.args;
            assert.strictEqual(actionName, 'ORDER_MATCH');
        });

        it('valid order creates debit and escrow for GIVE_AMOUNT', async function () {
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            sinon.assert.calledOnce(indexer.indexerDb.updateBalances);
            sinon.assert.calledOnce(indexer.indexerDb.updateTokens);
        });
    });
});

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Format 0 – Create Order', function () {
        it('GIVE_COIN not matching COIN config returns invalid', async function () {
            const params = makeParams(`0|LTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            // createOrder is always called (stores the invalid record); only STATUS matters
            assert.ok(data['STATUS'].startsWith('invalid'), `Expected invalid, got "${data['STATUS']}"`);
            assert.ok(data['STATUS'].includes('GIVE_COIN') || data['STATUS'].includes('GET_COIN') || data['STATUS'].includes('network'));
        });

        it('cross-chain order (GET_COIN != COIN) is invalid when CROSS_CHAIN_DEX is disabled', async function () {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().resolves(false);
            const params = makeParams(`0|BTC|RAREPEPE|1||LTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].startsWith('invalid'));
            assert.ok(data['STATUS'].includes('cross-chain') || data['STATUS'].includes('GET_COIN'));
        });

        it('cross-chain order (GET_COIN != COIN) is accepted when CROSS_CHAIN_DEX is enabled and does NOT match locally', async function () {
            // Cross-chain ORDER: the GIVE side escrows locally; matching + settlement are federation-driven,
            // so the local ORDER_MATCH path is skipped (the counterparty lives on another chain).
            const params = makeParams(`0|BTC|RAREPEPE|1||LTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.notCalled(actionsCtx.processAction);   // no local ORDER_MATCH for cross-chain
        });

        it('GIVE_TICK not found returns invalid', async function () {
            indexer.indexerDb.getTokenInfo
                .withArgs('UNKNOWN', sinon.match.any, sinon.match.any)
                .resolves(null);

            const params = makeParams(`0|BTC|UNKNOWN|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GIVE_TICK'));
        });
    });
});

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Format 0 – Create Order', function () {
        it('GET_TICK not found returns invalid', async function () {
            indexer.indexerDb.getTokenInfo
                .withArgs('NOTOKEN', sinon.match.any, sinon.match.any)
                .resolves(null);

            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|NOTOKEN|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GET_TICK'));
        });

        it('insufficient balance for GIVE_AMOUNT returns invalid', async function () {
            // Balance is 0: insufficient for GIVE_AMOUNT of 1
            indexer.indexerDb.getAddressBalances.resolves({ 10: '0', 20: '999999' });

            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('insufficient funds'));
        });

        it('EXPIRATION before BLOCK_TIME returns invalid', async function () {
            const pastExpiration = BLOCK_TIME - 1000;
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${pastExpiration}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('EXPIRATION'));
        });

        it('EXPIRATION equal to BLOCK_TIME returns invalid', async function () {
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${BLOCK_TIME}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('EXPIRATION'));
        });

        it('unsupported GIVE_COIN returns invalid', async function () {
            const params = makeParams(`0|ETH|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GIVE_COIN'));
        });
    });
});
