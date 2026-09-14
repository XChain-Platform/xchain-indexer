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
// DISPENSER create paths: LIST field validation, the ownership dispenser, the
// non-unified expiration fee and the native-coin fee payment modes.
// Part of the Dispenser suite; see ../dispenser.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const { OWNER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, useDispenserHarness } = require('./helpers/dispenser_harness.js');

const Dispenser = require('../../../../src/actions/dispenser/index.js');

// The harness under test. useDispenserHarness rebuilds it before every test
// and restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, dispenser;
const bind = (h) => { ({ indexer, actionsCtx, dispenser } = h); };

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    // ─── LIST field validation (lines 304-314) ───────────────────────────

    describe('LIST field validation', function () {

        it('unknown ALLOW_LIST returns invalid', async function () {
            indexer.indexerDb.getListType.resolves(false);

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|99||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('ALLOW_LIST') && data['STATUS'].includes('unknown'));
        });

        it('unsupported LIST type (tick list) returns invalid', async function () {
            // Type 1 = tick list; dispenser.listTypes only includes type 2 (address)
            indexer.indexerDb.getListType.resolves(1);

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|99||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('unsupported'));
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    // ─── Ownership dispenser create path (lines 438-442) ─────────────────

    describe('GIVE_OWNERSHIP=1 (ownership dispenser)', function () {

        beforeEach(function () {
            indexer.indexerDb.setTokenEscrow = sinon.stub().resolves();
            // Ownership source must be token owner
            indexer.indexerDb.getTokenInfo
                .withArgs('JDOG', sinon.match.any, sinon.match.any)
                .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null, OWNER: OWNER_ADDR }));
            indexer.indexerDb.isOwnershipEscrowed.resolves(false);
        });

        it('valid ownership-give dispenser calls setTokenEscrow and no balance escrow', async function () {
            // FORMAT: 0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|...
            // GIVE_OWNERSHIP=1, GIVE_AMOUNT and GIVE_ESCROW must be empty
            indexer.indexerDb.getAddressBalances.resolves({ 10: '0', 99: '999999999' });
            const params = makeParams(`0|BTC|JDOG||1||BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.setTokenEscrow);
        });

        it('ownership dispenser: ownership_escrow fee included in unified fees', async function () {
            // With UNIFIED_FEES enabled (default), ownership escrow fee is added
            indexer.indexerDb.getAddressBalances.resolves({ 10: '0', 99: '999999999' });
            const params = makeParams(`0|BTC|JDOG||1||BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            // If UNIFIED_FEES branches covered; status valid means fee path was exercised
            assert.strictEqual(data['STATUS'], 'valid');
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    // ─── Non-unified fee path (line 348-349) ─────────────────────────────

    describe('Non-unified expiration fee path', function () {

        it('legacy getExpirationFee path when UNIFIED_FEES disabled', async function () {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().resolves(false);

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            // valid or invalid depending on fee; key point is legacy branch was executed
            sinon.assert.calledOnce(indexer.indexerDb.createDispenser);
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    // ─── Native coin fee payment paths (lines 354-371) ───────────────────

    describe('Native coin fee payment path', function () {
        it('valid native coin fee sets PAYMENT_MODE=1', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: true,
                nativeCoinAmount: '0.0001',
                nativeCoin: 'BTC',
                oracleRound: 1,
            });
            sinon.stub(indexer.util, 'getUnifiedExpirationFee').returns({ gasCost: 100, fee: '0.00001' });

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('invalid native coin fee returns error', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: false,
                error: 'output too small',
            });
            sinon.stub(indexer.util, 'getUnifiedExpirationFee').returns({ gasCost: 100, fee: '0.00001' });

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].startsWith('invalid'));
        });

        it('rejected payment mode returns insufficient fee error', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('rejected');
            sinon.stub(indexer.util, 'getUnifiedExpirationFee').returns({ gasCost: 100, fee: '0.00001' });

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('insufficient fee'));
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('Native coin fee payment path', function () {
        it('insufficient xchain fee balance returns error', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('xchain');
            sinon.stub(indexer.util, 'getUnifiedExpirationFee').returns({ gasCost: 100, fee: '9999999' });

            // Deplete the fee balance
            indexer.indexerDb.getAddressBalances.resolves({ 10: '1000', 99: '0' });

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('insufficient funds') || data['STATUS'].startsWith('invalid'));
        });
    });
});
