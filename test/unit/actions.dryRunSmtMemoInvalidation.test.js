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
 * The DRY-RUN ENGINE must be the thing that drops the SMT name memos.
 *
 * `db.smt-resolver-cache-abort.test.js` pins the db half: `rollbackTransaction()`
 * clears `_smtTickNameCache` / `_smtAddressNameCache`, because an abort un-assigns
 * every dense id the transaction handed out. It proves that by calling
 * `rollbackTransaction()` directly.
 *
 * That leaves the COUPLING untested, and the coupling is the whole defect. The
 * rolled-back writer that poisons the memos in production is not the block loop,
 * it is `_dryRunAction`: the read-only engine behind /feequote and /preflight runs
 * the REAL handler inside a transaction it always rolls back, so merely quoting an
 * ISSUE interns its tick, reaches `createLedgerChangeRecord`, and fills the memo
 * with id -> the QUOTED name. If someone re-plumbs that teardown to roll back the
 * connection directly (`this.indexerDb.transactionConnection.rollback()`), or
 * moves it out of the `finally`, both sibling suites stay green and the wedge
 * comes straight back. These tests drive the REAL `_dryRunAction` against a REAL
 * `Database`, stubbing only what needs a live pool, so the invalidation has to
 * actually happen on the path the field evidence used.
 *
 * THE FIELD SHAPE THIS RE-CREATES (LTC regtest, 2026-08-03). A watcher
 * composed an ISSUE that MINTS its supply. The action parsed `valid`, then the
 * touched-set guard refused the block ("the ledger moved 1 key(s) the
 * commitment did not apply", key [address, TICK]), rolled it back, and retried it
 * forever: the indexer sat at block 5204 with the decoder at 5304 and every read
 * stale. Restarting only the indexer container cleared it and the same block then
 * applied cleanly, which is the signature of poisoned PROCESS memory rather than
 * bad chain data. The mint is what makes the ISSUE dangerous: an ISSUE with no
 * supply moves no balance, records no touched key, and cannot trip the guard.
 *
 ********************************************************************/

'use strict';

// The mechanism is coin-agnostic (it is process memory, not chain data), and
// `getTestConfig()` pins BTC regtest for every suite regardless, so these stay on
// the shared fixture rather than fighting it. The LTC identity of the wedge lives
// in the names below.
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const Actions           = require('../../src/actions');

// The LTC regtest venue's own shape: a watcher address, the tick it quoted and
// abandoned, and the tick it actually broadcast onto the freed id.
const ADDR        = 'rltc1qwatcherlaneaddressusedbyxc1075runs0000';
const QUOTED_TICK = 'XC1178QUOTED';
const REAL_TICK   = 'XC1178MINTED';
const FREED_ID    = 812;

// A real Database with no live pool. getConnection is never reached: the tests
// stub beginTransaction (which needs one) and keep rollbackTransaction REAL,
// because rollbackTransaction is the code under test.
function makeDb(){
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_ltc_regtest', 'u', 'p', { config, util });
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    // beginTransaction acquires the tx mutex and opens a connection; here it just
    // installs the observable handle the real teardown reads.
    sinon.stub(db, 'beginTransaction').callsFake(async () => {
        db.transactionConnection = {
            rollback: sinon.stub().resolves(),
            commit:   sinon.stub().resolves(),
            release:  sinon.stub().resolves()
        };
        db._txEpoch++;
    });
    sinon.stub(db, 'getLatestBlockIndex').resolves(5204);
    sinon.stub(db, 'getBlockTime').resolves(1785821261);
    return db;
}

// An Actions-shaped context exposing the real _dryRunAction over that Database.
// processTransaction stands in for the handler chain and is where each test says
// what the quote did to the memos.
function makeCtx(db, processTransaction){
    const ctx = {
        util:          db.util,
        config:        db.util.config,
        indexerDb:     db,
        processTransaction,
        _dryRunAction: Actions.prototype._dryRunAction
    };
    ctx.config['BLOCK_PROCESS_TIMEOUT'] = 300000;
    return ctx;
}

describe('the fee-quote dry run drops the SMT name memos it poisoned @regression', function(){

    afterEach(() => sinon.restore());

    it('a quoted ISSUE leaves neither memo behind', async function(){
        const db = makeDb();
        // The handler chain reaches createLedgerChangeRecord for any ISSUE that mints,
        // which is what fills these. Modelled directly here; the real filler is
        // exercised in the end-to-end case below.
        const ctx = makeCtx(db, async () => {
            db._smtTickNameCache    = new Map([[FREED_ID, QUOTED_TICK]]);
            db._smtAddressNameCache = new Map([[9, ADDR]]);
            return { STATUS: 'valid', ACTION_INDEX: 1 };
        });

        const r = await ctx._dryRunAction.call(ctx, {
            action: 'ISSUE', params: ['0', QUOTED_TICK, '1000'], source: ADDR, timeoutMs: 300000
        });

        assert.strictEqual(r.status, 'valid');
        assert.strictEqual(db._smtTickNameCache, null,
            'the dry run rolled back, so every tick id it interned is back in the pool');
        assert.strictEqual(db._smtAddressNameCache, null,
            'and every address id, the axis the LTC wedge fired on');
    });

    it('a quote whose handler THROWS invalidates too (the teardown is in the finally)', async function(){
        // The common field case: the quote is for an action that will be judged
        // invalid, or the handler blows up part way. The ids it interned before the
        // throw are freed exactly the same way.
        const db = makeDb();
        const ctx = makeCtx(db, async () => {
            db._smtTickNameCache = new Map([[FREED_ID, QUOTED_TICK]]);
            throw new Error('injected handler fault');
        });

        const r = await ctx._dryRunAction.call(ctx, {
            action: 'ISSUE', params: ['0', QUOTED_TICK, '1000'], source: ADDR, timeoutMs: 300000
        });

        assert.match(String(r.error), /injected handler fault/);
        assert.strictEqual(db._smtTickNameCache, null);
    });

    it('end to end: quote a tick, abandon it, then MINT another onto its id', async function(){
        // The venue sequence, through the real dry-run engine and the real ledger
        // choke point. `live` is the database row the freed dense id resolves to:
        // the quoted tick holds it during the quote, the broadcast one afterwards.
        const db = makeDb();
        let live = QUOTED_TICK;
        sinon.stub(db, 'doQueryStrict').callsFake(async (sql) => {
            if(/FROM index_tickers/.test(sql))   return [{ tick: live }];
            if(/FROM index_addresses/.test(sql)) return [{ address: ADDR }];
            return [];
        });
        sinon.stub(db, 'doQuery').resolves([]);
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
        sinon.stub(db, 'createTicker').resolves(FREED_ID);   // both ISSUEs take the freed id
        sinon.stub(db, 'createAddress').resolves(9);

        // --- /feequote: the real handler credits the mint, inside a doomed transaction
        const ctx = makeCtx(db, async () => {
            db._smtTouched = new Set();
            await db.createLedgerChangeRecord('credits', 1, QUOTED_TICK, '1000', ADDR);
            return { STATUS: 'valid', ACTION_INDEX: 1 };
        });
        await ctx._dryRunAction.call(ctx, {
            action: 'ISSUE', params: ['0', QUOTED_TICK, '1000'], source: ADDR, timeoutMs: 300000
        });
        assert.strictEqual(db._smtTickNameCache, null,
            'the quote reached the choke point and the rollback undid what it learned there');

        // --- the block that follows: a DIFFERENT mint-carrying ISSUE on the freed id
        live = REAL_TICK;
        db.transactionConnection = { rollback: sinon.stub().resolves(), commit: sinon.stub().resolves(), release: sinon.stub().resolves() };
        db._smtTouched = new Set();
        await db.createLedgerChangeRecord('credits', 2, REAL_TICK, '21000000', ADDR);

        assert.deepStrictEqual(Array.from(db._smtTouched), [ADDR + '\t' + REAL_TICK],
            'the touched key must name the tick the LEDGER moved. Reading ' + QUOTED_TICK +
            ' out of the memo here is what made the touched-set guard refuse LTC block 5204 ' +
            'and every retry of it');
    });

    it('the dry run leaves the memos usable, not permanently disabled', async function(){
        // Clearing has to be an invalidation, not a kill switch: the memo exists
        // because the resolver sits on the per-action ledger choke point, so the
        // next block must be able to refill and reuse it.
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').callsFake(async (sql) => {
            if(/FROM index_tickers/.test(sql))   return [{ tick: REAL_TICK }];
            if(/FROM index_addresses/.test(sql)) return [{ address: ADDR }];
            return [];
        });
        sinon.stub(db, 'doQuery').resolves([]);
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
        sinon.stub(db, 'createTicker').resolves(FREED_ID);
        sinon.stub(db, 'createAddress').resolves(9);

        const ctx = makeCtx(db, async () => ({ STATUS: 'valid', ACTION_INDEX: 1 }));
        await ctx._dryRunAction.call(ctx, {
            action: 'ISSUE', params: ['0', REAL_TICK, '1000'], source: ADDR, timeoutMs: 300000
        });

        db.transactionConnection = { rollback: sinon.stub().resolves(), commit: sinon.stub().resolves(), release: sinon.stub().resolves() };
        db._smtTouched = new Set();
        await db.createLedgerChangeRecord('credits', 2, REAL_TICK, '1', ADDR);
        await db.createLedgerChangeRecord('credits', 3, REAL_TICK, '1', ADDR);

        const tickReads = db.doQueryStrict.getCalls()
            .filter(c => /FROM index_tickers/.test(c.args[0])).length;
        assert.strictEqual(tickReads, 1, 'refilled once after the dry run, then served from memory');
        assert.deepStrictEqual(Array.from(db._smtTouched), [ADDR + '\t' + REAL_TICK]);
    });
});
