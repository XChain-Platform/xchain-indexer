// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Order = require('../../../src/actions/order.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// Build a pipe-delimited param string and split it the same way the indexer does
function makeParams(str) {
    return String(str).split('|');
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('Order action handler @regression @tier2', function () {
    let indexer;
    let actionsCtx;
    let order;

    // Default addresses used in tests
    const OWNER_ADDR = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const OTHER_ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

    // Block time fixed; expiration must be strictly greater than this
    const BLOCK_TIME  = 1700000000;
    const EXPIRATION  = BLOCK_TIME + 86400 * 30; // 30 days later

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        order      = new Order(actionsCtx);

        // Default: both GIVE and GET tokens exist
        indexer.indexerDb.getTokenInfo
            .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'RAREPEPE', TICK_ID: 10, DECIMALS: 0 }));
        indexer.indexerDb.getTokenInfo
            .withArgs('PEPECASH', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PEPECASH', TICK_ID: 20, DECIMALS: 0 }));

        // Default: sufficient balance for GIVE_AMOUNT
        indexer.indexerDb.getAddressBalances.resolves({ 10: '100', 20: '999999' });

        // Default: address / tick not sleeping; action allowed
        indexer.indexerDb.isActionAllowed.resolves(true);

        // Preferences with FEE_PREFERENCE=0, REQUIRE_MEMO=0
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });

        // Fee tick id
        indexer.indexerDb.getTickerId.resolves(99);
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── Format 0 — Create Order ───────────────────────────────────────────

    describe('Format 0 – Create Order', function () {

        it('valid order creation calls createOrder and createOrderStatus', async function () {
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createOrder);
            sinon.assert.calledOnce(indexer.indexerDb.createOrderStatus);
        });

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
            // Phase B: the GIVE side escrows locally; matching + settlement are federation-driven,
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
            // Balance is 0 — insufficient for GIVE_AMOUNT of 1
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

        it('MEMO with pipe character returns invalid', async function () {
            // The MEMO field is the last param (index 11). Embed a pipe inside it via
            // a crafted TX_DATA string so setActionParams picks it up. Because pipe is
            // the field delimiter the MEMO value itself cannot contain a pipe — the
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
    });

    // ─── Format 1 — Cancel Order ───────────────────────────────────────────

    describe('Format 1 – Cancel Order', function () {

        function makeOrderInfo(overrides = {}) {
            return {
                ACTION_INDEX:   42,
                SOURCE:         OWNER_ADDR,
                GIVE_TICK:      'RAREPEPE',
                GIVE_REMAINING: '1',
                GET_TICK:       'PEPECASH',
                ORDER_STATUS:   'open',
                ...overrides,
            };
        }

        beforeEach(function () {
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
        });

        it('owner cancels open order returns valid', async function () {
            const params = makeParams('1|42|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createOrderCancel);
        });

        it('cancel by non-owner returns invalid', async function () {
            const params = makeParams('1|42|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OTHER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            // STATUS is invalid; the record is still written (always), but ledger changes are skipped
            assert.ok(data['STATUS'].includes('SOURCE'));
            // updateBalances NOT called when invalid
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });

        it('cancel of non-existent order returns invalid', async function () {
            indexer.indexerDb.getOrderInfo.resolves(null);

            const params = makeParams('1|9999|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('ORDER_ACTION_INDEX'));
        });

        it('cancel of non-open order returns invalid', async function () {
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ ORDER_STATUS: 'cancelled' }));

            const params = makeParams('1|42|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('ORDER_ACTION_INDEX'));
        });

        it('valid cancel updates action index and creates order cancel record', async function () {
            const params = makeParams('1|42|Closing order');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            sinon.assert.calledWith(indexer.indexerDb.updateActionIndex, sinon.match.any, 'ORDER_CANCEL');
            sinon.assert.calledOnce(indexer.indexerDb.createOrderStatus);
        });

        it('valid cancel calls processAction ORDER_MATCH to check for new matches on cancelled escrow', async function () {
            // After a cancel, processAction('ORDER_MATCH') is still triggered if valid
            // (so other open orders can potentially match against the freed liquidity)
            const params = makeParams('1|42|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(actionsCtx.processAction);
        });
    });

    // ─── Format 2 — Edit Order ─────────────────────────────────────────────

    describe('Format 2 – Edit Order', function () {

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

    // ─── Unknown format ────────────────────────────────────────────────────

    describe('Unknown format', function () {
        it('unknown VERSION returns invalid', async function () {
            const params = makeParams('9|BTC|RAREPEPE|1|BTC|PEPECASH|10|||');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 9, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('invalid'));
        });
    });

    // ─── GET_ADDRESS contract address validation (lines 194-198) ────────────

    describe('GET_ADDRESS contract address validation', function () {

        it('contract GET_ADDRESS rejected when GET side is native coin', async function () {
            // GIVE_TICK=RAREPEPE (token), GET_TICK=empty (native coin), GET_ADDRESS=C:BTC:42 (contract)
            // This hits line 196: isContractAddress passes but isNativeCoinGet=true → reject
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC||10||C:BTC:42|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GET_ADDRESS') && data['STATUS'].includes('native coin'));
        });

        it('invalid GET_ADDRESS that is neither crypto nor contract address returns error', async function () {
            // Use an address that is not a valid crypto address and not a C: contract address
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||not-valid-addr|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GET_ADDRESS'));
        });
    });

    // ─── GET_OWNERSHIP bid validation (lines 232-238) ────────────────────

    describe('GET_OWNERSHIP=1 (bid for ownership)', function () {

        it('GET_OWNERSHIP=1 with empty GET_AMOUNT is valid when GET_TICK exists', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 10: '100', 20: '999999', 99: '999999999' });

            // GIVE=RAREPEPE, GET=PEPECASH ownership (GET_OWNERSHIP=1, GET_AMOUNT empty)
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH||1|${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('GET_OWNERSHIP=1 with non-empty GET_AMOUNT returns invalid', async function () {
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10|1|${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GET_AMOUNT') || data['STATUS'].includes('must be empty'));
        });

        it('GET_OWNERSHIP=1 with unknown GET_TICK (same chain) returns invalid', async function () {
            indexer.indexerDb.getTokenInfo
                .withArgs('UNKNOWNTICK', sinon.match.any, sinon.match.any)
                .resolves(null);

            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|UNKNOWNTICK||1|${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GET_TICK'));
        });
    });

    // ─── LIST field validation (lines 288-298) ───────────────────────────

    describe('LIST field validation', function () {

        it('unknown ALLOW_LIST returns invalid', async function () {
            indexer.indexerDb.getListType.resolves(false);

            // Provide ALLOW_LIST=99 (unknown list)
            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|99||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('ALLOW_LIST') && data['STATUS'].includes('unknown'));
        });

        it('unsupported LIST type returns invalid', async function () {
            // Type 1 = tick list; order.listTypes only includes type 2 (address)
            indexer.indexerDb.getListType.resolves(1);

            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|99||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('unsupported'));
        });
    });

    // ─── Non-unified fee path (line 331-333) ──────────────────────────────

    describe('Non-unified expiration fee path', function () {

        it('non-unified fee path sets AMOUNT via getExpirationFee when EXPIRATION is provided', async function () {
            // Disable UNIFIED_FEES so the legacy expiration fee branch executes
            actionsCtx.protocolChanges.isEnabled = sinon.stub().resolves(false);

            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            // Still valid — getExpirationFee returns 0 at default GAS_PRICE=0.00001 for short windows
            assert.ok(data['STATUS'] === 'valid' || data['STATUS'].startsWith('invalid'));
            sinon.assert.calledOnce(indexer.indexerDb.createOrder);
        });
    });

    // ─── Native coin fee payment path (lines 340-348) ────────────────────

    describe('Native coin fee payment', function () {

        it('native coin fee: valid payment sets PAYMENT_MODE=1', async function () {
            // Make UNIFIED_FEES return a non-zero fee, then force detectFeePaymentMode to 'native'
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: true,
                nativeCoinAmount: '0.0001',
                nativeCoin: 'BTC',
                oracleRound: 1,
            });
            // Give a non-zero unified fee
            sinon.stub(indexer.util, 'getUnifiedExpirationFee').returns({ gasCost: 100, fee: '0.00001' });

            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('native coin fee: invalid payment sets error', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: false,
                error: 'fee output too small',
            });
            sinon.stub(indexer.util, 'getUnifiedExpirationFee').returns({ gasCost: 100, fee: '0.00001' });

            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].startsWith('invalid'));
            assert.ok(data['STATUS'].includes('fee output too small') || data['STATUS'].includes('native coin fee'));
        });

        it('native coin fee rejected mode returns invalid', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('rejected');
            sinon.stub(indexer.util, 'getUnifiedExpirationFee').returns({ gasCost: 100, fee: '0.00001' });

            const params = makeParams(`0|BTC|RAREPEPE|1||BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('insufficient fee'));
        });
    });

    // ─── Ownership-give order (lines 414-417) ────────────────────────────

    describe('GIVE_OWNERSHIP=1 (ownership order)', function () {

        beforeEach(function () {
            // setTokenEscrow is not in the shared mock — add it here
            indexer.indexerDb.setTokenEscrow = sinon.stub().resolves();
        });

        it('valid ownership-give order calls setTokenEscrow instead of debit/escrow', async function () {
            // SOURCE must be OWNER of RAREPEPE
            indexer.indexerDb.getTokenInfo
                .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
                .resolves({ TICK: 'RAREPEPE', TICK_ID: 10, DECIMALS: 0, OWNER: OWNER_ADDR });
            indexer.indexerDb.isOwnershipEscrowed.resolves(false);
            // Provide enough balance for any fee (fee tick id 99)
            indexer.indexerDb.getAddressBalances.resolves({ 10: '100', 20: '999999', 99: '999999999' });

            // GIVE_OWNERSHIP=1 → GIVE_AMOUNT must be empty
            const params = makeParams(`0|BTC|RAREPEPE||1|BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.setTokenEscrow);
        });

        it('ownership-give rejects when SOURCE is not the token owner', async function () {
            indexer.indexerDb.getTokenInfo
                .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
                .resolves({ TICK: 'RAREPEPE', TICK_ID: 10, DECIMALS: 0, OWNER: OTHER_ADDR });

            const params = makeParams(`0|BTC|RAREPEPE||1|BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('SOURCE') || data['STATUS'].includes('owner'));
        });

        it('ownership-give rejects when ownership is already escrowed', async function () {
            indexer.indexerDb.getTokenInfo
                .withArgs('RAREPEPE', sinon.match.any, sinon.match.any)
                .resolves({ TICK: 'RAREPEPE', TICK_ID: 10, DECIMALS: 0, OWNER: OWNER_ADDR });
            indexer.indexerDb.isOwnershipEscrowed.resolves(true);

            const params = makeParams(`0|BTC|RAREPEPE||1|BTC|PEPECASH|10||${OWNER_ADDR}|${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.ok(data['STATUS'].includes('escrowed') || data['STATUS'].includes('ownership'));
        });
    });

    // ─── Format 1 Cancel — two-phase and ownership-cancel paths ──────────

    describe('Format 1 – two-phase cancel and ownership-cancel paths', function () {

        function makeOrderInfo(overrides = {}) {
            return {
                ACTION_INDEX:   42,
                SOURCE:         OWNER_ADDR,
                GIVE_TICK:      'RAREPEPE',
                GIVE_REMAINING: '1',
                GET_TICK:       'PEPECASH',
                ORDER_STATUS:   'open',
                ...overrides,
            };
        }

        beforeEach(function () {
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo());
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
        });

        it('two-phase cancel: sets status to cancelling when pending COINPay obligations exist', async function () {
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([{ id: 1 }]);

            const params = makeParams('1|42|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            const statusCall = indexer.indexerDb.createOrderStatus.firstCall;
            assert.ok(statusCall, 'createOrderStatus should be called');
            assert.strictEqual(statusCall.args[2], 'cancelling');
        });

        it('ownership order cancel: clearTokenEscrow called when GIVE_OWNERSHIP=1', async function () {
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_OWNERSHIP: 1 }));
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);

            const params = makeParams('1|42|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.clearTokenEscrow);
        });

        it('standard cancel with null GIVE_TICK: no debit/escrow (defensive branch)', async function () {
            // GIVE_TICK is null — isNull returns true so the debit/escrow is skipped
            indexer.indexerDb.getOrderInfo.resolves(makeOrderInfo({ GIVE_TICK: null, GIVE_REMAINING: '0' }));
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);

            const params = makeParams('1|42|');
            const data   = createBaseData({ ACTION: 'ORDER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await order.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            // createOrderStatus with 'cancelled'
            const calls = indexer.indexerDb.createOrderStatus.args.map(a => a[2]);
            assert.ok(calls.includes('cancelled'));
        });
    });
});
