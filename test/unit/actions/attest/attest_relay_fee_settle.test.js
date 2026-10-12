// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { createBaseData } = require('../../../fixtures/mocks.js');
const { stubGate } = require('../../../helpers/gate_modules.js');
const { FEE_PAYER } = require('../../../helpers/attest_fixture.js');
const {
    PUBKEY_A, REQ_ID, v4Params, originRequestRow, setupRelay
} = require('../attest_relay.test/helpers/relay_fixture.js');

const RELAY_FEE_KEY = 'attest_relay_fee_activation.ATTEST_RELAY_FEE_ACTIVATION';

function relayData(){
    return createBaseData({
        ACTION: 'ATTEST', FORMAT: 4, BLOCK_INDEX: 3160010,
        BLOCK_TIME: 1700009999, ACTION_INDEX: 80,
    });
}

function creditAt(indexer, address){
    let call = indexer.indexerDb.createCredit.getCalls()
        .find(candidate => candidate.args[3] === address);
    return call ? String(call.args[2]) : null;
}

describe('Attest relay fee settlement @regression @tier3', function () {
    let indexer, handler, relayFeeGate, rewardPool, prices;

    beforeEach(function () {
        ({ indexer, handler } = setupRelay());
        relayFeeGate = stubGate(sinon, RELAY_FEE_KEY, true);
        indexer.config['COIN'] = 'LTC';
        rewardPool = indexer.config['ADDRESS']['REWARD'];
        indexer.indexerDb.getAttestationRequestById.resolves(originRequestRow({
            fee_amount: '6.00000000', fee_payer: FEE_PAYER,
        }));
        indexer.indexerDb.getCapabilitySnapshotWeights = sinon.stub().resolves([
            { pubkey: PUBKEY_A, source: FEE_PAYER, weight: '100' },
        ]);
        prices = sinon.stub(indexer.util, 'getFeeOraclePrices')
            .callsFake(async (_db, coin) => ({
                coinUsdPrice: coin === 'BTC' ? '50000' : '100',
                xchainUsdPrice: '2.5',
                oracleRound: 7,
            }));
    });

    afterEach(() => sinon.restore());

    it('credits the verified relay payee and sends only the remainder to REWARD', async function () {
        let data = relayData();
        await handler.parse(v4Params(), data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(data['SNAPSHOT_BLOCK'], 100);
        assert.strictEqual(creditAt(indexer, FEE_PAYER), '2.004');
        assert.strictEqual(creditAt(indexer, rewardPool), '3.996');
        assert.deepStrictEqual(
            prices.getCalls().map(call => call.args[1]), ['BTC', 'LTC']);
        assert.ok(indexer.indexerDb.getCapabilitySnapshotWeights.calledWith(
            'cross_chain', 94));
        assert.strictEqual(indexer.indexerDb.createValidatorReward.called, false);
        assert.strictEqual(String(indexer.indexerDb.createEscrow.firstCall.args[2]), '-6');
    });

    it('leaves the full escrow in REWARD below the relay fee gate', async function () {
        relayFeeGate.returns(false);
        let data = relayData();
        await handler.parse(v4Params(), data, null);

        assert.strictEqual(creditAt(indexer, rewardPool), '6.00000000');
        assert.strictEqual(indexer.indexerDb.createCredit.callCount, 1);
        assert.strictEqual(prices.called, false);
        assert.strictEqual(indexer.indexerDb.getCapabilitySnapshotWeights.called, false);
    });

    it('leaves the full escrow in REWARD when the payee has no snapshot source', async function () {
        indexer.indexerDb.getCapabilitySnapshotWeights.resolves([]);
        let data = relayData();
        await handler.parse(v4Params(), data, null);

        assert.strictEqual(creditAt(indexer, rewardPool), '6.00000000');
        assert.strictEqual(indexer.indexerDb.createCredit.callCount, 1);
        assert.strictEqual(prices.callCount, 2);
    });

    it('refunds an expired relay without pricing or paying an allowance', async function () {
        let data = relayData();
        await handler.parse(v4Params({ status: 'expired', payloadB64: '' }), data, null);

        assert.strictEqual(creditAt(indexer, FEE_PAYER), '6.00000000');
        assert.strictEqual(creditAt(indexer, rewardPool), null);
        assert.strictEqual(prices.called, false);
        assert.strictEqual(indexer.indexerDb.getCapabilitySnapshotWeights.called, false);
    });

    it('uses only signers accepted by relay quorum to select the payee', async function () {
        let relayPayee = sinon.spy(handler, 'relayFeePayee');
        let data = relayData();
        await handler.parse(v4Params(), data, null);

        assert.ok(relayPayee.calledOnceWithExactly(REQ_ID, [PUBKEY_A]));
    });
});
