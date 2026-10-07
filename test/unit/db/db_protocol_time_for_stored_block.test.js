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
 **********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const blockReads = require('../../../src/db/database/block_reads.js');

function makeReader(network, raw = 1000, previous = [900, 800, 700]) {
    return {
        config: { NETWORK: network },
        _protocolTimeCache: { block_index: 50, block_time: 999 },
        getRawBlockTime: sinon.stub().resolves(raw),
        getPreviousBlockTimes: sinon.stub().resolves(previous),
    };
}

describe('protocolTimeForStoredBlock()', function () {

    afterEach(() => sinon.restore());

    it('returns testnet median time past without consulting or replacing the protocol memo', async function () {
        const reader = makeReader('testnet');
        const memo = reader._protocolTimeCache;

        assert.strictEqual(await blockReads.protocolTimeForStoredBlock.call(reader, 10), 800);
        assert.strictEqual(reader._protocolTimeCache, memo);
        assert.deepStrictEqual(reader._protocolTimeCache, { block_index: 50, block_time: 999 });
        sinon.assert.calledOnceWithExactly(reader.getRawBlockTime, 10);
        sinon.assert.calledOnceWithExactly(reader.getPreviousBlockTimes, 10, 11);
    });

    it('caps testnet median time past at the raw block timestamp', async function () {
        const reader = makeReader('testnet', 750);

        assert.strictEqual(await blockReads.protocolTimeForStoredBlock.call(reader, 10), 750);
    });

    it('returns the raw timestamp on mainnet without reading the previous window', async function () {
        const reader = makeReader('mainnet');

        assert.strictEqual(await blockReads.protocolTimeForStoredBlock.call(reader, 10), 1000);
        sinon.assert.notCalled(reader.getPreviousBlockTimes);
    });

    it('preserves an unresolvable block sentinel without reading the previous window', async function () {
        const reader = makeReader('testnet', false);

        assert.strictEqual(await blockReads.protocolTimeForStoredBlock.call(reader, 10), false);
        sinon.assert.notCalled(reader.getPreviousBlockTimes);
        assert.deepStrictEqual(reader._protocolTimeCache, { block_index: 50, block_time: 999 });
    });
});
