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
// test/unit/price/price_batch_param_length.test.js
//
// Strict parameter length for the PRICE batch wire. Neither the structural
// checks nor the signature check ever look at whether the field list was
// consumed to its end, so a wire carrying junk appended after the last
// signature parsed exactly like the same batch without it and landed the same
// row under the same EQUIV key. Two byte-distinct spellings of one batch under
// one equiv key is precisely the shape equivocation reasoning depends on being
// impossible, so a wire with anything left over after the declared SIG_COUNT
// signatures must be refused, in both wire forms.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const {
    batchBody, uncompressedParams, compressedParams, v2Data,
    newPriceHandler, validBatchFor, usePriceBatchHarness,
} = require('../actions/price/price_batch.test/helpers/price_batch_harness.js');

let indexer, handler, hubClient, capable;
const bind = (h) => { ({ indexer, capable, hubClient } = h); handler = newHandler(); };
const newHandler = () => newPriceHandler(indexer, hubClient);
const validBatch = () => validBatchFor(capable);

describe('Price v2 (PRICE batch) @regression @tier3', function () {
    usePriceBatchHarness(bind);

    describe('strict parameter length', function () {

        it('a well-formed batch with nothing left over still parses valid', async function () {
            const data = v2Data();
            await handler.parse(uncompressedParams(batchBody(validBatch())), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.called, true);
        });

        it('rejects a batch wire with one junk field appended after the last signature', async function () {
            const body   = batchBody(validBatch()).concat(['JUNK']);
            const data   = v2Data();
            await handler.parse(uncompressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(/^invalid: /.test(data['STATUS']), data['STATUS']);
            assert.ok(data['STATUS'].includes('trailing'), data['STATUS']);
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.called, false,
                'a batch refused for trailing data must never reach the hub push outbox');
        });

        it('rejects a batch wire with several junk fields appended after the last signature', async function () {
            const body = batchBody(validBatch()).concat(['JUNK1', 'JUNK2', 'JUNK3']);
            const data = v2Data();
            await newHandler().parse(uncompressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes('trailing'), data['STATUS']);
        });

        it('rejects a bare trailing empty field, the shape a stray trailing "|" on the wire produces', async function () {
            const body = batchBody(validBatch()).concat(['']);
            const data = v2Data();
            await newHandler().parse(uncompressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes('trailing'), data['STATUS']);
        });

        it('rejects the SAME junk in the COMPRESSED wire form, so compression cannot cheapen the second spelling', async function () {
            const body = batchBody(validBatch()).concat(['JUNK']);
            const data = v2Data();
            await newHandler().parse(compressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(data['STATUS'].includes('trailing'), data['STATUS']);
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.called, false);
        });

        it('the clean batch in the COMPRESSED wire form is unaffected: the guard needs no lookahead over the marker', async function () {
            const data = v2Data();
            await newHandler().parse(compressedParams(batchBody(validBatch())), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
        });

        it('a batch missing its final field (short, not long) still invalidates as it always has', async function () {
            const body = batchBody(validBatch());
            body.pop();
            const data = v2Data();
            await newHandler().parse(uncompressedParams(body), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        });
    });
});
