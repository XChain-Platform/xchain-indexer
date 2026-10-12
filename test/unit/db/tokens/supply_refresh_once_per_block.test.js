'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC, https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const assert = require('assert');

const blockPasses  = require('../../../../src/XChainIndexer/block_passes.js');
const ledgerChecks = require('../../../../src/db/database/ledger_checks.js');
const tokenQueries = require('../../../../src/db/tokens/index.js');
const { buildStateHashData } = require('../../../../src/consensus/state_hash.js');

function tokenHarness(){
    const calls = [];
    const db = {
        util: {
            isNull: value => value === null || value === undefined || value === '',
        },
        async createTicker(tick){
            calls.push('createTicker:' + tick);
            return 7;
        },
        async doQuery(query){
            calls.push('query:' + query);
            return [];
        },
        async getTokenInfo(tick){
            calls.push('getTokenInfo:' + tick);
            return { TICK: tick, SUPPLY: '12' };
        },
        async createToken(data){
            calls.push('createToken:' + data.TICK);
        },
    };
    db.updateTokenInfo = ledgerChecks.updateTokenInfo;
    db.updateTokens = tokenQueries.updateTokens;
    return { db, calls };
}

// One block touching tick ALPHA (tick_id 7, 2 decimals) whose tokens.supply still holds
// the previous block's 10.00 while the ledger now sums to 15 - 4 + 2 = 13.00. The fake
// database keeps tokens.supply as real state: createToken (the per-action rebuild path)
// and the block refresh UPDATE both write it, and the state_hash token_supply class reads
// it back, so the preimage shows exactly which supply createBlock hashed.
function stateHashBlockHarness(){
    const tokenSupply = { 7: '10.00' };
    const preimages   = [];
    const util = {
        isNull: value => value === null || value === undefined || value === '',
        bcsub: (left, right) => String(Number(left) - Number(right)),
        bcadd: (left, right, decimals) => (Number(left) + Number(right)).toFixed(decimals),
    };
    const db = {
        util,
        async createTicker(){ return 7; },
        async getStatusId(){ return 1; },
        // The per-action path derived supply from the ledger at action time.
        async getTokenInfo(tick){ return { TICK: tick, SUPPLY: '13.00' }; },
        async createToken(data){ tokenSupply[7] = data.SUPPLY; },
        async doQuery(query, params){
            if(query.includes('DISTINCT(x.tick_id)'))
                return [{ tick_id: 7, tick: 'ALPHA', decimals: 2 }];
            if(query.includes('FROM credits m')) return [{ tick_id: 7, s: '15' }];
            if(query.includes('FROM debits m'))  return [{ tick_id: 7, s: '4' }];
            if(query.includes('FROM escrows m')) return [{ tick_id: 7, s: '2' }];
            if(query === 'UPDATE tokens SET supply=? WHERE tick_id=?'){
                tokenSupply[params[1]] = params[0];
                return { affectedRows: 1 };
            }
            if(query.includes('t.supply AS supply FROM tokens t'))
                return [{ tick: 'ALPHA', supply: tokenSupply[7] }];
            return [];
        },
        async createBlock(block_index){
            preimages.push(await buildStateHashData(db, block_index, { network: 'regtest', coin: 'BTC' }));
            return ['ledger', 'actions', 'contracts'];
        },
        async sanityCheck(){},
    };
    db.updateTokenInfo = ledgerChecks.updateTokenInfo;
    db.updateTokens    = tokenQueries.updateTokens;
    db.refreshTokenSuppliesForBlock = tokenQueries.refreshTokenSuppliesForBlock;
    const indexer = {
        actions: {},
        config: {},
        util: { async processMarketUpdates(){} },
        indexerDb: db,
    };
    return { db, indexer, preimages };
}

describe('block-scoped token supply refresh @unit @regression @tier1', function () {
    it('hashes the same token_supply state as the per-action rebuild when an action defers supply', async function () {
        const blk = { blockToParse: 501, blockTime: 1000, rawBlockTime: 999 };

        // Per-action rebuild: the action writes the end-of-block supply itself.
        const perAction = stateHashBlockHarness();
        await perAction.db.updateTokens(['ALPHA'], true);
        await blockPasses.finalizeBlock.call(perAction.indexer, blk, false);

        // Deferred: the action leaves supply to the block refresh.
        const deferred = stateHashBlockHarness();
        await deferred.db.updateTokens(['ALPHA']);
        await blockPasses.finalizeBlock.call(deferred.indexer, blk, false);

        assert.strictEqual(perAction.preimages.length, 1);
        assert.strictEqual(deferred.preimages.length, 1);
        assert.deepStrictEqual(perAction.preimages[0].token_supply, [{ tick: 'ALPHA', supply: '13.00' }]);
        assert.deepStrictEqual(deferred.preimages[0].token_supply, [{ tick: 'ALPHA', supply: '13.00' }]);
        assert.strictEqual(JSON.stringify(deferred.preimages[0]), JSON.stringify(perAction.preimages[0]));
    });

    it('runs once before the blocks row is hashed and before the sanity check', async function () {
        const calls = [];
        const updates = [];
        const indexerDb = {
            util: {
                isNull: value => value === null || value === undefined || value === '',
                bcsub: (left, right) => String(Number(left) - Number(right)),
                bcadd: (left, right, decimals) => (Number(left) + Number(right)).toFixed(decimals),
            },
            async createBlock(){
                calls.push('block');
                return ['ledger', 'actions', 'contracts'];
            },
            async doQuery(query, params){
                if(query.includes('DISTINCT(x.tick_id)')){
                    calls.push('refresh:touched');
                    assert.deepStrictEqual(params, [501, 501, 501]);
                    return [{ tick_id: 7, tick: 'ALPHA', decimals: 2 }];
                }
                if(query.includes('FROM credits m')){
                    calls.push('refresh:credits');
                    return [{ tick_id: 7, s: '15' }];
                }
                if(query.includes('FROM debits m')){
                    calls.push('refresh:debits');
                    return [{ tick_id: 7, s: '4' }];
                }
                if(query.includes('FROM escrows m')){
                    calls.push('refresh:escrows');
                    return [{ tick_id: 7, s: '2' }];
                }
                if(query === 'UPDATE tokens SET supply=? WHERE tick_id=?'){
                    calls.push('refresh:update');
                    updates.push(params);
                    return { affectedRows: 1 };
                }
                assert.fail('Unexpected query: ' + query);
            },
            async sanityCheck(block){ calls.push('sanity:' + block); },
        };
        indexerDb.refreshTokenSuppliesForBlock = tokenQueries.refreshTokenSuppliesForBlock;
        const indexer = {
            actions: {},
            config: {},
            util: {
                async processMarketUpdates(){ calls.push('markets'); },
            },
            indexerDb,
        };

        const result = await blockPasses.finalizeBlock.call(indexer, {
            blockToParse: 501,
            blockTime: 1000,
            rawBlockTime: 999,
        }, false);

        assert.deepStrictEqual(result, ['ledger', 'actions', 'contracts']);
        assert.deepStrictEqual(calls, [
            'refresh:touched',
            'refresh:credits',
            'refresh:debits',
            'refresh:escrows',
            'refresh:update',
            'block',
            'markets',
            'sanity:501',
        ]);
        assert.deepStrictEqual(updates, [['13.00', 7]]);
    });

    it('does not reconstruct full supply during ordinary forward updates', async function () {
        const { db, calls } = tokenHarness();

        await db.updateTokens(['ALPHA']);

        assert.deepStrictEqual(calls.filter(call => call.startsWith('getTokenInfo:')), []);
        assert.deepStrictEqual(calls.filter(call => call.startsWith('createToken:')), []);
        assert.strictEqual(calls.filter(call => /\bSUM\s*\(/i.test(call)).length, 0);
    });

    it('rebuilds token information immediately during rollback updates', async function () {
        const { db, calls } = tokenHarness();

        await db.updateTokens(['ALPHA'], true);

        assert.strictEqual(calls.filter(call => call === 'getTokenInfo:ALPHA').length, 1);
        assert.strictEqual(calls.filter(call => call === 'createToken:ALPHA').length, 1);
    });
});
