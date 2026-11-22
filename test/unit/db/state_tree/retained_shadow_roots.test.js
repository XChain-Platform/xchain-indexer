/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * Unit: retained state subtree root coverage
 */

'use strict';

const assert = require('assert');

const stateTree = require('../../../../src/db/state_tree/index.js');
const orphanStats = require('../../../../src/db/subtree/orphan_stats_reads.js');

const EXPECTED = [
    'balances_root',
    'stakes_root',
    'contract_state_root',
    'contract_state_root_shadow',
    'balances_root_escrow_shadow'
];

function selectedColumns(sql){
    return Array.from(sql.matchAll(/SELECT DISTINCT (\w+) AS r/g), match => match[1]);
}

describe('retained state subtree root coverage @regression @tier1', function(){
    it('keeps every committed and shadow root column in the reclaim union', async function(){
        let call;
        const self = { poolQuery: async (sql, params) => { call = { sql, params }; return []; } };
        await stateTree.getRetainedStateSubtreeRoots.call(self, 'BTC', 'regtest');
        assert.deepStrictEqual(selectedColumns(call.sql), EXPECTED);
        assert.deepStrictEqual(call.params,
            ['BTC', 'regtest', 'BTC', 'regtest', 'BTC', 'regtest',
             'BTC', 'regtest', 'BTC', 'regtest']);
    });

    it('keeps the orphan metric union in parity with the reclaim union', async function(){
        let reclaimSql, metricSql;
        await stateTree.getRetainedStateSubtreeRoots.call({
            poolQuery: async sql => { reclaimSql = sql; return []; }
        }, 'BTC', 'regtest');
        orphanStats.selectRetainedRootUnion((sql) => { metricSql = sql; return []; },
            'BTC', 'regtest');
        assert.deepStrictEqual(selectedColumns(metricSql), selectedColumns(reclaimSql));
    });

    it('filters null shadow slots without dropping a live shadow root', function(){
        let sql;
        orphanStats.selectRetainedRootUnion((query) => { sql = query; return []; },
            'BTC', 'regtest');
        const row = {
            balances_root: 'balances', stakes_root: 'stakes', contract_state_root: null,
            contract_state_root_shadow: 'contract-shadow', balances_root_escrow_shadow: null
        };
        const roots = selectedColumns(sql).map(column => row[column]).filter(value => value !== null);
        assert.deepStrictEqual(roots, ['balances', 'stakes', 'contract-shadow']);
        assert.match(sql, /contract_state_root_shadow IS NOT NULL/);
        assert.match(sql, /balances_root_escrow_shadow IS NOT NULL/);
    });
});
