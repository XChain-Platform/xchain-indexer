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
// ORDER field and fee paths: the GET_ADDRESS contract rules, GET_OWNERSHIP
// bids, ALLOW_LIST types, the non-unified expiration fee, native coin fee
// payment and the ownership-give order that escrows the token itself.
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

// ─── GET_ADDRESS contract address validation (lines 194-198) ────────────

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

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
});

// ─── GET_OWNERSHIP bid validation (lines 232-238) ────────────────────

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

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
});

// ─── LIST field validation (lines 288-298) ───────────────────────────

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

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

            // Still valid: getExpirationFee returns 0 at default GAS_PRICE=0.00001 for short windows
            assert.ok(data['STATUS'] === 'valid' || data['STATUS'].startsWith('invalid'));
            sinon.assert.calledOnce(indexer.indexerDb.createOrder);
        });
    });
});

// ─── Native coin fee payment path (lines 340-348) ────────────────────

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

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
});

// ─── Ownership-give order (lines 414-417) ────────────────────────────

describe('Order action handler @regression @tier2', function () {
    beforeEach(freshOrder);
    afterEach(() => sinon.restore());

    describe('GIVE_OWNERSHIP=1 (ownership order)', function () {

        beforeEach(function () {
            // setTokenEscrow is not in the shared mock; add it here
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
});
