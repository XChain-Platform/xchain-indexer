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
// PRICE v0 batch structural checks (step 2): the round window, the ROUND_COUNT
// bound, ascending rounds, per-round pair rules and the signature fields.
// Part of the PRICE batch suite; see ../price_batch.test.js.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const {
    newIdentity, batchBody, uncompressedParams, sixRounds, signBatch, v2Data,
    newPriceHandler, validBatchFor, usePriceBatchHarness,
} = require('./helpers/price_batch_harness.js');

const comp          = require('../../../../../src/actions/price/price_batch_compression.js');

// Each test gets a fresh harness from usePriceBatchHarness; bind() hands it to
// the names the test bodies use and builds the handler they drive.
let indexer, handler, hubClient, capable;
const bind = (h) => { ({ indexer, capable, hubClient } = h); handler = newHandler(); };
const newHandler = () => newPriceHandler(indexer, hubClient);
const validBatch = () => validBatchFor(capable);

// -----------------------------------------------------------------------
// 2. Structural checks
// -----------------------------------------------------------------------
describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('structural checks (step 2)', function () {
        it('rejects FIRST_ROUND > LAST_ROUND', async function () {
            const body = batchBody(validBatch());
            body[0] = '106'; body[1] = '105';
            const data = v2Data();
            await handler.parse(uncompressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes('ROUND window'));
        });

        it('rejects a non-integer or negative window bound', async function () {
            for(const [idx, value] of [[0, 'abc'], [0, '-1'], [1, ''], [2, 'x'], [3, '0.5']]){
                const body = batchBody(validBatch());
                body[idx] = value;
                const data = v2Data();
                await newHandler().parse(uncompressedParams(body), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid',
                    'field ' + idx + ' = ' + JSON.stringify(value) + ' must invalidate');
            }
        });

        // THE DoS BOUND on batch size. The count is attacker-supplied and drives the parse loop on
        // every indexing node, so it is bounded BEFORE the loop runs. This case is the
        // behavioural pin: the batch below is otherwise perfect (real signatures over the
        // real canonical, quorate, ascending, in-window), so with the bound it is INVALID
        // and without the bound it is VALID and stored.
        it('rejects a fully-signed, otherwise-valid batch of 300 rounds', async function () {
            const rounds = [];
            for(let i = 0; i < 300; i++)
                rounds.push({ round: 1000 + i, timestamp: 1700000000 + i, btcBlockHeight: 799000 + i,
                              pairs: [{ pair: 'BTC/USD', price: '50000' }] });
            const id = newIdentity();
            capable.add(id.pubkey);
            const batch = signBatch(rounds, [id]);

            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(batch)), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid',
                'a 300-round batch must be refused by the ROUND_COUNT bound, not accepted');
            assert.ok(data['STATUS'].includes('ROUND_COUNT'), data['STATUS']);
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called);
        });

        it('refuses an enormous ROUND_COUNT without entering the parse loop', async function () {
            const body = batchBody(validBatch());
            body[3] = '4000000000';
            const data = v2Data();
            await handler.parse(uncompressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes(String(comp.PRICE_BATCH_MAX_ROUND_COUNT)), data['STATUS']);
        });
    });
});

describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('structural checks (step 2)', function () {
        it('accepts exactly PRICE_BATCH_MAX_ROUND_COUNT and refuses one more', async function () {
            const make = n => {
                const rounds = [];
                for(let i = 0; i < n; i++)
                    rounds.push({ round: 1000 + i, timestamp: 1700000000 + i, btcBlockHeight: 799000 + i,
                                  pairs: [{ pair: 'BTC/USD', price: '50000' }] });
                const id = newIdentity();
                capable.add(id.pubkey);
                return signBatch(rounds, [id]);
            };
            const at = v2Data();
            await handler.parse(uncompressedParams(batchBody(make(comp.PRICE_BATCH_MAX_ROUND_COUNT))), at, null);
            assert.strictEqual(at['STATUS'], 'valid');

            const over = v2Data();
            await newHandler().parse(uncompressedParams(batchBody(make(comp.PRICE_BATCH_MAX_ROUND_COUNT + 1))), over, null);
            assert.strictEqual(over['VALIDATION_STATUS'], 'invalid');
        });

        it('rejects a ROUND_COUNT that does not match the round blocks actually present', async function () {
            for(const declared of ['5', '7']){
                const body = batchBody(validBatch());
                body[3] = declared;
                const data = v2Data();
                await newHandler().parse(uncompressedParams(body), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid',
                    'ROUND_COUNT ' + declared + ' against six round blocks must invalidate');
            }
        });

        it('rejects rounds that are not strictly ascending, including a duplicate', async function () {
            for(const mutate of [
                r => { const t = r[0].round; r[0].round = r[1].round; r[1].round = t; },  // swapped
                r => { r[2].round = r[1].round; },                                        // duplicate
            ]){
                const rounds = sixRounds();
                mutate(rounds);
                const id = newIdentity();
                capable.add(id.pubkey);
                const batch = signBatch(rounds, [id], { firstRound: 100, lastRound: 105 });
                const data  = v2Data();
                await newHandler().parse(uncompressedParams(batchBody(batch)), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
                assert.ok(data['STATUS'].includes('ascending'), data['STATUS']);
            }
        });
    });
});

describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('structural checks (step 2)', function () {
        it('rejects a round outside the declared window', async function () {
            for(const [idx, value] of [[0, 99], [5, 106]]){
                const rounds = sixRounds();
                rounds[idx].round = value;
                const id = newIdentity();
                capable.add(id.pubkey);
                const batch = signBatch(rounds, [id], { firstRound: 100, lastRound: 105 });
                const data  = v2Data();
                await newHandler().parse(uncompressedParams(batchBody(batch)), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            }
        });

        it('applies v0 per-round pair rules, and a single bad pair invalidates the WHOLE batch', async function () {
            // The signature set covers every round, so dropping the offending entry would
            // change the signed bytes; a signed batch is atomic exactly as a signed round is.
            for(const [pair, price] of [['BTCUSD', '50000'], ['BTC/USD', 'abc'], ['BTC/USD', '-5']]){
                const rounds = sixRounds();
                rounds[3].pairs[0] = { pair, price };
                const id = newIdentity();
                capable.add(id.pubkey);
                const batch = signBatch(rounds, [id]);
                const data  = v2Data();
                await newHandler().parse(uncompressedParams(batchBody(batch)), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid',
                    pair + ' ' + price + ' must invalidate the batch');
                assert.strictEqual(data['ROUNDS_JSON'], null, 'nothing partial may be stored');
            }
        });

        it('rejects a malformed signature field', async function () {
            for(const mutate of [
                b => { b[b.length - 2] = 'zz'; },          // pubkey not 64-hex
                b => { b[b.length - 1] = 'ff'; },          // sig not 128-hex
                b => { b.splice(b.length - 3, 1, '0'); },  // SIG_COUNT 0
            ]){
                const body = batchBody(validBatch());
                mutate(body);
                const data = v2Data();
                await newHandler().parse(uncompressedParams(body), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            }
        });
    });
});
