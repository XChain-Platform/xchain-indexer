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
// test/unit/actions/priceV2Batch.test.js
//
// PRICE v0 (parseV0): the consensus parser that decides, on every indexing
// node, whether a batch is valid.
//
// Everything here is driven through a REAL six-round batch: real Ed25519
// identities from node crypto, signatures over the real canonical from
// ed25519.buildPriceBatchPayload, and the real deflate/base64 from
// price_batch_compression.js. No hand-written canonical string appears in this
// file, because a hand-written one pins the test's idea of the canonical rather
// than the parser's.
//
// This file holds the activation-gate and decompression cases. The structural,
// straddle, batch anchor, signature, canonical, storage, hub push and reward
// cases live beside it in price_batch.test/, each opening the same
// 'Price v2 (PRICE batch) @regression @tier3' describe so every full test title
// is unchanged; price_batch.test/helpers/price_batch_harness.js holds the wire
// builders and the mock harness they share.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const zlib   = require('zlib');

const {
    batchBody, uncompressedParams, compressedParams, v2Data, newPriceHandler,
    validBatchFor, usePriceBatchHarness,
} = require('./price_batch.test/helpers/price_batch_harness.js');

const comp          = require('../../../../src/actions/price/price_batch_compression.js');

// Each test gets a fresh harness from usePriceBatchHarness; bind() hands it to
// the names the test bodies use and builds the handler they drive.
let indexer, handler, hubClient, capable;
const bind = (h) => { ({ indexer, capable, hubClient } = h); handler = newHandler(); };
const newHandler = () => newPriceHandler(indexer, hubClient);
const validBatch = () => validBatchFor(capable);

// -----------------------------------------------------------------------
// v2 is ALWAYS ON
// -----------------------------------------------------------------------
describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('no activation gate', function () {

        it('a well-formed batch is valid on its merits, whatever the block time', async function () {
            // There is no flag day and no time key: the same batch must validate at any
            // BLOCK_TIME, including none at all. A gate reintroduced here would show up as
            // one of these recording 'invalid: VERSION (unknown)'.
            const batch = validBatch();
            for (const blockTime of [0, 1, 1755000000, null, undefined]) {
                const data = v2Data({ BLOCK_TIME: blockTime });
                await newHandler().parse(uncompressedParams(batchBody(batch)), data, null);
                assert.strictEqual(data['STATUS'], 'valid', 'BLOCK_TIME ' + String(blockTime));
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
                assert.strictEqual(data['ROUND_COUNT'], 6);
            }
        });

        it('an upstream error still wins over a well-formed batch', async function () {
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, 'invalid: upstream');
            assert.strictEqual(data['STATUS'], 'invalid: upstream');
        });
    });
});

// -----------------------------------------------------------------------
// 1. Decompression
// -----------------------------------------------------------------------
describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('decompression (step 1)', function () {
        it('accepts a real six-round batch in the COMPRESSED form', async function () {
            const data = v2Data();
            await handler.parse(compressedParams(batchBody(validBatch())), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['ROUND_COUNT'], 6);
        });

        // THE form-agnostic property. Everything downstream of the inflate reads one
        // body, so the two wire forms cannot diverge in validity, in what is stored, or
        // in what is pushed. This is the case that fails the moment a fallback treats an
        // undecodable compressed field as an uncompressed body.
        it('the two wire forms produce IDENTICAL status and IDENTICAL stored rows', async function () {
            const batch = validBatch();
            const body  = batchBody(batch);

            const plain = v2Data({ ACTION_INDEX: 1 });
            await handler.parse(uncompressedParams(body), plain, null);

            const squeezed = v2Data({ ACTION_INDEX: 1 });
            await newHandler().parse(compressedParams(body), squeezed, null);

            assert.strictEqual(plain['STATUS'], 'valid');
            assert.strictEqual(plain['STATUS'], squeezed['STATUS']);
            assert.strictEqual(plain['VALIDATION_STATUS'], squeezed['VALIDATION_STATUS']);
            for(const key of ['ROUND', 'BTC_BLOCK_HEIGHT', 'BATCH_FIRST_ROUND', 'BATCH_LAST_ROUND',
                              'ROUND_COUNT', 'ROUNDS_JSON', 'SIGS_JSON', 'PAIR_COUNT',
                              'PAIRS_JSON', 'SIG_COUNT'])
                assert.deepStrictEqual(plain[key], squeezed[key], 'stored ' + key + ' must not depend on the wire form');

            // And the same for what reaches the hub.
            const plainPush    = indexer.indexerDb.stageHubPush.firstCall.args[0].payload;
            const squeezedPush = indexer.indexerDb.stageHubPush.secondCall.args[0].payload;
            assert.deepStrictEqual(plainPush, squeezedPush);
        });

        it('an INVALID batch is equally invalid in both forms, with the same status', async function () {
            // Same falsification, other direction: a form-dependent parser could reject one
            // form for a structural reason the other never reaches.
            const batch = validBatch();
            const body  = batchBody(batch);
            body[0] = String(batch.lastRound + 1);   // FIRST_ROUND > LAST_ROUND

            const plain = v2Data();
            await handler.parse(uncompressedParams(body), plain, null);
            const squeezed = v2Data();
            await newHandler().parse(compressedParams(body), squeezed, null);

            assert.strictEqual(plain['VALIDATION_STATUS'], 'invalid');
            assert.strictEqual(plain['STATUS'], squeezed['STATUS']);
        });
    });
});

describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('decompression (step 1)', function () {
        it('records the compression module reason verbatim for non-canonical base64', async function () {
            const field = comp.compressPriceBatchBody(batchBody(validBatch()).join('|'));
            // URL-safe alphabet is a DIFFERENT encoding of the same bytes: one wire, one meaning.
            const data = v2Data();
            await handler.parse(['2', 'Z', field.replace(/\+/g, '-').replace(/\//g, '_')], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: COMPRESSION (non-canonical-base64)');
        });

        it('records ratio-cap for a small zip bomb and size-cap for a large one', async function () {
            // 9,000 bytes of one repeated byte deflate to ~26, a ratio near 350:1, so the
            // RATIO cap binds first. 200,000 bytes deflate to ~212, whose ratio cap of
            // ~31,800 sits above the wire ceiling, so the SIZE cap binds.
            const bomb = n => zlib.deflateRawSync(Buffer.alloc(n, 0x41), { level: 9 }).toString('base64');

            const small = v2Data();
            await handler.parse(['2', 'Z', bomb(9000)], small, null);
            assert.strictEqual(small['STATUS'], 'invalid: COMPRESSION (ratio-cap)');

            const large = v2Data();
            await newHandler().parse(['2', 'Z', bomb(200000)], large, null);
            assert.strictEqual(large['STATUS'], 'invalid: COMPRESSION (size-cap)');
        });

        it('records inflate-failed on bytes that are canonical base64 but not a deflate stream', async function () {
            const data = v2Data();
            await handler.parse(['2', 'Z', Buffer.from('not a deflate stream at all').toString('base64')], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: COMPRESSION (inflate-failed)');
        });
    });
});

describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('decompression (step 1)', function () {
        it('records not-a-string when the marker carries no field at all', async function () {
            const data = v2Data();
            await handler.parse(['2', 'Z'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: COMPRESSION (not-a-string)');
        });

        it('NEVER falls back to reading an undecodable compressed field as an uncompressed body', async function () {
            // The fallback's signature is a STRUCTURAL status (the parser having read `Z` as
            // FIRST_ROUND) instead of a COMPRESSION one, or worse, a valid action.
            for(const field of ['!!!not base64!!!', 'QR==', '']){
                const data = v2Data();
                await newHandler().parse(['2', 'Z', field], data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
                assert.ok(data['STATUS'].startsWith('invalid: COMPRESSION ('),
                    'field ' + JSON.stringify(field) + ' must record a COMPRESSION reason, got ' + data['STATUS']);
            }
        });

        it('a compression failure stores nothing batch-shaped and pushes nothing', async function () {
            const data = v2Data();
            await handler.parse(['2', 'Z', 'QR=='], data, null);
            assert.strictEqual(data['BATCH_FIRST_ROUND'], undefined);
            assert.strictEqual(data['ROUNDS_JSON'], null);
            assert.ok(indexer.indexerDb.createPrice.calledOnce);
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called);
        });
    });
});
