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
 * A TRANSACTION ABORT must drop the touched-key resolver memos .
 *
 * This is the third mechanism. The first two (a non-canonical address axis, a
 * memo left stale across a REORG) were found and fixed, and the wedge kept
 * happening on venues that provably carried both fixes, always with the same
 * shape: expected and applied off by exactly one key in OPPOSITE directions,
 * and a block that failed the guard hundreds of times against a database
 * nothing else was changing, then parsed on the first try after a process
 * restart. Nothing but process memory crossed that boundary.
 *
 * The memo that crossed it is this one. `_smtTickNameCache` /
 * `_smtAddressNameCache` map a dense surrogate id to its canonical name, and a
 * dense id is handed out as MAX(id)+1. A reorg frees ids by COMMITTING deletes,
 * which rollback.js already invalidates for. An ABORT frees them too - it
 * un-assigns every id the transaction handed out - and nothing invalidated for
 * that, so the memo outlived the assignment it recorded.
 *
 * THE ROLLED-BACK WRITER IS A READ-ONLY API CALL, which is why it was invisible
 * for three investigations. `/feequote` and `/preflight` run the REAL handler
 * inside a transaction they ALWAYS roll back (actions.js computeDryRun), so
 * quoting an ISSUE interns its tick, reaches createLedgerChangeRecord, and fills
 * the memo with id -> the quoted name. Nothing is signed, nothing is broadcast,
 * the id goes back in the pool, and the next real ISSUE/MINT/SEND takes it.
 *
 * What that costs: the choke point records the touched key under the QUOTED
 * name. The ledger names the real one. The touched-set guard sees them differ
 * and refuses the block - correctly, since the alternative is committing a
 * balances_root with the leaf missing - and the retry hits the identical
 * poisoned memo, forever. A HARD LIVENESS HALT, not a silent drop: BTC regtest
 * looped 712 times on block 13363, RLTC 4,572 times on 4248.
 *
 * The field evidence names the mechanism outright. BTC block 10818:
 *   guard  FAILED ... keys=[["bcrt1qp86...","PFX517776"]]
 *   AUDIT  block=10818 extra=[["bcrt1qp86...","PFX925430"]]
 * PFX925430 HAS NO ACTION ON CHAIN. It exists only because a wallet compose ran
 * /feequote and /preflight for it ten minutes earlier and then rejected the
 * confirm. PFX517776 is the ISSUE that really is in block 10818. Same address,
 * the quoted tick's id, the real tick's name.
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

// The block 10818 vectors, verbatim.
const ADDR        = 'bcrt1qp86gpahyu7nu6a0jl3au0uhhq886lf7hr7246k';
const QUOTED_TICK = 'PFX925430';        // dry-run only; never broadcast
const REAL_TICK   = 'PFX517776';        // the ISSUE actually in the block
const FREED_ID    = 277;                // the dense id both took, in turn

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

// A transaction handle whose abort/commit are observable. beginTransaction is
// bypassed (it would need a live pool); the field it sets is what the two
// teardown paths read.
function attachTx(db){
    const tx = {
        rollback: sinon.stub().resolves(),
        commit:   sinon.stub().resolves(),
        release:  sinon.stub().resolves()
    };
    db.transactionConnection = tx;
    return tx;
}

describe('SMT resolver memos are dropped on transaction ABORT @regression', function(){

    afterEach(() => sinon.restore());

    it('rollbackTransaction() drops BOTH memos', async function(){
        const db = makeDb();
        attachTx(db);
        db._smtTickNameCache    = new Map([[FREED_ID, QUOTED_TICK]]);
        db._smtAddressNameCache = new Map([[9, ADDR]]);

        await db.rollbackTransaction();

        assert.strictEqual(db._smtTickNameCache, null,
            'the abort un-assigned every dense tick id this transaction handed out');
        assert.strictEqual(db._smtAddressNameCache, null,
            'and every dense address id, which is the axis the LTC/BTC wedges fired on');
    });

    it('the drop survives a throwing rollback (it is in the finally)', async function(){
        // The teardown must not be skippable: a driver that throws on rollback
        // still leaves the ids un-assigned, so a memo kept here is the same lie.
        const db = makeDb();
        const tx = attachTx(db);
        tx.rollback.rejects(new Error('injected driver fault'));
        db._smtTickNameCache = new Map([[FREED_ID, QUOTED_TICK]]);

        await assert.rejects(() => db.rollbackTransaction(), /injected driver fault/);
        assert.strictEqual(db._smtTickNameCache, null);
    });

    it('a FAILED commit drops them too (it aborts)', async function(){
        const db = makeDb();
        const tx = attachTx(db);
        tx.commit.rejects(new Error('injected commit fault'));
        db._smtTickNameCache    = new Map([[FREED_ID, QUOTED_TICK]]);
        db._smtAddressNameCache = new Map([[9, ADDR]]);

        await assert.rejects(() => db.commitTransaction(), /injected commit fault/);
        assert.strictEqual(db._smtTickNameCache, null);
        assert.strictEqual(db._smtAddressNameCache, null);
    });

    it('a SUCCESSFUL commit keeps them (the ids are permanent, so the memo is true)', async function(){
        // Not a nicety. Clearing on commit too would still be correct, but it
        // would re-read every id the next block touches, and the memo exists
        // because that read sits on the per-action ledger choke point.
        const db = makeDb();
        attachTx(db);
        db._smtTickNameCache    = new Map([[FREED_ID, REAL_TICK]]);
        db._smtAddressNameCache = new Map([[9, ADDR]]);

        assert.strictEqual(await db.commitTransaction(), true);
        assert.ok(db._smtTickNameCache instanceof Map);
        assert.strictEqual(db._smtTickNameCache.get(FREED_ID), REAL_TICK);
        assert.ok(db._smtAddressNameCache instanceof Map);
    });

    it('clearSmtNameCaches() is safe on a db that never resolved anything', function(){
        const db = makeDb();
        db.clearSmtNameCaches();
        assert.strictEqual(db._smtTickNameCache, null);
        assert.strictEqual(db._smtAddressNameCache, null);
    });
});

describe('the dry-run wedge: quote a tick, reject it, broadcast another @regression', function(){

    afterEach(() => sinon.restore());

    // Reproduces block 10818 through the real resolver and the real choke point.
    // The DB models one dense id: the quoted tick holds it until the dry run
    // aborts, the real tick holds it afterwards.
    function stubIdResolution(db, nameNow){
        sinon.stub(db, 'doQueryStrict').callsFake(async (sql) => {
            if(/FROM index_tickers/.test(sql))   return [{ tick: nameNow() }];
            if(/FROM index_addresses/.test(sql)) return [{ address: ADDR }];
            return [];
        });
    }

    it('the broadcast block records the REAL tick, not the quoted one', async function(){
        const db = makeDb();
        let live = QUOTED_TICK;
        stubIdResolution(db, () => live);
        sinon.stub(db, 'doQuery').resolves([]);
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
        sinon.stub(db, 'createTicker').resolves(FREED_ID);      // both ISSUEs take the freed id
        sinon.stub(db, 'createAddress').resolves(9);

        // --- /feequote + /preflight: the real handler, inside a doomed transaction
        attachTx(db);
        db._smtTouched = new Set();
        await db.createLedgerChangeRecord('credits', 1, QUOTED_TICK, '1', ADDR);
        assert.deepStrictEqual(Array.from(db._smtTouched), [ADDR + '\t' + QUOTED_TICK],
            'the dry run really does reach the choke point; that is the whole problem');
        await db.rollbackTransaction();                          // confirm rejected, id freed

        // --- the block that follows: a different ISSUE, interned onto the freed id
        live = REAL_TICK;
        attachTx(db);
        db._smtTouched = new Set();
        await db.createLedgerChangeRecord('credits', 2, REAL_TICK, '1000', ADDR);

        assert.deepStrictEqual(Array.from(db._smtTouched), [ADDR + '\t' + REAL_TICK],
            'the touched key must name the tick the LEDGER moved. Before the abort-scoped ' +
            'invalidation this returned ' + QUOTED_TICK + ' from the memo, the touched-set guard ' +
            'refused the block, and the retry read the same memo forever');
    });

    it('the freed ADDRESS id behaves the same way (the shape both LTC wedges took)', async function(){
        // rltc1q... receiving a tick for the first time, and BTC 13363's
        // getNewFundedAddress gas seed, are both a fresh address on a freed id.
        const db = makeDb();
        const OLD_ADDR = 'bcrt1qdryrunaddressthatwasneverbroadcast0000';
        let live = OLD_ADDR;
        sinon.stub(db, 'doQueryStrict').callsFake(async (sql) => {
            if(/FROM index_addresses/.test(sql)) return [{ address: live }];
            if(/FROM index_tickers/.test(sql))   return [{ tick: 'XCHAIN' }];
            return [];
        });
        sinon.stub(db, 'doQuery').resolves([]);
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'createAddress').resolves(FREED_ID);

        attachTx(db);
        db._smtTouched = new Set();
        await db.createLedgerChangeRecord('credits', 1, 'XCHAIN', '1', OLD_ADDR);
        await db.rollbackTransaction();

        live = ADDR;
        attachTx(db);
        db._smtTouched = new Set();
        await db.createLedgerChangeRecord('credits', 2, 'XCHAIN', '100', ADDR);

        assert.deepStrictEqual(Array.from(db._smtTouched), [ADDR + '\tXCHAIN']);
    });

    it('a COMMITTED block keeps using the memo (no per-action re-read regression)', async function(){
        const db = makeDb();
        stubIdResolution(db, () => REAL_TICK);
        sinon.stub(db, 'doQuery').resolves([]);
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
        sinon.stub(db, 'createTicker').resolves(FREED_ID);
        sinon.stub(db, 'createAddress').resolves(9);

        attachTx(db);
        db._smtTouched = new Set();
        await db.createLedgerChangeRecord('credits', 1, REAL_TICK, '1', ADDR);
        await db.createLedgerChangeRecord('credits', 2, REAL_TICK, '1', ADDR);

        const tickReads = db.doQueryStrict.getCalls()
            .filter(c => /FROM index_tickers/.test(c.args[0])).length;
        assert.strictEqual(tickReads, 1, 'the memo must still serve the second action in the block');
    });
});
