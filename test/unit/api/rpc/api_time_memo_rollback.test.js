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

describe('API time memo cleared on rollback @regression @tier1', function () {
    function buildDb(){
        let blockTime = 2000;
        const db = Object.assign(Object.create(Database.prototype), {
            config: { NETWORK: 'testnet', COIN: 'BTC' },
            _blockTimeCache: { block_index: null, block_time: null },
            _protocolTimeCache: { block_index: null, block_time: null },
            poolQuery(query){
                if(/SELECT block_time from blocks where block_index=\?/.test(query))
                    return Promise.resolve([{ block_time: blockTime }]);
                throw new Error('unexpected query: ' + query);
            },
        });
        db.setBlockTime = (value) => { blockTime = value; };
        return db;
    }

    it('a rollback clear drops the API view memo so a replayed height re-reads', async function () {
        const db = buildDb();
        const view = db.apiView();
        assert.strictEqual(await view.getRawBlockTime(100), 2000);
        assert.strictEqual(view._blockTimeCache.block_index, 100);

        // Reorg: the same height now carries the new chain's timestamp.
        db.setBlockTime(3000);
        db.clearBlockTimeCache();

        assert.strictEqual(await view.getRawBlockTime(100), 3000);
    });

    it('without a rollback the API view memo is retained and stays separate from the block loop memo', async function () {
        const db = buildDb();
        const view = db.apiView();
        await view.getRawBlockTime(100);
        db.setBlockTime(3000);
        assert.strictEqual(await view.getRawBlockTime(100), 2000);
        assert.deepStrictEqual(db._blockTimeCache, { block_index: null, block_time: null });
    });
});
