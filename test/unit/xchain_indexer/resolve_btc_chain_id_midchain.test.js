/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Unit: XChainIndexer.resolveBtcChainId() on a mid-chain decoder
 ********************************************************************/

'use strict';

const assert = require('assert');
const probes = require('../../../src/XChainIndexer/decoder_probes.js');

const BLOCK_ONE_HASH = '1a'.repeat(32);
const FIRST_HASH     = 'f0'.repeat(32);

function asyncStub(implementation){
    const fn = async function (...args){
        fn.calls.push(args);
        return await implementation(...args);
    };
    fn.calls = [];
    return fn;
}

function subject(blockHash, firstBlock){
    return {
        btcChainId: null,
        config: { COIN: 'BTC' },
        decoderDb: {
            getDecoderBlockHash: asyncStub(async (height) => blockHash[height] || null),
            getBlockIndex:       asyncStub(async () => firstBlock)
        },
        hubDbSync: { setExpectedBtcChainId: asyncStub(async () => true) }
    };
}

describe('XChainIndexer.resolveBtcChainId mid-chain @regression @tier2', function () {

    it('uses the first retained block when the decoder starts above block 1', async function () {
        const originalLog = console.log;
        const logs = [];
        console.log = (...args) => logs.push(args);
        const indexer = subject({ 149700: FIRST_HASH }, 149700);
        try {
            assert.strictEqual(await probes.resolveBtcChainId.call(indexer), FIRST_HASH);
            assert.deepStrictEqual(indexer.decoderDb.getDecoderBlockHash.calls.map((call) => call[0]), [1, 149700]);
            assert.deepStrictEqual(indexer.decoderDb.getBlockIndex.calls[0], ['decoder', 'first']);
            assert.deepStrictEqual(indexer.hubDbSync.setExpectedBtcChainId.calls[0], [FIRST_HASH, 'local']);
            assert.ok(logs.some((args) => args[0] === 'Chain identity  : BTC block 149700 is ' + FIRST_HASH +
                ' (stamped on this hub\'s cross-chain rows)'));

            assert.strictEqual(await probes.resolveBtcChainId.call(indexer), FIRST_HASH);
            assert.strictEqual(indexer.decoderDb.getDecoderBlockHash.calls.length, 2,
                'the resolved identity is memoized');
        } finally {
            console.log = originalLog;
        }
    });

    it('keeps block 1 as the identity when the decoder retains it', async function () {
        const originalLog = console.log;
        console.log = () => {};
        const indexer = subject({ 1: BLOCK_ONE_HASH }, 0);
        try {
            assert.strictEqual(await probes.resolveBtcChainId.call(indexer), BLOCK_ONE_HASH);
            assert.strictEqual(indexer.decoderDb.getBlockIndex.calls.length, 0);
            assert.deepStrictEqual(indexer.decoderDb.getDecoderBlockHash.calls[0], [1]);
        } finally {
            console.log = originalLog;
        }
    });

    it('waits for block 1 instead of identifying a fresh chain by its shared block 0', async function () {
        const indexer = subject({}, 0);

        assert.strictEqual(await probes.resolveBtcChainId.call(indexer), null);
        assert.strictEqual(indexer.decoderDb.getDecoderBlockHash.calls.length, 1);
        assert.strictEqual(indexer.hubDbSync.setExpectedBtcChainId.calls.length, 0);
    });
});
