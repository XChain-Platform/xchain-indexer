// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const gateRegistry = require('../../../src/consensus/gate_registry');
const {
    batchBody, compressedParams, uncompressedParams, v2Data, newPriceHandler,
    validBatchFor, usePriceBatchHarness,
} = require('../actions/price/price_batch.test/helpers/price_batch_harness.js');

const PRICE_WIRE_TRAILING_KEY = 'price_wire_trailing_activation.PRICE_WIRE_TRAILING_ACTIVATION';

let indexer, handler, hubClient, capable;
const bind = (h) => { ({ indexer, capable, hubClient } = h); handler = newPriceHandler(indexer, hubClient); };
const validBatch = () => validBatchFor(capable);

async function parsed(params, overrides = {}, upstreamError = null){
    const data = v2Data(overrides);
    await handler.parse(params, data, upstreamError);
    return data;
}

describe('PRICE compressed-wire trailing fields @regression @tier3', function () {
    usePriceBatchHarness(bind);

    it('rejects every field after the Z payload once the gate is active', async function () {
        const body = batchBody(validBatch());
        for(const tail of [['JUNK'], ['JUNK1', 'JUNK2'], ['']]){
            const data = await parsed(compressedParams(body).concat(tail));
            assert.strictEqual(data['STATUS'], 'invalid: trailing data after compressed batch payload');
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        }
        assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.called, false);
    });

    it('keeps the historical accepted verdict while the gate is inactive', async function () {
        sinon.stub(gateRegistry, 'activeAt').withArgs(PRICE_WIRE_TRAILING_KEY).returns(false);
        const data = await parsed(compressedParams(batchBody(validBatch())).concat(['JUNK']));
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
        assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.calledOnce, true);
    });

    it('keys the gate on the action landing chain and height', async function () {
        const realActiveAt = gateRegistry.activeAt.bind(gateRegistry);
        const gate = sinon.stub(gateRegistry, 'activeAt').callsFake((key, network, coin, height, time) => {
            if(key === PRICE_WIRE_TRAILING_KEY) return height >= 500;
            return realActiveAt(key, network, coin, height, time);
        });
        const params = compressedParams(batchBody(validBatch())).concat(['JUNK']);

        const below = await parsed(params, { BLOCK_INDEX: 499 });
        assert.strictEqual(below['STATUS'], 'valid');
        const at = await parsed(params, { BLOCK_INDEX: 500 });
        assert.strictEqual(at['STATUS'], 'invalid: trailing data after compressed batch payload');
        assert.ok(gate.calledWith(PRICE_WIRE_TRAILING_KEY, 'regtest', 'BTC', 499, null));
        assert.ok(gate.calledWith(PRICE_WIRE_TRAILING_KEY, 'regtest', 'BTC', 500, null));
    });

    it('leaves canonical compressed and all uncompressed framing to their existing rules', async function () {
        const gate = sinon.spy(gateRegistry, 'activeAt');
        const body = batchBody(validBatch());
        const compressed = await parsed(compressedParams(body));
        assert.strictEqual(compressed['STATUS'], 'valid');
        const plain = await parsed(uncompressedParams(body));
        assert.strictEqual(plain['STATUS'], 'valid');
        assert.strictEqual(gate.calledWith(PRICE_WIRE_TRAILING_KEY), false);
    });

    it('preserves an earlier compression or upstream error', async function () {
        const badDeflate = Buffer.from('not a deflate stream at all').toString('base64');
        const malformed = await parsed(['2', 'Z', badDeflate, 'JUNK']);
        assert.strictEqual(malformed['STATUS'], 'invalid: COMPRESSION (inflate-failed)');
        const upstream = await parsed(compressedParams(batchBody(validBatch())).concat(['JUNK']), {},
            'invalid: upstream');
        assert.strictEqual(upstream['STATUS'], 'invalid: upstream');
    });
});
