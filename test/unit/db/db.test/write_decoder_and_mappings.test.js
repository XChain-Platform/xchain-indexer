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
 **********************************************************************/

// test/unit/db/db.test/write_decoder_and_mappings.test.js
//
// Covers decoder amount units and batched action mapping inserts.

'use strict';

const { assert, sinon, Utility, Database } = require('./helpers/db.js');

// ---------------------------------------------------------------------------
// describe: getDecoderBlockData (amount unit conflation regression)
//
// transactions.amount (BIGINT satoshis) and transaction_outputs.amount (VARCHAR
// decimal coin) must never be conflated. The SELECT alias is coin_amount (not
// output_amount) and row.amount is assigned unconditionally from it, so a tx
// with no stored output can never fall back to a raw satoshi integer.
// ---------------------------------------------------------------------------
describe('Database.getDecoderBlockData() amount unit conflation @regression @tier1', function () {
    let db;

    beforeEach(function () {
        db = {
            util: new Utility(),
            doQuery: sinon.stub().resolves([]),
            // getDecoderBlockData reads via doQueryStrict (throw-on-fault) so a transient
            // decoder-DB read fault aborts the block instead of committing an empty block.
            doQueryStrict: sinon.stub().resolves([]),
            getDecoderBlockData: Database.prototype.getDecoderBlockData,
        };
    });

    it('on the no-output path, row.amount is null rather than a satoshi integer', async function () {
        // No transaction_outputs row joined: coin_amount is NULL, vout/output_destination NULL.
        db.doQueryStrict.resolves([{
            data: '{}', raw_data: '', tx_hash: 'txhash1', source: 'addrA', destination: 'addrB',
            fee: 0, block_index: 100, block_time: 1700000000,
            vout: null, coin_amount: null, output_destination: null, source_pubkey: null,
        }]);
        const rows = await db.getDecoderBlockData.call(db, 100);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].amount, null, 'COIN_AMOUNT must never fall back to a satoshi integer');
        assert.strictEqual(rows[0].coin_amount, undefined, 'the raw alias field must be deleted off the emitted row');
    });

    it('carries the decimal-coin string through as row.amount when an output is stored', async function () {
        db.doQueryStrict.resolves([{
            data: '{}', raw_data: '', tx_hash: 'txhash2', source: 'addrA', destination: 'addrB',
            fee: 0, block_index: 100, block_time: 1700000000,
            vout: 0, coin_amount: '0.00005000', output_destination: 'addrC', source_pubkey: null,
        }]);
        const rows = await db.getDecoderBlockData.call(db, 100);
        assert.strictEqual(rows[0].amount, '0.00005000');
    });
});

let db;

// ---------------------------------------------------------------------------
// describe: createActionMappings (batched multi-row insert)
//
// Calling createActionMapping once per address/tick, the way mapper.js reaches
// it, costs O(recipients) serial INSERTs for DIVIDEND/AIRDROP/CALLBACK.
// createActionMappings instead resolves every value's id then writes all rows
// for one (action_index, type) with as few round-trips as possible, preserving
// createActionMapping's existing-row de-duplication and dangling-reference
// skip semantics.
// ---------------------------------------------------------------------------
describe('Database.createActionMappings() batched insert @regression @tier1', function () {
    beforeEach(function () {
        db = {
            util: { isNull: v => v === null || v === undefined },
            createTicker: sinon.stub(),
            createAddress: sinon.stub(),
            doQuery: sinon.stub(),
            createActionMappings: Database.prototype.createActionMappings,
        };
    });

    it('does nothing for an empty list (no DB calls)', async function () {
        await db.createActionMappings.call(db, 1, 'address', []);
        assert.strictEqual(db.createAddress.callCount, 0);
        assert.strictEqual(db.doQuery.callCount, 0);
    });

    it('writes all new addresses in a single batched INSERT', async function () {
        db.createAddress.callsFake(async (a) => ({ addrA: 10, addrB: 11, addrC: 12 }[a]));
        db.doQuery.onFirstCall().resolves([]); // exists-check: none exist yet
        db.doQuery.onSecondCall().resolves([]); // INSERT
        await db.createActionMappings.call(db, 5, 'address', ['addrA', 'addrB', 'addrC']);
        assert.strictEqual(db.doQuery.callCount, 2, 'one exists-check + one INSERT, not one per address');
        const insertQuery = db.doQuery.secondCall.args[0];
        assert.ok(/INSERT INTO mappings_actions/.test(insertQuery));
        // 3 rows -> 3 sets of (?, ?, ?)
        assert.strictEqual((insertQuery.match(/\(\?, \?, \?\)/g) || []).length, 3);
    });

    it('skips ids that already have a mapping row (matches createActionMapping de-dup)', async function () {
        db.createAddress.callsFake(async (a) => ({ addrA: 10, addrB: 11 }[a]));
        db.doQuery.onFirstCall().resolves([{ id: 10 }]); // addrA (id 10) already mapped
        db.doQuery.onSecondCall().resolves([]);          // INSERT for the remaining row
        await db.createActionMappings.call(db, 5, 'address', ['addrA', 'addrB']);
        assert.strictEqual(db.doQuery.callCount, 2);
        const insertQuery = db.doQuery.secondCall.args[0];
        assert.strictEqual((insertQuery.match(/\(\?, \?, \?\)/g) || []).length, 1, 'only the un-mapped id should be inserted');
    });

    it('does not INSERT when every id already has a mapping row', async function () {
        db.createAddress.callsFake(async (a) => ({ addrA: 10 }[a]));
        db.doQuery.resolves([{ id: 10 }]);
        await db.createActionMappings.call(db, 5, 'address', ['addrA']);
        assert.strictEqual(db.doQuery.callCount, 1, 'only the exists-check, no INSERT');
    });

    it('skips a dangling ^<id> reference that resolves to a null id', async function () {
        db.createAddress.callsFake(async (a) => (a === 'addrA' ? 10 : null));
        db.doQuery.onFirstCall().resolves([]);
        db.doQuery.onSecondCall().resolves([]);
        await db.createActionMappings.call(db, 5, 'address', ['addrA', '^999']);
        const existsArgs = db.doQuery.firstCall.args[1];
        assert.deepStrictEqual(existsArgs, [5, 2, 10], 'only the resolved id should reach the exists-check');
    });
});

describe('Database.createActionMappings() batched insert @regression @tier1', function () {
    beforeEach(function () {
        db = {
            util: { isNull: v => v === null || v === undefined },
            createTicker: sinon.stub(),
            createAddress: sinon.stub(),
            doQuery: sinon.stub(),
            createActionMappings: Database.prototype.createActionMappings,
        };
    });

    it('does nothing at all when every value resolves to a null id', async function () {
        db.createAddress.resolves(null);
        await db.createActionMappings.call(db, 5, 'address', ['^bad1', '^bad2']);
        assert.strictEqual(db.doQuery.callCount, 0);
    });

    it('uses type_id=1 for tick and type_id=2 for address', async function () {
        db.createTicker.resolves(20);
        db.createAddress.resolves(21);
        db.doQuery.resolves([]);

        await db.createActionMappings.call(db, 5, 'tick', ['TICKA']);
        assert.strictEqual(db.doQuery.firstCall.args[1][1], 1);

        db.doQuery.resetHistory();
        await db.createActionMappings.call(db, 5, 'address', ['addrA']);
        assert.strictEqual(db.doQuery.firstCall.args[1][1], 2);
    });
});
