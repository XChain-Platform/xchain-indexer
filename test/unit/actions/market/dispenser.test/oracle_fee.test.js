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
// DISPENSER Format 0 oracle usage fee: the Mode B charge to the oracle
// operator, and where it is not charged.
// Part of the Dispenser suite; see ../dispenser.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { OWNER_ADDR, OTHER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, useDispenserHarness } = require('./helpers/dispenser_harness.js');

const Dispenser = require('../../../../../src/actions/dispenser/index.js');

// The harness under test. useDispenserHarness rebuilds it before every test
// and restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, dispenser;
const bind = (h) => { ({ indexer, actionsCtx, dispenser } = h); };

const ORACLE_ADDR = OTHER_ADDR;   // any valid address that is not the opener

function modeBParams(escrow = '1000') {
    return makeParams(
        `0|BTC|JDOG|1||${escrow}|BTC||0|${OWNER_ADDR}|USD||${ORACLE_ADDR}|${EXPIRATION}|||Mode B`);
}
const modeBData = () => createBaseData(
    { ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    // Counterparty parity. A Mode B dispenser (ORACLE_ADDRESS set) pays the
    // oracle operator UP FRONT as a real native-coin output, charged to the address
    // opening it. These pin the wiring: that the charge fires only for Mode B, only
    // when escrow is added, only under the gate, and that it rejects the create when
    // the output is missing. The fee arithmetic and every branch of the check itself
    // are covered in utility.computeOracleFee / utility.validateOracleFee tests.
    describe('Format 0 - oracle usage fee', function () {
        it('rejects the create when the oracle fee output is missing', async function () {
            indexer.indexerDb.getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0.01' });
            indexer.indexerDb.getPricesInTimeRange = sinon.stub().resolves([{ price: '50000' }]);

            const data = modeBData();                 // no TX_OUTPUTS at all
            await dispenser.parse(modeBParams(), data, false);

            assert.strictEqual(data['STATUS'], 'invalid: ORACLE_ADDRESS (missing oracle fee output)');
            // createDispenser still records the invalid attempt (see the GIVE_TICK case
            // above); what must not happen is the escrow moving.
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });

        it('accepts the create when the output pays the oracle', async function () {
            indexer.indexerDb.getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0.01' });
            indexer.indexerDb.getPricesInTimeRange = sinon.stub().resolves([{ price: '50000' }]);

            const data = modeBData();
            data['TX_OUTPUTS'] = [{ address: ORACLE_ADDR, value: '0.00001' }];
            await dispenser.parse(modeBParams(), data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenser);
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('Format 0 - oracle usage fee', function () {
        it('rejects the create when the oracle has no effective price', async function () {
            // Operator ruling: a dispenser must reference an oracle that has prices set.
            indexer.indexerDb.getOraclePrice = sinon.stub().resolves(null);

            const data = modeBData();
            data['TX_OUTPUTS'] = [{ address: ORACLE_ADDR, value: '1' }];
            await dispenser.parse(modeBParams(), data, false);

            assert.strictEqual(data['STATUS'], 'invalid: ORACLE_ADDRESS (no effective oracle price)');
        });

        it('never charges a Mode A dispenser, which has no oracle operator to pay', async function () {
            // FIAT_AMOUNT-only pricing reads validator snapshots, and validators are
            // already compensated, so the oracle lookup must not even be attempted.
            const getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0.01' });
            indexer.indexerDb.getOraclePrice = getOraclePrice;

            const params = makeParams(
                `0|BTC|JDOG|1||10|BTC||0|${OWNER_ADDR}|USD|0.05||${EXPIRATION}|||Mode A`);
            const data = modeBData();
            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.notCalled(getOraclePrice);
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('Format 0 - oracle usage fee', function () {
        it('does not charge below the activation gate', async function () {
            actionsCtx.protocolChanges.isEnabled
                .withArgs('FIAT_DISPENSER_PRICING', sinon.match.any).resolves(false);
            const getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0.01' });
            indexer.indexerDb.getOraclePrice = getOraclePrice;

            const data = modeBData();                 // no output, yet must still pass
            await dispenser.parse(modeBParams(), data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.notCalled(getOraclePrice);
        });

        it('does not charge an ownership dispenser, which escrows no balance', async function () {
            // The FEE is nil here and no output is required: its base is
            // oracle_price x GIVE_ESCROW, and an ownership dispenser must carry an empty
            // GIVE_ESCROW. The oracle price IS still read, because the effective-price
            // rule is a validity precondition on the create rather than part of the fee
            // (see dispenser_oracle_price_activation.js); what must not happen is a fee
            // being demanded. No TX_OUTPUTS are supplied, so a charge would reject.
            const getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0.01' });
            indexer.indexerDb.getOraclePrice = getOraclePrice;
            indexer.indexerDb.setTokenEscrow = sinon.stub().resolves();
            indexer.indexerDb.isOwnershipEscrowed.resolves(false);
            indexer.indexerDb.getAddressBalances.resolves({ 10: '0', 99: '999999999' });

            // GIVE_OWNERSHIP=1 carries empty GIVE_AMOUNT/GIVE_ESCROW.
            const params = makeParams(
                `0|BTC|JDOG||1||BTC||0|${OWNER_ADDR}|USD||${ORACLE_ADDR}|${EXPIRATION}|||Ownership`);
            const data = modeBData();
            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid', data['STATUS']);
            sinon.assert.calledOnce(indexer.indexerDb.setTokenEscrow);
        });
    });
});
