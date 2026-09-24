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

const Database = require('../../../../src/db');
const { buildFeesRpc } = require('../../../../src/api/rpc/fees.js');

function deferred(){
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

describe('API time memo isolation @regression @tier1', function () {
    it('a deferred fee tip read cannot refill block-loop memos after a reorg clear', async function () {
        const mtpStarted = deferred();
        const mtpRows = deferred();
        const emptyMemo = { block_index: null, block_time: null };
        let quoteDb;

        const db = Object.assign(Object.create(Database.prototype), {
            config: { NETWORK: 'testnet', COIN: 'BTC' },
            _blockTimeCache: { ...emptyMemo },
            _protocolTimeCache: { ...emptyMemo },
            getLatestBlockIndex: async () => 100,
            doQueryStrict(query, args){ return this.poolQuery(query, args); },
            poolQuery(query){
                if(/WHERE block_index < \?/.test(query)){
                    mtpStarted.resolve();
                    return mtpRows.promise;
                }
                if(/SELECT block_time from blocks where block_index=\?/.test(query))
                    return Promise.resolve([{ block_time: 2000 }]);
                throw new Error('unexpected query: ' + query);
            },
        });
        const util = {
            quoteOracleFee: async (blockTime, fields, quoteView) => {
                quoteDb = quoteView;
                return { valid: true, expectedFee: '0.5', belowDust: false };
            },
            bcformat: (value, decimals) => Number(value).toFixed(decimals),
            bcmul: (left, right) => String(Number(left) * Number(right)),
        };
        const rpc = buildFeesRpc({ indexer: { indexerDb: db, util, config: db.config }, ENABLE_DRYRUN: false });

        const pending = rpc.oraclefeequote({
            oracleAddress: 'oracle', giveTick: 'TICK', fiatCode: 'USD', giveEscrow: '10'
        });
        await mtpStarted.promise;
        db.clearBlockTimeCache();
        mtpRows.resolve([{ block_time: 1000 }, { block_time: 1100 }, { block_time: 1200 }]);

        const result = await pending;
        const view = db.apiView();
        assert.strictEqual(result.blockTime, 1100);
        assert.deepStrictEqual(db._blockTimeCache, emptyMemo);
        assert.deepStrictEqual(db._protocolTimeCache, emptyMemo);
        assert.deepStrictEqual(view._blockTimeCache, { block_index: 100, block_time: 2000 });
        assert.deepStrictEqual(view._protocolTimeCache, { block_index: 100, block_time: 1100 });
        assert.strictEqual(quoteDb, view);
    });
});
