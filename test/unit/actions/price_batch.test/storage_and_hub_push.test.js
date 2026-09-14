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
// PRICE v0 batch storage (step 5), the hub push outbox (step 6) and the zero
// validator rewards a batch earns.
// Part of the PRICE batch suite; see ../price_batch.test.js.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const {
    newIdentity, batchBody, uncompressedParams, compressedParams, sixRounds,
    signBatch, v2Data, newPriceHandler, validBatchFor, usePriceBatchHarness,
} = require('./helpers/price_batch_harness.js');

// Each test gets a fresh harness from usePriceBatchHarness; bind() hands it to
// the names the test bodies use and builds the handler they drive.
let indexer, handler, hubClient, capable;
const bind = (h) => { ({ indexer, capable, hubClient } = h); handler = newHandler(); };
const newHandler = () => newPriceHandler(indexer, hubClient);
const validBatch = () => validBatchFor(capable);

// -----------------------------------------------------------------------
// 5. Storage
// -----------------------------------------------------------------------
describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('storage (step 5)', function () {
        it('stores round_number = FIRST_ROUND and the batch window columns', async function () {
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);

            assert.strictEqual(data['ROUND'], 100, 'round_number carries FIRST_ROUND (D21)');
            assert.strictEqual(data['BATCH_FIRST_ROUND'], 100);
            assert.strictEqual(data['BATCH_LAST_ROUND'], 105);
            assert.strictEqual(data['ROUND_COUNT'], 6);
            assert.strictEqual(data['VERSION'], 0);
            assert.ok(indexer.indexerDb.createPrice.calledOnce);
            assert.strictEqual(indexer.indexerDb.createPrice.firstCall.args[0], data);
        });

        it('leaves pair_count, pairs_json and sig_count NULL on a v2 row', async function () {
            // Those three describe ONE round; on a batch row they would describe the window
            // wrongly, so rounds_json and sigs_json carry the batch instead.
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            assert.strictEqual(data['PAIR_COUNT'], undefined);
            assert.strictEqual(data['PAIRS_JSON'], undefined);
            assert.strictEqual(data['SIG_COUNT'], undefined);
        });

        it('stores rounds_json in the snake-cased per-round shape sql/prices.sql documents', async function () {
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            const rounds = JSON.parse(data['ROUNDS_JSON']);
            assert.strictEqual(rounds.length, 6);
            assert.deepStrictEqual(Object.keys(rounds[0]), ['round', 'timestamp', 'btc_block_height', 'pairs']);
            assert.deepStrictEqual(rounds[0].pairs[0], { pair: 'BTC/USD', price: '50000.00' });
            assert.strictEqual(rounds[5].btc_block_height, 799005);
        });
    });
});

describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('storage (step 5)', function () {
        it('stores the batch signature set in sigs_json, lowercased', async function () {
            const id = newIdentity();
            capable.add(id.pubkey);
            const batch = signBatch(sixRounds(), [id]);
            const body  = batchBody(batch);
            body[body.length - 2] = body[body.length - 2].toUpperCase();
            const data = v2Data();
            await handler.parse(uncompressedParams(body), data, null);
            const sigs = JSON.parse(data['SIGS_JSON']);
            assert.deepStrictEqual(sigs, [{ pubkey: batch.sigs[0].pubkey, sig: batch.sigs[0].sig }]);
        });

        it('records an INVALID batch too, rather than dropping it', async function () {
            const body = batchBody(validBatch());
            body[0] = '999';
            const data = v2Data();
            await handler.parse(uncompressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(indexer.indexerDb.createPrice.calledOnce);
            assert.ok(indexer.mapper.createMappings.calledOnce);
        });
    });
});

// -----------------------------------------------------------------------
// 6. Hub push
// -----------------------------------------------------------------------
describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('hub push (step 6)', function () {
        // THE KEY SET. The hub's pushpricebatch handler destructures exactly these names
        // and nothing in the transport validates them, so a typo fails silently at runtime
        // and no other test in either repo would catch it.
        const EXPECTED_KEYS = ['source_chain', 'first_round', 'last_round', 'btc_block_height',
                               'rounds', 'block_time', 'sigs', 'action_index', 'block_index',
                               'push_generation'];

        it('enqueues ONE price_batch payload whose key set is exactly what the hub destructures', async function () {
            const data = v2Data({ ACTION_INDEX: 77, BLOCK_INDEX: 100, BLOCK_TIME: 1755000123 });
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);

            assert.ok(indexer.indexerDb.enqueueHubPushTx.calledOnce);
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.firstCall.args[0], 'price_batch');
            const payload = indexer.indexerDb.enqueueHubPushTx.firstCall.args[1];
            assert.deepStrictEqual(Object.keys(payload).sort(), [...EXPECTED_KEYS].sort());

            assert.strictEqual(payload.source_chain, 'BTC');
            assert.strictEqual(payload.first_round, 100);
            assert.strictEqual(payload.last_round, 105);
            assert.strictEqual(payload.btc_block_height, 799005);
            assert.strictEqual(payload.block_time, 1755000123);
            assert.strictEqual(payload.action_index, 77);
            assert.strictEqual(payload.block_index, 100);
            assert.strictEqual(payload.push_generation, 0);
            assert.strictEqual(payload.rounds.length, 6);
            assert.strictEqual(payload.sigs.length, 1);
        });

        it('pushes per-round bodies under the snake-cased names the hub ingest reads', async function () {
            // receiveValidatedBatch reads r.round, r.timestamp, r.btc_block_height and
            // r.pairs; a camel-cased anchor here would arrive as NaN and refuse the batch.
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            const payload = indexer.indexerDb.enqueueHubPushTx.firstCall.args[1];
            assert.deepStrictEqual(Object.keys(payload.rounds[0]),
                ['round', 'timestamp', 'btc_block_height', 'pairs']);
            assert.deepStrictEqual(Object.keys(payload.sigs[0]), ['pubkey', 'sig']);
        });
    });
});

describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('hub push (step 6)', function () {
        it('carries block_time, which v0 has no counterpart for', async function () {
            // Batching widens the hub/chain skew to ~70 minutes, so the hub keys its
            // per-round pair-name flag day on the landing action own block time.
            const data = v2Data({ BLOCK_TIME: 1766000000 });
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.firstCall.args[1].block_time, 1766000000);
        });

        it('goes through the durable outbox and is staged, never pushed directly from parse', async function () {
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            assert.ok(!hubClient.pushPriceBatch.called, 'parse must not block on hub HTTP latency');
            const staged = indexer.indexerDb.stageHubPush.firstCall.args[0];
            assert.strictEqual(staged.id, 42);
            assert.strictEqual(staged.pushType, 'price_batch');
            assert.deepStrictEqual(staged.payload, indexer.indexerDb.enqueueHubPushTx.firstCall.args[1]);
        });
    });

    describe('hub push (step 6)', function () {
        it('pushes nothing for an invalid batch', async function () {
            const body = batchBody(validBatch());
            body[body.length - 1] = 'f'.repeat(128);   // a signature that cannot verify
            const data = v2Data();
            await handler.parse(uncompressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called);
            assert.ok(!indexer.indexerDb.stageHubPush.called);
        });

        it('pushes nothing when there is no hub client', async function () {
            hubClient = null;
            const data = v2Data();
            await newHandler().parse(uncompressedParams(batchBody(validBatch())), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called);
        });
    });
});

// -----------------------------------------------------------------------
// 8. No rewards
// -----------------------------------------------------------------------
describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('rewards', function () {

        // THE PIN for zero batch rewards. The oracle_round derivation lives inline in parseV0 and is not
        // shared code, so parseV0 simply never calls it. Without this test a later
        // refactor that hoisted the derivation into a shared helper would silently start
        // paying six rounds' worth of rewards per batch, on chain, with no failing test.
        it('writes ZERO validator_rewards rows for a valid BTC-landed batch', async function () {
            const data = v2Data({ COIN: 'BTC' });
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['COIN'], 'BTC', 'BTC is the chain v0 pays rewards on');
            assert.strictEqual(indexer.indexerDb.createValidatorReward.callCount, 0);
        });

        it('writes ZERO validator_rewards rows in the compressed form too', async function () {
            const data = v2Data({ COIN: 'BTC' });
            await handler.parse(compressedParams(batchBody(validBatch())), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.createValidatorReward.callCount, 0);
        });

        it('never reads the full-node participation the reward split needs', async function () {
            indexer.indexerDb.getFullNodeParticipation = sinon.stub().resolves({ totalEpochs: 10, sources: [] });
            const data = v2Data({ COIN: 'BTC' });
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            assert.ok(!indexer.indexerDb.getFullNodeParticipation.called);
        });
    });
});
