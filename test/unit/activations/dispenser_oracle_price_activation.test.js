/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/activations/dispenser_oracle_price_activation.test.js
 *
 * Mode B create-time effective-oracle-price flag-day. Mainnet is ARMED AT
 * GENESIS by the 2026-09-09 operator ruling: mainnet carries 0 dispensers and 0
 * dispenses (measured 2026-09-09), so a create-acceptance tightening at height
 * 0 has no create to re-judge and forks no from-genesis replay. The row itself
 * (dispenser_oracle_price_activation.DISPENSER_ORACLE_PRICE_ACTIVATION) is
 * pinned by the v2 fingerprint and compared row by row by the registry suites;
 * since W4 the create path reads it through activeAt() by that key, so the
 * "below the gate" case stubs the registry read rather than a shim predicate.
 *
 * The behavior the gate arms is pinned below: the precondition is a validity
 * rule that must run on a create carrying an ORACLE_ADDRESS whatever it escrows,
 * where before it only ran as a side effect of the GIVE_ESCROW>0 fee path and so
 * never ran at all on an ownership dispenser (whose GIVE_ESCROW must be empty).
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const gateRegistry = require('../../../src/consensus/gate_registry');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');
const Dispenser = require('../../../src/actions/dispenser/index.js');

let indexer, actionsCtx, dispenser;

const OWNER_ADDR  = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const ORACLE_ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const BLOCK_TIME  = 1700000000;
const EXPIRATION  = BLOCK_TIME + 86400 * 30;

// GIVE_OWNERSHIP=1 => GIVE_AMOUNT and GIVE_ESCROW are both empty, which is exactly
// the shape the fee path's GIVE_ESCROW>0 gate could never see.
const ownershipParams = () => String(
    `0|BTC|JDOG||1||BTC||0.01|${OWNER_ADDR}|USD||${ORACLE_ADDR}|${EXPIRATION}|||Ownership Mode B`
).split('|');

const modeBData = () => createBaseData(
    { ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

// The rule the gate arms, exercised through the real create path. Regtest is
// genesis-active, so these run above the gate unless the predicate is stubbed off.
describe('Mode B create requires an effective oracle price @regression @tier2', function () {
    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
        dispenser = new Dispenser(actionsCtx);

        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0,
                ALLOW_LIST: null, BLOCK_LIST: null, OWNER: OWNER_ADDR }));
        indexer.indexerDb.getTokenInfo
            .withArgs('', sinon.match.any, sinon.match.any).resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(null, sinon.match.any, sinon.match.any).resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(undefined, sinon.match.any, sinon.match.any).resolves(null);

        indexer.indexerDb.getAddressBalances.resolves({ 10: '0', 99: '999999999' });
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTickerId.resolves(99);
        indexer.indexerDb.isOwnershipEscrowed.resolves(false);
        indexer.indexerDb.setTokenEscrow = sinon.stub().resolves();
        indexer.indexerDb.getPricesInTimeRange = sinon.stub().resolves([{ price: '50000' }]);
    });

    afterEach(function () { sinon.restore(); });

    it('rejects an ownership create naming an oracle with no effective price', async function () {
        // The defect this gate closes. GIVE_ESCROW must be empty on an ownership
        // dispenser, so the fee path never ran and this create was accepted outright:
        // it locked the tick's ownership behind a dispenser that can never settle
        // (reverseOraclePriceMatch finds no row) and used the oracle for free.
        indexer.indexerDb.getOraclePrice = sinon.stub().resolves(null);

        const data = modeBData();
        await dispenser.parse(ownershipParams(), data, false);

        assert.strictEqual(data['STATUS'], 'invalid: ORACLE_ADDRESS (no effective oracle price)');
        sinon.assert.notCalled(indexer.indexerDb.setTokenEscrow);
    });
});

describe('Mode B create requires an effective oracle price @regression @tier2', function () {
    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
        dispenser = new Dispenser(actionsCtx);

        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0,
                ALLOW_LIST: null, BLOCK_LIST: null, OWNER: OWNER_ADDR }));
        indexer.indexerDb.getTokenInfo
            .withArgs('', sinon.match.any, sinon.match.any).resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(null, sinon.match.any, sinon.match.any).resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(undefined, sinon.match.any, sinon.match.any).resolves(null);

        indexer.indexerDb.getAddressBalances.resolves({ 10: '0', 99: '999999999' });
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTickerId.resolves(99);
        indexer.indexerDb.isOwnershipEscrowed.resolves(false);
        indexer.indexerDb.setTokenEscrow = sinon.stub().resolves();
        indexer.indexerDb.getPricesInTimeRange = sinon.stub().resolves([{ price: '50000' }]);
    });

    afterEach(function () { sinon.restore(); });

    it('still accepts that same create BELOW the gate (replay stays byte-identical)', async function () {
        // Historical blocks must re-evaluate exactly as they did, so below the flag-day
        // the legacy acceptance runs even though the oracle has published nothing.
        sinon.stub(gateRegistry, 'activeAt').callThrough()
            .withArgs('dispenser_oracle_price_activation.DISPENSER_ORACLE_PRICE_ACTIVATION').returns(false);
        indexer.indexerDb.getOraclePrice = sinon.stub().resolves(null);

        const data = modeBData();
        await dispenser.parse(ownershipParams(), data, false);

        assert.strictEqual(data['STATUS'], 'valid', data['STATUS']);
        sinon.assert.calledOnce(indexer.indexerDb.setTokenEscrow);
    });
});

describe('Mode B create requires an effective oracle price @regression @tier2', function () {
    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
        dispenser = new Dispenser(actionsCtx);

        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0,
                ALLOW_LIST: null, BLOCK_LIST: null, OWNER: OWNER_ADDR }));
        indexer.indexerDb.getTokenInfo
            .withArgs('', sinon.match.any, sinon.match.any).resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(null, sinon.match.any, sinon.match.any).resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(undefined, sinon.match.any, sinon.match.any).resolves(null);

        indexer.indexerDb.getAddressBalances.resolves({ 10: '0', 99: '999999999' });
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTickerId.resolves(99);
        indexer.indexerDb.isOwnershipEscrowed.resolves(false);
        indexer.indexerDb.setTokenEscrow = sinon.stub().resolves();
        indexer.indexerDb.getPricesInTimeRange = sinon.stub().resolves([{ price: '50000' }]);
    });

    afterEach(function () { sinon.restore(); });

    it('an ownership create against a priced oracle opens and owes no fee output', async function () {
        // The precondition is a validity rule, not a fee: the fee base is
        // oracle_price x GIVE_ESCROW, which is zero here, so no output is required
        // even though the oracle charges FEE=1%. TX_OUTPUTS is deliberately absent.
        indexer.indexerDb.getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0.01' });

        const data = modeBData();
        await dispenser.parse(ownershipParams(), data, false);

        assert.strictEqual(data['STATUS'], 'valid', data['STATUS']);
        sinon.assert.calledOnce(indexer.indexerDb.setTokenEscrow);
        sinon.assert.called(indexer.indexerDb.getOraclePrice);
    });
});

describe('Mode B create requires an effective oracle price @regression @tier2', function () {
    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
        dispenser = new Dispenser(actionsCtx);

        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0,
                ALLOW_LIST: null, BLOCK_LIST: null, OWNER: OWNER_ADDR }));
        indexer.indexerDb.getTokenInfo
            .withArgs('', sinon.match.any, sinon.match.any).resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(null, sinon.match.any, sinon.match.any).resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(undefined, sinon.match.any, sinon.match.any).resolves(null);

        indexer.indexerDb.getAddressBalances.resolves({ 10: '0', 99: '999999999' });
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTickerId.resolves(99);
        indexer.indexerDb.isOwnershipEscrowed.resolves(false);
        indexer.indexerDb.setTokenEscrow = sinon.stub().resolves();
        indexer.indexerDb.getPricesInTimeRange = sinon.stub().resolves([{ price: '50000' }]);
    });

    afterEach(function () { sinon.restore(); });

    it('covers a zero-escrow balance create too, not just ownership', async function () {
        // Open-now-refill-later: GIVE_AMOUNT positive, GIVE_ESCROW empty. The fee path
        // skipped it for the same reason.
        indexer.indexerDb.getOraclePrice = sinon.stub().resolves(null);

        // FORMAT 0 field order: GIVE_AMOUNT, GIVE_OWNERSHIP, GIVE_ESCROW.
        const withEmptyEscrow = String(
            `0|BTC|JDOG|1|0||BTC||0.01|${OWNER_ADDR}|USD||${ORACLE_ADDR}|${EXPIRATION}|||Refill later`
        ).split('|');

        const data = modeBData();
        await dispenser.parse(withEmptyEscrow, data, false);

        assert.strictEqual(data['STATUS'], 'invalid: ORACLE_ADDRESS (no effective oracle price)');
    });
});

describe('Mode B create requires an effective oracle price @regression @tier2', function () {
    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
        dispenser = new Dispenser(actionsCtx);

        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0,
                ALLOW_LIST: null, BLOCK_LIST: null, OWNER: OWNER_ADDR }));
        indexer.indexerDb.getTokenInfo
            .withArgs('', sinon.match.any, sinon.match.any).resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(null, sinon.match.any, sinon.match.any).resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(undefined, sinon.match.any, sinon.match.any).resolves(null);

        indexer.indexerDb.getAddressBalances.resolves({ 10: '0', 99: '999999999' });
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTickerId.resolves(99);
        indexer.indexerDb.isOwnershipEscrowed.resolves(false);
        indexer.indexerDb.setTokenEscrow = sinon.stub().resolves();
        indexer.indexerDb.getPricesInTimeRange = sinon.stub().resolves([{ price: '50000' }]);
    });

    afterEach(function () { sinon.restore(); });

    it('leaves Mode A alone: no oracle named, no lookup attempted', async function () {
        const getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0.01' });
        indexer.indexerDb.getOraclePrice = getOraclePrice;

        const params = String(
            `0|BTC|JDOG|1|0|10|BTC||0.01|${OWNER_ADDR}|USD|0.05||${EXPIRATION}|||Mode A`
        ).split('|');
        indexer.indexerDb.getAddressBalances.resolves({ 10: '1000', 99: '999999999' });

        const data = modeBData();
        await dispenser.parse(params, data, false);

        assert.strictEqual(data['STATUS'], 'valid', data['STATUS']);
        sinon.assert.notCalled(getOraclePrice);
    });
});
