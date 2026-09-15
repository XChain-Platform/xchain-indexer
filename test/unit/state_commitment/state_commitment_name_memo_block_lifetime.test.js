/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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
 *
 * The touched-key NAME MEMOS live for exactly one block.
 *
 * db._smtAddressNameCache / db._smtTickNameCache map a dense surrogate id to its
 * canonical name and are filled only under the _smtTouched choke point, which
 * XChainIndexer installs fresh per block. Only rollbackTransaction and the reorg
 * path cleared them, so a SUCCESSFUL commit retained every entry and resident size
 * grew with the cumulative address/ticker population rather than with per-block
 * work. computeAndStoreRoots is the once-per-block orchestrator that runs after
 * every ledger write of the block, so it is where the memos are dropped.
 *
 * These assertions execute the real orchestrator against the mock db shape the
 * sibling roots suites use. Delete the clear in computeAndStoreRoots and the first
 * case goes red on a retained entry, which is the negative control.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const SC = require('../../../src/stateCommitment.js');

// Mock db routing computeAndStoreRoots' queries by SQL shape, with the real name
// memo surface bolted on. chain LTC keeps the BTC-only stakes path out.
function makeMemoMockDb({ withClear }){
    const nodes = new Map();
    const route = async (sql, params) => {
        if(/FROM state_tree_nodes/.test(sql)){
            const v = nodes.get(params[0]);
            return v ? [v] : [];
        }
        if(/INSERT IGNORE INTO state_tree_nodes/.test(sql)){
            if(!nodes.has(params[0]))
                nodes.set(params[0], { left_hash: params[1], right_hash: params[2] });
            return [];
        }
        if(/SELECT balances_root FROM state_tree_roots/.test(sql))
            return [{ balances_root: SC.EMPTY_ROOT_HEX }];
        if(/UNION ALL/.test(sql) && /INNER JOIN actions/.test(sql))
            return [];
        if(/UNION ALL/.test(sql) && /credits/.test(sql))
            return [];
        return [];
    };
    const db = {
        getBlockLeafRows: async () => [],
        doQuery: route,
        doQueryStrict: route,
        _smtTouched: new Set(),
        _smtAddressNameCache: new Map([[1, 'addr1'], [2, 'addr2']]),
        _smtTickNameCache: new Map([[7, 'TICK']])
    };
    if(withClear){
        db.clearSmtNameCaches = function(){
            this._smtAddressNameCache = null;
            this._smtTickNameCache    = null;
        };
    }
    return db;
}

describe('stateCommitment: name memos do not outlive the block @regression', function(){

    it('drops both name memos at the end of a successful root computation', async function(){
        const db = makeMemoMockDb({ withClear: true });

        // The memos really are populated going in, so the assertion below is about
        // the clear and not about an empty collection that was never filled.
        assert.strictEqual(db._smtAddressNameCache.size, 2);
        assert.strictEqual(db._smtTickNameCache.size, 1);

        await SC.computeAndStoreRoots(db, 'LTC', 'mainnet', 500, false);

        assert.strictEqual(db._smtAddressNameCache, null,
            'address name memo must not survive the block that filled it');
        assert.strictEqual(db._smtTickNameCache, null,
            'tick name memo must not survive the block that filled it');
    });

    it('does not require the clear hook, so query-only mocks still drive the orchestrator', async function(){
        const db = makeMemoMockDb({ withClear: false });
        const out = await SC.computeAndStoreRoots(db, 'LTC', 'mainnet', 500, false);
        assert.strictEqual(out.balances_root, SC.EMPTY_ROOT_HEX);
        assert.strictEqual(db._smtAddressNameCache.size, 2);
    });
});
