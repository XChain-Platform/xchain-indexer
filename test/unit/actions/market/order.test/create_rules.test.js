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
// ORDER format 0 creation rules past the basics: SOURCE and TICK sleeping, the
// MEMO delimiter, unknown coins, the GET_ADDRESS default, a pre-existing error
// and the strictly-positive GET_AMOUNT (with its cross-chain exemption).
// Part of the ORDER suite; see ../order.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { OWNER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, makeOrderContext } = require('./helpers/order_context.js');

let indexer;
let actionsCtx;
let order;

// Each test starts from its own mock indexer and ORDER handler.
function freshOrder() {
    ({ indexer, actionsCtx, order } = makeOrderContext());
}

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Format 0 – Create Order', function () {
        it('SOURCE sleeping returns invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .withArgs(OWNER_ADDR, null, sinon.match.any)
                .resolves(false);

            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('SOURCE'));
        });

        it('TICK sleeping returns invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .withArgs(null, 'RAREPEPE', sinon.match.any)
                .resolves(false);

            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('TICK'));
        });
    });
});

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Format 0 – Create Order', function () {
        it('MEMO with pipe character returns invalid', async function () {
            // The MEMO field is the last param (index 11). Embed a pipe inside it via
            // a crafted TX_DATA string so setActionParams picks it up. Because pipe is
            // the field delimiter the MEMO value itself cannot contain a pipe; the
            // validation checks data['MEMO'] AFTER setActionParams runs.
            // We replicate the same effect by passing the already-parsed MEMO directly
            // into the data object BEFORE calling parse, which tests the validation path.
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||hello`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });
            // Override MEMO after parse would set it, by injecting it as a pre-parse error scenario
            // Testing via a stub: stub setActionParams to inject a MEMO with pipe
            const origSetActionParams = indexer.util.setActionParams.bind(indexer.util);
            sinon.stub(indexer.util, 'setActionParams').callsFake((d, p, f, v) => {
                const result = origSetActionParams(d, p, f, v);
                result['MEMO'] = 'hello|world';
                return result;
            });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('MEMO'), `Expected MEMO error, got: ${data['STATUS']}`);
        });

        it('GIVE_COIN unsupported coin returns invalid (unknown COINS list)', async function () {
            const params = makeParams(`0|XRP|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].startsWith('invalid'));
        });
    });
});

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Format 0 – Create Order', function () {
        it('defaults GET_ADDRESS to SOURCE when COIN networks match and GET_ADDRESS not provided', async function () {
            // Empty GET_ADDRESS in param string
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10|||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            // If valid it used SOURCE as GET_ADDRESS; invalid would also be acceptable if address validation fails
            // The key check: no crash and createOrder is called on valid
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('pre-existing error short-circuits validation', async function () {
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, 'invalid: pre-existing error');

            // STATUS reflects pre-existing error; createOrder is always called regardless
            assert.ok(data['STATUS'].includes('pre-existing'));
            // updateBalances and processAction are NOT called when invalid
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
            sinon.assert.notCalled(actionsCtx.processAction);
        });

        // Positive-ask hardening: a non-ownership, non-cross-chain order must ask for a
        // strictly-positive GET_AMOUNT (an empty or zero ask escrows GIVE for nothing).
        it('empty GET_AMOUNT returns invalid (must be positive)', async function () {
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GET_AMOUNT') && data['STATUS'].includes('positive'),
                `Expected GET_AMOUNT positive error, got "${data['STATUS']}"`);
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });

        it('zero GET_AMOUNT returns invalid (must be positive)', async function () {
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|0||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GET_AMOUNT') && data['STATUS'].includes('positive'),
                `Expected GET_AMOUNT positive error, got "${data['STATUS']}"`);
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });
    });
});

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('Format 0 – Create Order', function () {
        it('native-coin GET side still requires a positive GET_AMOUNT', async function () {
            // GET_TICK empty (native BTC), GET_AMOUNT empty → invalid
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|||0|${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GET_AMOUNT') && data['STATUS'].includes('positive'),
                `Expected GET_AMOUNT positive error, got "${data['STATUS']}"`);
        });

        it('cross-chain order is exempt from the local positive-GET_AMOUNT check', async function () {
            // GET amount for a cross-chain leg is validated by the xchain-hub federation,
            // so an empty local GET_AMOUNT must not be rejected here.
            const params = makeParams(`0|BTC|RAREPEPE|1||LTC|PEPECASH|||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            // Not rejected for GET_AMOUNT (cross-chain leg escrows locally and settles via federation)
            assert.ok(!data['STATUS'].includes('GET_AMOUNT'),
                `Cross-chain order should not hit the GET_AMOUNT check, got "${data['STATUS']}"`);
        });
    });
});
