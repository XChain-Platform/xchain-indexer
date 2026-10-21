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
 * test/unit/db/vm_snapshot/cross_block_cache_wiring.test.js
 */

'use strict';

const assert = require('assert');

const blocks = require('../../../../src/db/blocks/index.js');
const flips  = require('../../../../src/db/rollback/in_place_flips.js');

function beginPass(db, blockIndex){
    db.blockIndex = blockIndex;
    db._vmSnapshotMemo = new Map();
}

function makeDb(){
    let terminal = true;
    const queries = [];
    const db = Object.assign({}, blocks, {
        async doQuery(sql, params){
            queries.push({ sql: String(sql), params });
            if(String(sql).includes('FROM cross_chain_settlements'))
                return [];
            if(String(sql).includes('FROM xcalls'))
                return terminal
                    ? [{ call_id: 'call-1', result_status: 'ok', result_payload: 'done' }]
                    : [];
            if(String(sql).includes('UPDATE xcalls')){
                terminal = false;
                return [];
            }
            throw new Error('unexpected query: ' + sql);
        }
    });
    return { db, queries };
}

describe('cross-chain VM snapshot cross-block cache wiring @regression @tier1', function () {
    it('serves getCrossChainDataForVM from the cross-block cache in a later pass', async function () {
        const { db, queries } = makeDb();
        beginPass(db, 20);
        const first = await db.getCrossChainDataForVM(15);

        beginPass(db, 21);
        const second = await db.getCrossChainDataForVM(15);

        assert.strictEqual(second, first);
        assert.strictEqual(queries.length, 2);
    });

    it('rebuilds getCrossChainDataForVM after rollback resets in-place flips', async function () {
        const { db, queries } = makeDb();
        beginPass(db, 20);
        const before = await db.getCrossChainDataForVM(20);
        assert.deepStrictEqual(before.calls['call-1'], { status: 'ok', payload: 'done' });

        await flips.resetOrphanedXcallRequests(db, 18);
        beginPass(db, 20);
        const after = await db.getCrossChainDataForVM(20);

        assert.notStrictEqual(after, before);
        assert.deepStrictEqual(after.calls, {});
        assert.strictEqual(queries.filter((q) => q.sql.includes('FROM ')).length, 4);
        const reset = queries.find((q) => q.sql.includes('UPDATE xcalls'));
        assert.deepStrictEqual(reset.params, [18]);
    });
});
