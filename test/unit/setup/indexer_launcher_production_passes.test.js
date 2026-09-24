'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC, https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// The integration launcher applies each block through production's own pass
// sequence. Every replay tool and scenario built on it is evidence about the fleet
// only while that holds: a pass the launcher skips is a table its replays never
// read, and a replay witness over rows in that table compares nothing. These tests
// drive processBlocks and production's runBlockPasses over identical recording
// indexers and require the two traces to be the same call for call.

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const launcher      = require('../../integration/setup/indexer-launcher.js');
const gasSeeder     = require('../../integration/setup/gas-seeder.js');
const blockPasses   = require('../../../src/XChainIndexer/block_passes.js');
const { BLOCK_TIME, RAW_BLOCK_TIME, recordingIndexer } = require('./recording_indexer.js');

// The block as production applies it once processBlock has read its inputs: open the
// transaction, run the passes, commit.
async function productionBlock(ix, block) {
    const blk = { blockToParse: block, blockTime: BLOCK_TIME, rawBlockTime: RAW_BLOCK_TIME,
                  blockTransactions: [{ tx_hash: 'tx' + block, data: 'SEND|X' }] };
    const stateCommitActive = await ix.openBlockTransaction(block);
    await ix.runBlockPasses(blk, stateCommitActive);
    await ix.indexerDb.commitTransaction();
}

// The launcher reads its reorg cursor and block positions before the block opens;
// production reads those in its own loop. Compare from the block's transaction on.
function fromBlockOpen(trace) {
    return trace.slice(trace.indexOf('db.beginTransaction'));
}

describe('integration launcher: each block runs production\'s pass sequence', function () {
    afterEach(function () { gasSeeder.clearSystemGas(); });

    it('applies a block call for call as production\'s runBlockPasses does', async function () {
        const harness = recordingIndexer({ firstBlock: 101, recordCreateBlockArgs: true });
        assert.strictEqual(await launcher.processBlocks(harness), 1);

        const prod = recordingIndexer({ firstBlock: 101, recordCreateBlockArgs: true });
        await productionBlock(prod, 101);

        const got = fromBlockOpen(harness.trace);
        const want = fromBlockOpen(prod.trace);
        assert.ok(want.length > 10, 'production recorded a real sequence: ' + JSON.stringify(want));
        assert.deepStrictEqual(got, want);
    });

    it('reaches the cross-chain calls and ATTEST response passes, in production\'s position', async function () {
        const harness = recordingIndexer({ firstBlock: 101, recordCreateBlockArgs: true });
        await launcher.processBlocks(harness);
        const t = harness.trace;
        const at = (name) => {
            const i = t.indexOf(name);
            assert.ok(i >= 0, name + ' never ran: ' + JSON.stringify(t));
            return i;
        };
        assert.ok(at('util.processCrossChainSettlements') < at('util.processCrossChainCalls'));
        assert.ok(at('util.processCrossChainCalls') < at('util.processAttestationResponses'));
        assert.ok(at('util.processAttestationResponses') < at('util.processCancellations'));
        assert.ok(at('util.processBetPasses') < at('util.processCrossChainSettlements'));
        assert.ok(at('util.processCancellations') < at('util.processAttestationExpirations'));
        assert.ok(at('vm.endBlock') < at('createBlock@101/' + RAW_BLOCK_TIME),
            'the blocks row carries the chain\'s own stamp, after the VM cache closes');
        assert.ok(at('db.sanityCheck') < at('db.commitTransaction'));
    });

    it('reports the pass groups it ran, in production\'s call order', async function () {
        const harness = recordingIndexer({ firstBlock: 101, recordCreateBlockArgs: true });
        assert.deepStrictEqual(launcher.passesRun(harness), [], 'nothing has run before processBlocks');
        await launcher.processBlocks(harness);
        assert.deepStrictEqual(launcher.passesRun(harness), launcher.PASS_GROUPS);

        const called = [];
        const re = /this\.(run[A-Z]\w*Passes)\(/g;
        const src = blockPasses.runBlockPasses.toString();
        let m;
        while ((m = re.exec(src)) !== null) called.push(m[1]);
        assert.deepStrictEqual(launcher.PASS_GROUPS, called, 'the groups the launcher records are the ones runBlockPasses calls');
    });

    it('seeds gas after the settlement group and before the cross-chain group', async function () {
        gasSeeder.registerSystemGas(101, { addresses: ['mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ'], amount: '100' });
        const harness = recordingIndexer({ firstBlock: 101, recordCreateBlockArgs: true });
        await launcher.processBlocks(harness);
        const t = harness.trace;
        const seed = t.indexOf('genesis.injectProtocolToken');
        assert.ok(seed >= 0, 'the gas fixture never ran');
        assert.ok(t.indexOf('util.processCrossChainSettlements') < seed);
        assert.ok(seed < t.indexOf('util.processCrossChainCalls'));
    });

    it('installs and clears the VM compilation cache once per block, never across a boundary', async function () {
        const harness = recordingIndexer({ firstBlock: 102, recordCreateBlockArgs: true });
        harness.decoderDb.getBlockIndex = async (which, pos) => (pos === 'last' ? 102 : 101);
        assert.strictEqual(await launcher.processBlocks(harness), 2);
        const rhythm = harness.trace.filter((c) => c === 'vm.beginBlock' || c === 'vm.endBlock' || c.startsWith('createBlock@'));
        assert.deepStrictEqual(rhythm, ['vm.beginBlock', 'vm.endBlock', 'createBlock@101/' + RAW_BLOCK_TIME,
                                        'vm.beginBlock', 'vm.endBlock', 'createBlock@102/' + RAW_BLOCK_TIME]);
    });

    it('rolls the block back and rethrows when a pass throws, with the cache already closed', async function () {
        const harness = recordingIndexer({ firstBlock: 101, recordCreateBlockArgs: true,
            throwInCreateBlock: true, createBlockError: () => 'boom' });
        await assert.rejects(() => launcher.processBlocks(harness), /boom/);
        assert.ok(harness.trace.includes('db.rollbackTransaction'));
        assert.ok(!harness.trace.includes('db.commitTransaction'));
        assert.deepStrictEqual(harness.trace.filter((c) => c.startsWith('vm.')), ['vm.beginBlock', 'vm.endBlock'],
            'endBlock precedes createBlock, so it ran before the throw, as in production');
    });

    it('runs without a VM runtime, as production does', async function () {
        const harness = recordingIndexer({ firstBlock: 101, recordCreateBlockArgs: true, noVm: true });
        assert.strictEqual(await launcher.processBlocks(harness), 1);
        assert.ok(!harness.trace.some((c) => c.startsWith('vm.')));
    });
});
