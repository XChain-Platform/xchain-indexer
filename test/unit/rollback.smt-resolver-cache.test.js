/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * A rollback must drop the light-client touched-key resolver caches .
 *
 * `_smtTickNameCache` and `_smtAddressNameCache` memoise surrogate id -> canonical
 * name for the connection's lifetime. That is safe WITHIN a chain segment and
 * unsafe across a reorg: rollback deletes index_tickers / index_addresses rows
 * above the reorg point and frees their dense ids, and createTicker/createAddress
 * then reassign those ids to whatever the new chain interns.
 *
 * A stale entry is silent and expensive. The touched key gets recorded under the
 * OLD name, getNetBalance matches nothing and returns 0, _leafOrNull maps 0 to
 * null, and the commitment DELETES a key that never existed. No error, no log,
 * and the block's balances_root comes out byte-identical to its predecessor's,
 * so the leaf for the real (address, tick) is simply never written.
 *
 * Measured on the regtest venues before the fix: 15 of 1531 ledger-changing
 * blocks on BTC, 8 of 880 on LTC, 2 of 648 on DOGE committed an unchanged
 * balances_root, and ISSUE was over-represented (8/8 on LTC, 2/2 on DOGE)
 * because ISSUE is the action that mints new ids onto the freed range.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const path   = require('path');

describe('rollback drops the SMT resolver caches @regression', function(){

    // The rollback module is large and DB-bound; this suite asserts the one
    // property in isolation by driving the same field the rollback sets, and by
    // pinning at SOURCE level that the rollback really performs it. A behavioural
    // stub of the whole rollback would need a live schema and would not make the
    // invariant any more true.
    const fs  = require('fs');
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/rollback.js'), 'utf8');

    it('rollback.js clears BOTH resolver caches', function(){
        assert.ok(/_smtTickNameCache\s*=\s*null/.test(src),
            'rollback must drop _smtTickNameCache: a reused tick_id would otherwise resolve to the OLD name');
        assert.ok(/_smtAddressNameCache\s*=\s*null/.test(src),
            'rollback must drop _smtAddressNameCache for the same reason on the address axis');
    });

    it('the clear happens on the indexer db, not some other handle', function(){
        assert.ok(/this\.indexerDb\._smtTickNameCache\s*=\s*null/.test(src),
            'the caches live on the indexer db instance that the choke point uses');
    });

    it('the clear sits immediately after commit, beside the block-time memo', function(){
        // WHERE it happens is load-bearing and was wrong once. A rollback that has
        // already COMMITTED must not be able to skip the invalidation, and there is
        // a catch/throw between the commit and the end of rollback(): a clear placed
        // at the end is skipped on that path, leaving exactly the stale cache this
        // guards against. Anchoring to the block-time memo keeps the two siblings
        // together, since they invalidate for the identical reason.
        const commitAt = src.indexOf('await this.indexerDb.commitTransaction()');
        const btAt     = src.indexOf('clearBlockTimeCache()');
        const smtAt    = src.indexOf('_smtTickNameCache    = null');
        assert.ok(commitAt > -1 && btAt > -1 && smtAt > -1, 'all three anchors must exist');
        assert.ok(smtAt > commitAt,
            'the caches must be cleared AFTER commit, so the forward replay re-reads the new chain');
        // Same region as the block-time clear rather than at the end of the method.
        assert.ok(smtAt - btAt < 2000,
            'the clear must sit beside the block-time memo clear, not later in rollback() where ' +
            'a throw on an already-committed rollback would skip it');
    });

    it('a nulled cache is rebuilt lazily and resolves the NEW name', async function(){
        // The consequence of the clear, driven through the real resolver: after a
        // rollback frees id 277 and a new ISSUE reuses it, the next lookup must
        // return the new tick, not the one cached before the reorg.
        const sinon = require('sinon');
        const { getTestConfig } = require('../fixtures/config');
        const Utility  = require('../../src/utility');
        const Database = require('../../src/db');
        const util = new Utility();
        sinon.stub(util, 'logError');
        const db = new Database('127.0.0.1', 3306, 'x', 'u', 'p', { config: getTestConfig(), util });
        db.pool = { getConnection: sinon.stub().resolves({ query: sinon.stub().resolves([]), release: sinon.stub().resolves() }) };

        const q = sinon.stub(db, 'doQueryStrict');
        q.onCall(0).resolves([{ tick: 'OLDTICK' }]);
        q.onCall(1).resolves([{ tick: 'NEWTICK' }]);

        assert.strictEqual(await db._smtTickName(277), 'OLDTICK');
        assert.strictEqual(await db._smtTickName(277), 'OLDTICK', 'cached within the segment');

        db._smtTickNameCache = null;                       // what rollback does

        assert.strictEqual(await db._smtTickName(277), 'NEWTICK',
            'after a reorg the same id must resolve to whatever the new chain interned');
        sinon.restore();
    });
});
