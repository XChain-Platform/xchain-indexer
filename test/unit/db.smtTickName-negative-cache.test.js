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
 * `_smtTickName` must never cache an ABSENCE .
 *
 * It resolves tick_id -> canonical tick name for the light-client touched-key
 * set. `createLedgerChangeRecord` skips the touch when the name comes back null,
 * so a cached null does not degrade the answer once, it removes that ticker from
 * `balances_root` for the rest of the connection's life. Nothing downstream
 * notices: the committed root stays internally consistent and every node running
 * the same code agrees, so no fork appears between peers. It surfaces only when
 * some node takes a FULL-REBUILD path (a follower's seedSnapshotRoots, the
 * indexer self-heal recompute, or a flag-day arming block) and computes the
 * complete tree, at which point it diverges from the chain.
 *
 * FOUND IN THE FIELD, which is why the shape below is asserted so literally: on
 * BTC regtest 4 tickers of 276 had EVERY one of their balance keys missing from
 * the committed root, and 0 tickers had only some missing. All-or-nothing per
 * ticker is the signature of a per-tick_id cache, not of a per-update bug, and a
 * fix that only made the read strict would have left the cache poisonable.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb(){
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

describe('_smtTickName: an absence is never cached @regression', function(){

    afterEach(() => sinon.restore());

    it('a miss followed by a hit returns the NAME (the ticker was interned meanwhile)', async function(){
        // The real sequence this reproduces: the id is asked for while its
        // index_tickers row is not visible, and the row exists moments later.
        // Under a negative cache the second call returns null forever and the
        // ticker never enters balances_root again.
        const db = makeDb();
        const q = sinon.stub(db, 'doQueryStrict');
        q.onCall(0).resolves([]);                        // not there yet
        q.onCall(1).resolves([{ tick: 'DECMS4X0D0D1' }]); // interned since

        assert.strictEqual(await db._smtTickName(118), null, 'first call reports the absence honestly');
        assert.strictEqual(await db._smtTickName(118), 'DECMS4X0D0D1',
            'the absence must NOT have been cached: this is the whole defect');
        assert.strictEqual(q.callCount, 2, 'a miss must re-query rather than answer from cache');
    });

    it('a resolved name IS cached (the mapping really is immutable)', async function(){
        const db = makeDb();
        const q = sinon.stub(db, 'doQueryStrict').resolves([{ tick: 'XCHAIN' }]);

        assert.strictEqual(await db._smtTickName(1), 'XCHAIN');
        assert.strictEqual(await db._smtTickName(1), 'XCHAIN');
        assert.strictEqual(await db._smtTickName(1), 'XCHAIN');
        assert.strictEqual(q.callCount, 1, 'a resolved name must be cached, or every ledger row re-queries');
    });

    it('an empty-string name is treated as unresolved and not cached either', async function(){
        // createLedgerChangeRecord's guard rejects '' as well as null, so caching
        // '' would poison the id exactly as caching null does.
        const db = makeDb();
        const q = sinon.stub(db, 'doQueryStrict');
        q.onCall(0).resolves([{ tick: '' }]);
        q.onCall(1).resolves([{ tick: 'S22CLOCK' }]);

        assert.strictEqual(await db._smtTickName(115), '');
        assert.strictEqual(await db._smtTickName(115), 'S22CLOCK');
        assert.strictEqual(q.callCount, 2);
    });

    it('reads STRICTLY, so a DB fault throws instead of masquerading as "no such ticker"', async function(){
        // M-17: through doQuery a non-transactional fault returns [], which this
        // function cannot tell apart from a genuine absence. Combined with the
        // cache that was a permanent silent omission; alone it is still a dropped
        // touch for this block.
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').rejects(new Error('injected DB fault'));
        sinon.stub(db, 'doQuery').resolves([]);      // the soft reader must not be consulted

        await assert.rejects(() => db._smtTickName(253), /injected DB fault/);
        assert.strictEqual(db.doQuery.callCount, 0,
            'the resolver must not fall back to the fail-soft reader');
    });

    it('a fault leaves NO cache entry, so a retried block can still resolve the tick', async function(){
        // The block is retried after a throw. If the failed attempt had left any
        // entry behind, the retry would inherit it and the tick would stay
        // dropped for the rest of the connection's life.
        const db = makeDb();
        const q = sinon.stub(db, 'doQueryStrict');
        q.onCall(0).rejects(new Error('injected DB fault'));
        q.onCall(1).resolves([{ tick: 'TDBIGDCRV' }]);

        await assert.rejects(() => db._smtTickName(253), /injected DB fault/);
        assert.strictEqual(await db._smtTickName(253), 'TDBIGDCRV',
            'the retry must resolve, not inherit a poisoned entry');
    });

    it('distinct tick_ids do not share an entry', async function(){
        const db = makeDb();
        const q = sinon.stub(db, 'doQueryStrict');
        q.withArgs(sinon.match.string, [1]).resolves([{ tick: 'XCHAIN' }]);
        q.withArgs(sinon.match.string, [2]).resolves([{ tick: 'OTHER' }]);

        assert.strictEqual(await db._smtTickName(1), 'XCHAIN');
        assert.strictEqual(await db._smtTickName(2), 'OTHER');
        assert.strictEqual(await db._smtTickName(1), 'XCHAIN');
    });
});
