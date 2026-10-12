/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The price_landing_clear field of getlatestblock.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const observability = require('../../../../src/observability/index.js');
const { buildSystemRpc } = require('../../../../src/api/rpc/system.js');
const { recordingView, fakeIndexer } = require('./helpers/fake_indexer.js');

function rpcFor({ delivered, firstPrice, decoderTip, getBlockTime, scanFn }) {
    const view = recordingView({
        getLatestBlockIndex: 105,
        getHubPushDeliveryFrontier: { undelivered: 1, min_block: delivered + 1, unresolved: 0 },
        getBlockTime: (b) => 1000 + b,
    });
    const decoderView = recordingView({
        getFirstPriceBlockAfter: scanFn || (() => firstPrice),
        getBlockTime: getBlockTime || ((b) => 2000 + b),
    });
    const indexer = fakeIndexer({ view, decoderView, lastDecoderBlock: decoderTip });
    return { rpc: buildSystemRpc({ indexer, liveness: {} }), decoderView };
}

describe('getlatestblock price_landing_clear @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('stops short of the first PRICE block above the delivered frontier', async function () {
        const { rpc, decoderView } = rpcFor({ delivered: 100, firstPrice: 104, decoderTip: 110 });
        const res = await rpc.getlatestblock();
        assert.deepStrictEqual(res.price_landing_clear, { block: 103, protocol_time: 2103 });
        assert.deepStrictEqual(decoderView.calls[0], ['getFirstPriceBlockAfter', 100, 110]);
    });

    it('reports the decoder tip when no PRICE block lies above the frontier', async function () {
        const { rpc } = rpcFor({ delivered: 100, firstPrice: null, decoderTip: 110 });
        assert.deepStrictEqual((await rpc.getlatestblock()).price_landing_clear, { block: 110, protocol_time: 2110 });
    });

    it('is null while the decoder tip is unknown', async function () {
        const { rpc } = rpcFor({ delivered: 100, firstPrice: null, decoderTip: null });
        assert.strictEqual((await rpc.getlatestblock()).price_landing_clear, null);
    });

    it('is null when the delivered frontier is unknown', async function () {
        const view = recordingView({
            getLatestBlockIndex: 105,
            getHubPushDeliveryFrontier: { undelivered: 1, min_block: null, unresolved: 0 },
        });
        const rpc = buildSystemRpc({ indexer: fakeIndexer({ view, lastDecoderBlock: 110 }), liveness: {} });
        assert.strictEqual((await rpc.getlatestblock()).price_landing_clear, null);
    });

    it('is null and logged when the scan fails, leaving the rest of the answer intact', async function () {
        const error = sinon.stub(observability.getLogger(), 'error');
        const { rpc } = rpcFor({ delivered: 100, decoderTip: 110, scanFn: () => { throw new Error('gone'); } });
        const res = await rpc.getlatestblock();
        assert.strictEqual(res.price_landing_clear, null);
        assert.strictEqual(res.block_index, 105);
        assert.ok(error.calledOnce);
    });

    it('is null when the clear block has no protocol time', async function () {
        const { rpc } = rpcFor({ delivered: 100, firstPrice: null, decoderTip: 110, getBlockTime: () => false });
        assert.strictEqual((await rpc.getlatestblock()).price_landing_clear, null);
    });
});
