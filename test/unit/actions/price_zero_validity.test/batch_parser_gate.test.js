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
// PRICE price-range flag day through the real parsers: both sides of the gate
// on the v0 batch parser, and the same seam on the v1 user oracle price.
// Part of the PRICE price-range suite; see ../price_zero_validity.test.js.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { createBaseData } = require('../../../fixtures/mocks');

const {
    hubAdmits, RANGE_CASES, batchBody, uncompressedParams, HONEST, TESTNET_GATE,
    newRangeHandler, batchWithFor, v0Data, usePriceRangeHarness,
} = require('./helpers/price_range_harness.js');

// Each test gets a fresh harness from usePriceRangeHarness; bind() hands it to
// the names the test bodies use.
let indexer, capable, hubClient;
const bind = (h) => { ({ indexer, capable, hubClient } = h); };
const newHandler = (network) => newRangeHandler(indexer, hubClient, network);
const batchWith  = (price) => batchWithFor(capable, price);

// -----------------------------------------------------------------------
// Both sides of the flag day, through the real parser.
// -----------------------------------------------------------------------
describe('PRICE price-range flag day @regression @tier3', function () {
    usePriceRangeHarness(bind);

    describe('the real gate, through the v0 batch parser', function () {
        it('AT the gate invalidates the WHOLE batch for a zero price', async function () {
            // regtest is genesis-armed, so this is the shipped rule refusing the shipped
            // defect with no stub involved.
            const data = v0Data({ BLOCK_TIME: 1700000000 });
            await newHandler().parse(uncompressedParams(batchBody(batchWith('0'))), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(String(data['STATUS']).includes('invalid price range'), data['STATUS']);
            assert.strictEqual(data['ROUNDS_JSON'], null, 'nothing partial may be stored');
            assert.strictEqual(data['SIGS_JSON'], null);
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called, 'nothing may reach the hub');
        });

        it('AT the gate refuses every value the hub refuses and accepts every value it admits', async function () {
            for(const price of RANGE_CASES){
                indexer.indexerDb.enqueueHubPushTx.resetHistory();
                const data = v0Data({ BLOCK_TIME: 1700000000 });
                await newHandler().parse(uncompressedParams(batchBody(batchWith(price))), data, null);

                if(hubAdmits(price)){
                    assert.strictEqual(data['STATUS'], 'valid', price + ' is hub-valid and must be chain-valid');
                    assert.ok(String(data['ROUNDS_JSON']).includes(price), price + ' must round-trip into the stored body');
                    assert.ok(indexer.indexerDb.enqueueHubPushTx.calledOnce, price + ' must reach the hub');
                } else {
                    assert.strictEqual(data['VALIDATION_STATUS'], 'invalid',
                        price + ' is hub-invalid and must be chain-invalid');
                    assert.strictEqual(data['ROUNDS_JSON'], null, price);
                    assert.ok(!indexer.indexerDb.enqueueHubPushTx.called, price);
                }
            }
        });

        it('BELOW the gate accepts the out-of-range values verbatim, so a replay does not move', async function () {
            // The live testnet ledger one second before its instant: the legacy verdict,
            // and the value must round-trip into rounds_json byte for byte.
            for(const price of RANGE_CASES.filter(p => !hubAdmits(p))){
                const data = v0Data({ BLOCK_TIME: TESTNET_GATE - 1 });
                await newHandler('testnet').parse(uncompressedParams(batchBody(batchWith(price))), data, null);
                assert.strictEqual(data['STATUS'], 'valid', price + ' must stay valid below the instant');
                assert.ok(String(data['ROUNDS_JSON']).includes(price),
                    price + ' must round-trip into the stored body byte-for-byte');
            }
        });

        it('AT the testnet instant refuses them, and the fixture crosses a real boundary', async function () {
            for(const price of RANGE_CASES.filter(p => !hubAdmits(p))){
                const data = v0Data({ BLOCK_TIME: TESTNET_GATE });
                await newHandler('testnet').parse(uncompressedParams(batchBody(batchWith(price))), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid', price + ' must be refused at the instant');
                assert.ok(String(data['STATUS']).includes('invalid price range'), data['STATUS']);
            }
        });
    });
});

describe('PRICE price-range flag day @regression @tier3', function () {
    usePriceRangeHarness(bind);

    describe('the real gate, through the v0 batch parser', function () {
        it('leaves an inert network and an unreadable block time on the legacy path', async function () {
            for(const [network, blockTime] of [['mainnet', 1700000000], ['mainnet', TESTNET_GATE], ['regtest', null]]){
                const data = v0Data({ BLOCK_TIME: blockTime });
                await newHandler(network).parse(uncompressedParams(batchBody(batchWith('0'))), data, null);
                assert.strictEqual(data['STATUS'], 'valid', network + ' t=' + String(blockTime));
                assert.ok(String(data['ROUNDS_JSON']).includes('"price":"0"'), 'the zero must be stored verbatim');
            }
        });

        it('accepts an all-honest batch on BOTH sides, so arming refuses no real round', async function () {
            for(const [network, blockTime] of [['mainnet', 1700000000], ['testnet', TESTNET_GATE - 1],
                                               ['testnet', TESTNET_GATE], ['regtest', 1700000000], ['regtest', null]]){
                const data = v0Data({ BLOCK_TIME: blockTime });
                await newHandler(network).parse(uncompressedParams(batchBody(batchWith(HONEST))), data, null);
                assert.strictEqual(data['STATUS'], 'valid', network + ' t=' + String(blockTime));
                assert.strictEqual(data['ROUND_COUNT'], 6);
            }
        });
    });
});

// -----------------------------------------------------------------------
// v1, the same seam on the action version whose loss is never re-derivable.
// -----------------------------------------------------------------------
describe('PRICE price-range flag day @regression @tier3', function () {
    usePriceRangeHarness(bind);

    describe('the v1 user oracle price', function () {

        const v1Params = (value) => ['1', 'BTC', 'TEST', 'USD', value, '0', 'm'];
        const v1Data   = (overrides = {}) => createBaseData({ ACTION: 'PRICE', FORMAT: 1, ...overrides });

        // The v1 regex caps the decimal side at 8 places, so only the cases that clear
        // it can reach the range bound at all.
        const V1_CASES = RANGE_CASES.filter(p => /^[0-9]+(\.[0-9]{1,8})?$/.test(p));

        it('AT the gate agrees with the hub v1 bound on every case', async function () {
            for(const value of V1_CASES){
                const data = v1Data({ BLOCK_TIME: 1700000000 });
                await newHandler().parse(v1Params(value), data, null);
                if(hubAdmits(value))
                    assert.strictEqual(data['VALIDATION_STATUS'], 'valid', value + ' is hub-valid');
                else
                    assert.ok(String(data['STATUS']).includes('VALUE'),
                        value + ' must be refused: ' + data['STATUS']);
            }
        });

        it('AT the gate refuses the at-ceiling value the lower-bound check alone let through', async function () {
            const data = v1Data({ BLOCK_TIME: 1700000000 });
            await newHandler().parse(v1Params('10000000000.00000000'), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(String(data['STATUS']).includes('range'), data['STATUS']);
        });

        it('BELOW the gate leaves the at-ceiling value valid, so a replay does not move', async function () {
            for(const [network, blockTime] of [['mainnet', 1700000000], ['testnet', TESTNET_GATE - 1], ['regtest', null]]){
                const data = v1Data({ BLOCK_TIME: blockTime });
                await newHandler(network).parse(v1Params('10000000000.00000000'), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid', network + ' t=' + String(blockTime));
            }
        });

        it('refuses zero on both sides, because the lower bound predates this flag day', async function () {
            // The existing exact-bcmath positivity check is NOT gated and must not become
            // gated by this change: a zero v1 value was already invalid everywhere.
            for(const [network, blockTime] of [['mainnet', 1700000000], ['regtest', 1700000000], ['regtest', null]]){
                const data = v1Data({ BLOCK_TIME: blockTime });
                await newHandler(network).parse(v1Params('0'), data, null);
                assert.ok(String(data['STATUS']).includes('VALUE'), network + ' t=' + String(blockTime));
            }
        });

        it('leaves an honest value valid on both sides', async function () {
            for(const [network, blockTime] of [['mainnet', 1700000000], ['testnet', TESTNET_GATE], ['regtest', 1700000000]]){
                const data = v1Data({ BLOCK_TIME: blockTime });
                await newHandler(network).parse(v1Params('50000.12345678'), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid', network + ' t=' + String(blockTime));
            }
        });
    });
});
