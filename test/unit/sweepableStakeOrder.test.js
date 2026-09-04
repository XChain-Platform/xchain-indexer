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
 **********************************************************************
 * test/unit/sweepableStakeOrder.test.js
 *
 * The eviction sweep read is ORDER-BEARING, so its SQL is pinned here.
 *
 * WHY THIS EXISTS. getSweepableStakeBySource has exactly one non-test caller,
 * rollcall_close.evictSource, and that caller mints one fresh action_index per
 * returned row. The result-set ORDER therefore decides which (source, key) pair
 * gets which action_index, and action_index is what getBlockHashes orders the
 * per-block actions and ledger rows on. An unordered GROUP BY hands that
 * decision to the storage engine, so two honest nodes (or a replay against the
 * live chain) can commit a different permutation and fork.
 *
 * The existing rollcallClose.test.js stubs this method out entirely, so nothing
 * there can see the SQL. That is how the missing ORDER BY survived, and it is
 * why this file asserts the built statement rather than a stub's behaviour.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert   = require('assert');
const Database = require('../../src/db');

// Minimal db-like object carrying only what getSweepableStakeBySource calls,
// mirroring the makeDb pattern in reward-push-stake-floor.test.js.
function makeDb(rows, capture){
    return {
        async getAddressId(){ return 42; },
        async getStatusId(){ return 1; },
        async doQuery(sql, args){ capture.sql = String(sql); capture.args = args; return rows; },
        getSweepableStakeBySource: Database.prototype.getSweepableStakeBySource
    };
}

const ROW = (pubkey, id, amount) => ({ signing_pubkey_id: id, signing_pubkey: pubkey, amount: amount });

describe('getSweepableStakeBySource: the eviction sweep order is pinned @regression @tier1', function(){

    it('orders on the collation-pinned natural key', async function(){
        let cap = {};
        await makeDb([ROW('aa'.repeat(32), 1, '10.00000000')], cap).getSweepableStakeBySource('src', 100, true);
        assert.ok(/ORDER\s+BY\s+ip\.pubkey\s+COLLATE\s+utf8_bin\s+ASC/i.test(cap.sql),
            'the sweep must impose a deterministic order; SQL was: ' + cap.sql);
    });

    it('orders in the activated-only branch too, not just the eviction branch', async function(){
        // The caller passes includePending=true, but the other branch appends an
        // activation_block term and must keep the ORDER BY after it.
        let cap = {};
        await makeDb([ROW('aa'.repeat(32), 1, '10.00000000')], cap).getSweepableStakeBySource('src', 100, false);
        assert.ok(/AND s\.activation_block <= \?/.test(cap.sql), 'expected the activated-only branch');
        assert.ok(/GROUP BY[\s\S]*ORDER\s+BY\s+ip\.pubkey\s+COLLATE\s+utf8_bin\s+ASC\s*$/i.test(cap.sql),
            'the ORDER BY must follow the GROUP BY in both branches; SQL was: ' + cap.sql);
    });

    it('does not rank on signing_pubkey_id, a per-node AUTO_INCREMENT surrogate', async function(){
        // index_pubkeys.id has no cross-node parity, so ordering on it is stable per
        // node and divergent across the fleet - the worst shape this bug can take.
        let cap = {};
        await makeDb([ROW('aa'.repeat(32), 1, '10.00000000')], cap).getSweepableStakeBySource('src', 100, true);
        let orderBy = /ORDER\s+BY([\s\S]*)$/i.exec(cap.sql);
        assert.ok(orderBy, 'no ORDER BY at all');
        assert.strictEqual(/signing_pubkey_id/.test(orderBy[1]), false,
            'the order must be computed from the natural key: ' + orderBy[1]);
    });

    it('hands the rows back in the order the query returned them', async function(){
        // A caller-side re-sort would silently take the order away from the SQL the
        // guard above pins, so the mapping step must be order-preserving.
        let cap = {};
        let rows = [ROW('ff'.repeat(32), 9, '1.00000000'), ROW('00'.repeat(32), 2, '2.00000000')];
        let out  = await makeDb(rows, cap).getSweepableStakeBySource('src', 100, true);
        assert.deepStrictEqual(out.map((r) => r.signing_pubkey), ['ff'.repeat(32), '00'.repeat(32)]);
    });

    it('fails closed on a dangling signing_pubkey rather than minting an UNSTAKE for it', async function(){
        // The LEFT JOIN yields signing_pubkey null when index_pubkeys has no row for
        // the id. Those rows tie under any ordering, and createUnstake would resolve
        // the null through getOrCreatePubkeyId, inventing a pubkey row to bind it to.
        let cap = {};
        let db  = makeDb([ROW('aa'.repeat(32), 1, '10.00000000'), ROW(null, 7, '5.00000000')], cap);
        await assert.rejects(() => db.getSweepableStakeBySource('src', 100, true),
            /signing_pubkey_id 7 has no index_pubkeys row/);
    });

    it('accepts the ordinary all-resolved result unchanged', async function(){
        // The negative control's partner: the guard above must not fire on the shape
        // every real eviction actually sees.
        let cap = {};
        let out = await makeDb([ROW('aa'.repeat(32), 1, '10.00000000'), ROW('bb'.repeat(32), 2, '5.00000000')], cap)
                        .getSweepableStakeBySource('src', 100, true);
        assert.strictEqual(out.length, 2);
        assert.strictEqual(out[1].amount, '5.00000000');
    });
});
