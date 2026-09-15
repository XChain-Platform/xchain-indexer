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
// ORDER format 2 edit: owner and non-owner, missing and non-open orders and the
// ORDER_EDIT action index, plus an unknown format VERSION.
// Part of the ORDER suite; see ../order.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { OWNER_ADDR, OTHER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, makeOrderContext } = require('./helpers/order_context.js');

let indexer;
let actionsCtx;
let order;

// Each test starts from its own mock indexer and ORDER handler.
function freshOrder() {
    ({ indexer, actionsCtx, order } = makeOrderContext());
}

// An open order owned by OWNER_ADDR, as getOrderInfo returns it to an edit.
function makeOrderInfo(overrides = {}) {
    return {
        ACTION_INDEX: 42,
        SOURCE:       OWNER_ADDR,
        GIVE_TICK:    'RAREPEPE',
        GET_TICK:     'PEPECASH',
        ORDER_STATUS: 'open',
        EXPIRATION:   EXPIRATION,
        BLOCK_TIME:   BLOCK_TIME,
        ...overrides,
    };
}

// ─── Format 2: Edit Order ─────────────────────────────────────────────

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Format 2 – Edit Order', function () {
        beforeEach(function () {
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
        });

        it('owner edits open order returns valid and calls createOrderEdit', async function () {
            const newExpiration = EXPIRATION + 86400;
            const params = makeParams(`2|42|${newExpiration}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createOrderEdit);
        });

        it('non-owner edit returns invalid', async function () {
            const params = makeParams(`2|42|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 2, SOURCE: OTHER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('SOURCE'));
        });
    });
});

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Format 2 – Edit Order', function () {
        beforeEach(function () {
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
        });

        it('edit of non-existent order returns invalid', async function () {
            indexer.indexerDb.getOrderInfo.resolves(null);

            const params = makeParams(`2|9999|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('ORDER_ACTION_INDEX'));
        });

        it('edit of non-open order returns invalid', async function () {
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ ORDER_STATUS: 'complete' }));

            const params = makeParams(`2|42|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('ORDER_ACTION_INDEX'));
        });

        it('valid edit updates action index to ORDER_EDIT', async function () {
            const params = makeParams(`2|42|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            sinon.assert.calledWith(indexer.indexerDb.updateActionIndex, sinon.match.any, 'ORDER_EDIT');
        });
    });
});

// ─── Unknown format ────────────────────────────────────────────────────

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Unknown format', function () {
        it('unknown VERSION returns invalid', async function () {
            const params = makeParams('9|BTC|RAREPEPE|1|BTC|PEPECASH|10|||');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 9, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('invalid'));
        });
    });
});
