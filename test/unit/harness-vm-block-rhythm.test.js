'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// The integration harness (test/integration/setup/indexer-launcher.js) exists to
// run the REAL block loop against real databases, so a scenario that passes there
// is evidence about the fleet. That evidence is only as good as the harness's
// fidelity to XChainIndexer.start(): every pass the production loop runs and the
// harness skips is a difference the scenarios cannot see.
//
// The per-block VM compilation cache is one such pass. Production installs it
// (vm.beginBlock) as the first statement inside the block's transaction and clears
// it (vm.endBlock) immediately before createBlock. The harness omitted both, so
// vm._blockCache stayed null for an entire run and every VM-touching scenario
// executed contracts cold, on a rhythm the fleet never runs. This test pins the
// rhythm into the harness itself, driving processBlocks over a stub indexer that
// records the call order.

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { processBlocks } = require('../integration/setup/indexer-launcher.js');

const LAUNCHER = path.join(__dirname, '../integration/setup/indexer-launcher.js');
const PRODUCTION = path.join(__dirname, '../../src/XChainIndexer.js');

// A stub indexer exposing exactly the surface processBlocks touches. Every call
// that matters to block rhythm appends to `calls`, so the assertions read as the
// sequence the fleet runs rather than as counts.
function makeStubIndexer(opts = {}){
    const calls = [];
    const firstBlock = opts.firstBlock || 100;
    const lastBlock  = opts.lastBlock  || 102;
    const vm = opts.noVm ? null : {
        beginBlock(){ calls.push('vm.beginBlock'); },
        endBlock(){   calls.push('vm.endBlock');   }
    };
    const indexer = {
        calls,
        vmRef: vm,
        config: { GENESIS_BLOCK: -1 },
        synced: false,
        actions: {
            vm,
            async processTransaction(){ calls.push('processTransaction'); }
        },
        genesis: { async inject(){ calls.push('genesis.inject'); } },
        rollback: { async rollback(){ calls.push('rollback'); } },
        protocolChanges: { async isEnabled(){ return true; } },
        util: {
            logError(){},
            async processExpirations(){          calls.push('processExpirations'); },
            async processCrossChainSettlements(){ calls.push('processCrossChainSettlements'); },
            async processCancellations(){        calls.push('processCancellations'); },
            async processMarketUpdates(){        calls.push('processMarketUpdates'); }
        },
        decoderDb: {
            async getReorgsSince(){ return []; },
            async getBlockIndex(which, pos){
                return pos === 'last' ? lastBlock : firstBlock;
            },
            async getDecoderBlockData(block){
                return [{ tx_hash: 'tx' + block, data: 'SEND|X' }];
            },
            async getBlockTime(){ return 1700000000; }
        },
        indexerDb: {
            blockIndex: null,
            async getLastProcessedReorgId(){ return 0; },
            async getBlockIndex(){ return opts.lastIndexerBlock === undefined ? null : opts.lastIndexerBlock; },
            async beginTransaction(){  calls.push('beginTransaction'); },
            async commitTransaction(){ calls.push('commitTransaction'); },
            async rollbackTransaction(){ calls.push('rollbackTransaction'); },
            async createBlock(){ calls.push('createBlock'); if(opts.throwInCreateBlock) throw new Error('boom'); },
            async sanityCheck(){ calls.push('sanityCheck'); }
        }
    };
    return indexer;
}

describe('integration harness VM block rhythm', function(){

    it('installs and clears the per-block compilation cache once per block', async function(){
        // The indexer DB is empty, so processing starts at the first decoder block:
        // blocks 100 and 101 both run.
        const indexer = makeStubIndexer({ firstBlock: 100, lastBlock: 101 });
        const processed = await processBlocks(indexer);
        assert.strictEqual(processed, 2, 'two blocks should be processed');

        const begins = indexer.calls.filter(c => c === 'vm.beginBlock').length;
        const ends   = indexer.calls.filter(c => c === 'vm.endBlock').length;
        assert.strictEqual(begins, 2, 'vm.beginBlock must run once per block');
        assert.strictEqual(ends,   2, 'vm.endBlock must run once per block');
    });

    it('orders the cache exactly as production does within each block', async function(){
        const indexer = makeStubIndexer({ firstBlock: 101, lastBlock: 101 });
        await processBlocks(indexer);

        // One block only, so the recorded sequence IS the per-block order.
        assert.deepStrictEqual(indexer.calls, [
            'beginTransaction',
            'vm.beginBlock',
            'processTransaction',
            'processExpirations',
            'processCrossChainSettlements',
            'processCancellations',
            'vm.endBlock',
            'createBlock',
            'processMarketUpdates',
            'sanityCheck',
            'commitTransaction'
        ]);
    });

    it('leaves no cache installed across a block boundary', async function(){
        const indexer = makeStubIndexer({ firstBlock: 100, lastBlock: 101 });
        await processBlocks(indexer);

        // Between the two blocks the sequence must read ...endBlock ... beginBlock,
        // never two beginBlocks in a row (a cache surviving into the next block is
        // exactly the drift this rhythm exists to prevent).
        const rhythm = indexer.calls.filter(c => c === 'vm.beginBlock' || c === 'vm.endBlock');
        assert.deepStrictEqual(rhythm, ['vm.beginBlock', 'vm.endBlock', 'vm.beginBlock', 'vm.endBlock']);
    });

    it('does not clear the cache when the block throws, matching production', async function(){
        // Production's endBlock sits inside the try, after the last VM-touching pass;
        // a block that throws before it rolls back and the NEXT block's beginBlock
        // installs a fresh cache. The harness must fail the same way.
        const indexer = makeStubIndexer({ firstBlock: 101, lastBlock: 101, throwInCreateBlock: true });
        await assert.rejects(() => processBlocks(indexer), /boom/);
        assert.ok(indexer.calls.includes('rollbackTransaction'), 'the block must roll back');
        assert.strictEqual(indexer.calls.filter(c => c === 'vm.beginBlock').length, 1);
        assert.strictEqual(indexer.calls.filter(c => c === 'vm.endBlock').length, 1,
            'endBlock precedes createBlock, so it still ran before the throw');
    });

    it('is a no-op when the VM runtime is unavailable', async function(){
        // xchain-vm is optional (it fails to load on macOS/off-pin Node), and
        // actions.vm is null then. The harness must not throw on that path.
        const indexer = makeStubIndexer({ firstBlock: 101, lastBlock: 101, noVm: true });
        const processed = await processBlocks(indexer);
        assert.strictEqual(processed, 1);
        assert.ok(!indexer.calls.some(c => c.startsWith('vm.')), 'no VM calls without a VM');
    });

    it('production still calls both hooks, so the harness mirrors a live rhythm', function(){
        // If XChainIndexer ever drops or renames these calls, the harness's mirror
        // becomes fiction. Guard the production side of the pair too.
        const prod = fs.readFileSync(PRODUCTION, 'utf8');
        assert.ok(/this\.actions\.vm\.beginBlock\(\)/.test(prod),
            'XChainIndexer.js must call this.actions.vm.beginBlock()');
        assert.ok(/this\.actions\.vm\.endBlock\(\)/.test(prod),
            'XChainIndexer.js must call this.actions.vm.endBlock()');

        const harness = fs.readFileSync(LAUNCHER, 'utf8');
        assert.ok(/indexer\.actions\.vm\.beginBlock\(\)/.test(harness));
        assert.ok(/indexer\.actions\.vm\.endBlock\(\)/.test(harness));
    });

});
