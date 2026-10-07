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

const { stubGate } = require('../../../helpers/gate_modules.js');
const {
    PUBKEY_A, PUBKEY_B, PUBKEY_C, REQ_ID, feeRequestRow, setUpAttestHandler
} = require('../../../helpers/attest_fixture.js');

const RELAY_FEE_KEY = 'attest_relay_fee_activation.ATTEST_RELAY_FEE_ACTIVATION';
const BTC_SOURCE = '17Roegnpwqam4FwwXsM47bX3Tf1jFyyKMt';

let indexer, handler, relayFeeGate;

function setUpHandler(){
    ({ indexer, handler } = setUpAttestHandler());
    relayFeeGate = stubGate(sinon, RELAY_FEE_KEY, true);
}

function relayData(overrides = {}){
    return {
        BLOCK_INDEX: 3160000,
        BLOCK_TIME: 1700009999,
        SNAPSHOT_BLOCK: 100,
        ...overrides,
    };
}

function stubRelayPrices(overrides = {}){
    return sinon.stub(indexer.util, 'getFeeOraclePrices').callsFake(async (_db, coin) => {
        if(Object.prototype.hasOwnProperty.call(overrides, coin)){
            let value = overrides[coin];
            if(value instanceof Error) throw value;
            return value;
        }
        return {
            coinUsdPrice: coin === 'BTC' ? '50000' : '100',
            xchainUsdPrice: '2.5',
            oracleRound: 7,
        };
    });
}

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());

    describe('relay fee carve helpers', function () {
        it('selects the lowest request-bound hash across lower-cased verified signers', function () {
            assert.strictEqual(
                handler.relayFeePayee(REQ_ID, [PUBKEY_C.toUpperCase(), PUBKEY_B, PUBKEY_A]),
                PUBKEY_A);
        });

        it('dedupes signer pubkeys and returns null for an empty signer list', function () {
            let once = handler.relayFeePayee(REQ_ID, [PUBKEY_B, PUBKEY_A]);
            let repeated = handler.relayFeePayee(
                REQ_ID, [PUBKEY_B, PUBKEY_A.toUpperCase(), PUBKEY_A, PUBKEY_B]);
            assert.strictEqual(repeated, once);
            assert.strictEqual(handler.relayFeePayee(REQ_ID, []), null);
            assert.strictEqual(handler.relayFeePayee(REQ_ID, null), null);
        });

        it('uses the buried snapshot source and re-encodes it for DOGE and LTC', async function () {
            handler.config['NETWORK'] = 'mainnet';
            indexer.indexerDb.getCapabilitySnapshotWeights.resolves([
                { pubkey: PUBKEY_A, source: BTC_SOURCE, weight: '100' },
            ]);
            let reencode = sinon.spy(indexer.util, 'crossChainReencodeAddress');

            for(let coin of ['DOGE', 'LTC']){
                handler.config['COIN'] = coin;
                let payout = await handler.relayFeePayoutAddress(PUBKEY_A.toUpperCase(), 100);
                assert.strictEqual(indexer.util.isCryptoAddress(payout, coin, 'mainnet'), true, coin);
                assert.notStrictEqual(payout, BTC_SOURCE, coin);
                assert.ok(reencode.calledWith(BTC_SOURCE, 'BTC', coin, 'mainnet'), coin);
            }
            assert.ok(indexer.indexerDb.getCapabilitySnapshotWeights.alwaysCalledWith(
                'cross_chain', 94));
        });

        it('refuses a truncated snapshot before choosing a payout source', async function () {
            let rows = [{ pubkey: PUBKEY_A, source: BTC_SOURCE, weight: '100' }];
            rows.truncated = true;
            indexer.indexerDb.getCapabilitySnapshotWeights.resolves(rows);
            let reencode = sinon.spy(indexer.util, 'crossChainReencodeAddress');
            assert.strictEqual(await handler.relayFeePayoutAddress(PUBKEY_A, 100), null);
            assert.strictEqual(reencode.called, false);
        });

        it('returns null when the payee has no source in the snapshot', async function () {
            indexer.indexerDb.getCapabilitySnapshotWeights.resolves([
                { pubkey: PUBKEY_B, source: BTC_SOURCE, weight: '100' },
            ]);
            assert.strictEqual(await handler.relayFeePayoutAddress(PUBKEY_A, 100), null);
        });

        it('returns zero below the snapshot-plane gate without reading prices', async function () {
            relayFeeGate.returns(false);
            let prices = stubRelayPrices();
            assert.strictEqual(
                await handler.relayFeeAllowance(feeRequestRow(), relayData(), '6', 8), '0');
            assert.strictEqual(prices.called, false);
            assert.ok(relayFeeGate.calledWith('regtest', null, 100, null));
        });

        it('adds one flat native allowance for each relay leg on the GAS grid', async function () {
            handler.config['COIN'] = 'DOGE';
            let prices = stubRelayPrices();
            let mirrorEra = sinon.spy(handler, 'isMirrorEraRequest');
            let allowance = await handler.relayFeeAllowance(
                feeRequestRow(), relayData(), '6.00000000', 8);
            assert.strictEqual(String(allowance), '2.004');
            assert.deepStrictEqual(prices.getCalls().map(call => call.args[1]), ['BTC', 'DOGE']);
            assert.strictEqual(mirrorEra.called, false);
        });

        it('zeroes only the home leg when its price is missing', async function () {
            handler.config['COIN'] = 'DOGE';
            stubRelayPrices({ BTC: { error: 'missing BTC price' } });
            assert.strictEqual(String(await handler.relayFeeAllowance(
                feeRequestRow(), relayData(), '6', 8)), '0.004');
        });

        it('zeroes only the origin leg when its price is missing', async function () {
            handler.config['COIN'] = 'DOGE';
            stubRelayPrices({ DOGE: { error: 'missing DOGE price' } });
            assert.strictEqual(String(await handler.relayFeeAllowance(
                feeRequestRow(), relayData(), '6', 8)), '2');
        });

        it('zeroes a leg on an ordinary oracle exception and keeps the other leg', async function () {
            handler.config['COIN'] = 'DOGE';
            stubRelayPrices({ BTC: new Error('oracle unavailable') });
            assert.strictEqual(String(await handler.relayFeeAllowance(
                feeRequestRow(), relayData(), '6', 8)), '0.004');
        });

        it('rethrows an infrastructure oracle fault', async function () {
            handler.config['COIN'] = 'DOGE';
            let fault = new Error('price barrier deferred');
            fault.code = 'PRICE_BARRIER_DEFERRED';
            stubRelayPrices({ BTC: fault });
            await assert.rejects(
                handler.relayFeeAllowance(feeRequestRow(), relayData(), '6', 8),
                error => error === fault);
        });

        it('clamps an overlay cap to the shipped hard maximum on both legs', async function () {
            handler.config['COIN'] = 'DOGE';
            handler.providerRegistry.providers.http_get = {
                ...handler.providerRegistry.providers.http_get,
                broadcast_fee_cap_native: '0.5',
            };
            sinon.stub(indexer.util, 'getFeeOraclePrices').resolves({
                coinUsdPrice: '100', xchainUsdPrice: '1', oracleRound: 7,
            });
            assert.strictEqual(String(await handler.relayFeeAllowance(
                feeRequestRow(), relayData(), '6', 8)), '0.2');
        });

        it('clamps the combined two-leg allowance to a thinner escrow', async function () {
            handler.config['COIN'] = 'DOGE';
            stubRelayPrices();
            assert.strictEqual(String(await handler.relayFeeAllowance(
                feeRequestRow(), relayData(), '0.50000000', 8)), '0.5');
        });

        it('is deterministic for repeated identical inputs', async function () {
            handler.config['COIN'] = 'DOGE';
            stubRelayPrices();
            let request = feeRequestRow();
            let data = relayData();
            let first = await handler.relayFeeAllowance(request, data, '6', 8);
            let second = await handler.relayFeeAllowance(request, data, '6', 8);
            assert.strictEqual(String(second), String(first));
            assert.strictEqual(
                handler.relayFeePayee(REQ_ID, [PUBKEY_C, PUBKEY_A, PUBKEY_B]),
                handler.relayFeePayee(REQ_ID, [PUBKEY_C, PUBKEY_A, PUBKEY_B]));
        });
    });
});
