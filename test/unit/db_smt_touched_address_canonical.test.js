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
 * The light-client touched-key set must be canonical on BOTH axes.
 *
 * `createLedgerChangeRecord` resolves the tick through tick_id before recording
 * the touched key, because a "^<id>" or case-variant tick reference would
 * otherwise miss the canonical leaf. The ADDRESS argument carried the identical
 * hazard and was recorded raw: `getAddressId` accepts a wire "^<id>" address
 * reference, so a handler passing "^123" wrote a correct credit row against
 * address_id 123 and then recorded the touched key as the literal "^123".
 *
 * WHY THAT IS WORSE THAN A WRONG LEAF, and why these vectors assert the exact
 * key string rather than just "something was recorded": downstream,
 * `getNetBalance('^123', tick)` joins index_addresses.address = '^123', matches
 * nothing, and returns 0; `_leafOrNull` maps 0 to null; and stateCommitment then
 * DELETES a key that never existed. The update is a silent no-op, the block's
 * balances_root is byte-identical to its predecessor's, and the real address's
 * leaf is never written. No error, no log, nothing to detect it until a node
 * full-rebuilds and diverges.
 *
 * Observed in the field on BTC regtest: 15 of 1531 ledger-changing blocks
 * committed a balances_root identical to the previous block's, and a key was
 * lost permanently only when no later block happened to touch it again (XCHAIN
 * was skipped at block 103 and recovered; FEE0652489 was skipped at 10296 and
 * never moved again, so it stayed missing).
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

const ADDR = 'bcrt1qyp0jdh8c8f6f25nlut0wwu02pva4lpaskx9vx0';
const TICK = 'FEE0652489';

function makeDb(){
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    // Everything the choke point does beyond the touched-key capture is stubbed
    // out: this suite is about which KEY is recorded, nothing else.
    sinon.stub(db, 'doQuery').resolves([]);
    sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
    return db;
}

describe('_smtTouched: the touched key is canonical on BOTH axes @regression', function(){

    afterEach(() => sinon.restore());

    it('a wire ^<id> ADDRESS reference records the canonical address, not the caret form', async function(){
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(50);
        sinon.stub(db, 'createAddress').resolves(123);          // "^123" resolves to id 123
        sinon.stub(db, '_smtTickName').resolves(TICK);
        sinon.stub(db, '_smtAddressName').withArgs(123).resolves(ADDR);
        db._smtTouched = new Set();

        await db.createLedgerChangeRecord('credits', 1, TICK, '1000', '^123');

        assert.deepStrictEqual(Array.from(db._smtTouched), [ADDR + '\t' + TICK],
            'the caret form must never reach the touched set: it derives a key nobody queries, ' +
            'and the resulting update is a delete of a phantom key');
    });

    it('a case-variant ADDRESS records the stored spelling', async function(){
        // Same class as the caret form: createAddress resolves it to the existing
        // row, so the credit lands correctly while a raw capture would key the
        // leaf under a spelling the rebuild never produces.
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(50);
        sinon.stub(db, 'createAddress').resolves(123);
        sinon.stub(db, '_smtTickName').resolves(TICK);
        sinon.stub(db, '_smtAddressName').withArgs(123).resolves(ADDR);
        db._smtTouched = new Set();

        await db.createLedgerChangeRecord('credits', 1, TICK, '1000', ADDR.toUpperCase());

        assert.deepStrictEqual(Array.from(db._smtTouched), [ADDR + '\t' + TICK]);
    });

    it('an ordinary canonical address is unchanged (no regression on the common path)', async function(){
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(50);
        sinon.stub(db, 'createAddress').resolves(123);
        sinon.stub(db, '_smtTickName').resolves(TICK);
        sinon.stub(db, '_smtAddressName').withArgs(123).resolves(ADDR);
        db._smtTouched = new Set();

        await db.createLedgerChangeRecord('credits', 1, TICK, '1000', ADDR);

        assert.deepStrictEqual(Array.from(db._smtTouched), [ADDR + '\t' + TICK]);
    });

    it('an unresolvable address records NOTHING rather than a raw fallback', async function(){
        // Fail closed. Recording the raw string "because we have it" is precisely
        // the behaviour that produced the phantom-key deletes.
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(50);
        sinon.stub(db, 'createAddress').resolves(123);
        sinon.stub(db, '_smtTickName').resolves(TICK);
        sinon.stub(db, '_smtAddressName').resolves(null);
        db._smtTouched = new Set();

        await db.createLedgerChangeRecord('credits', 1, TICK, '1000', '^999999');

        assert.strictEqual(db._smtTouched.size, 0);
    });

    it('a null address_id records nothing (the guard covers both ids)', async function(){
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(50);
        sinon.stub(db, 'createAddress').resolves(null);
        sinon.stub(db, '_smtTickName').resolves(TICK);
        const addrName = sinon.stub(db, '_smtAddressName').resolves(ADDR);
        db._smtTouched = new Set();

        await db.createLedgerChangeRecord('credits', 1, TICK, '1000', '^nope');

        assert.strictEqual(db._smtTouched.size, 0);
        assert.strictEqual(addrName.callCount, 0, 'must not resolve an id it does not have');
    });
});

describe('_smtAddressName: same cache rules as the tick resolver @regression', function(){

    afterEach(() => sinon.restore());

    it('never caches an absence, so a later intern resolves', async function(){
        const db = makeDb();
        db.doQuery.restore();
        const q = sinon.stub(db, 'doQueryStrict');
        q.onCall(0).resolves([]);
        q.onCall(1).resolves([{ address: ADDR }]);

        assert.strictEqual(await db._smtAddressName(123), null);
        assert.strictEqual(await db._smtAddressName(123), ADDR);
        assert.strictEqual(q.callCount, 2);
    });

    it('caches a resolved address', async function(){
        const db = makeDb();
        db.doQuery.restore();
        const q = sinon.stub(db, 'doQueryStrict').resolves([{ address: ADDR }]);

        assert.strictEqual(await db._smtAddressName(123), ADDR);
        assert.strictEqual(await db._smtAddressName(123), ADDR);
        assert.strictEqual(q.callCount, 1);
    });

    it('reads strictly: a fault throws rather than reading as "no such address"', async function(){
        const db = makeDb();
        db.doQuery.restore();
        sinon.stub(db, 'doQueryStrict').rejects(new Error('injected DB fault'));
        sinon.stub(db, 'doQuery').resolves([]);

        await assert.rejects(() => db._smtAddressName(123), /injected DB fault/);
        assert.strictEqual(db.doQuery.callCount, 0);
    });
});
