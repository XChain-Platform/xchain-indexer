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
 * test/unit/db/balance_delta_collect.test.js
 *
 * Ledger row upserts collect their net balance effect during a block so balance
 * maintenance can avoid re-summing the complete credit and debit history.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('./db_queries.test/helpers/db_stub');
const blockParse = require('../../../src/XChainIndexer/block_parse.js');

afterEach(function () {
    sinon.restore();
});

function ledgerDb(rows) {
    const db = makeDb();
    db.blockIndex = 1;
    db._balanceDelta = new Map();
    sinon.stub(db, 'createTicker').resolves(11);
    sinon.stub(db, 'createAddress').resolves(22);
    const dq = sinon.stub(db, 'doQuery');
    dq.onCall(0).resolves(rows || []);
    dq.onCall(1).resolves([]);
    return db;
}

function delta(db, addressId, tickId) {
    const byTick = db._balanceDelta.get(addressId);
    return byTick && byTick.get(tickId);
}

describe('per-block balance delta collection @regression @tier1', function () {
    it('collects inserted credits and debits as opposite balance effects', async function () {
        const credit = ledgerDb([]);
        await credit.createLedgerChangeRecord('credits', 1, 'TOK', '5.25', 'addr');
        assert.strictEqual(delta(credit, 22, 11), '5.25');

        const debit = ledgerDb([]);
        await debit.createLedgerChangeRecord('debits', 1, 'TOK', '2.5', 'addr');
        assert.strictEqual(delta(debit, 22, 11), '-2.5');
    });

    it('collects only new minus old when an existing credit row is replaced', async function () {
        const db = ledgerDb([{ action_index: 1, amount: '7.25' }]);
        await db.createLedgerChangeRecord('credits', 1, 'TOK', '10', 'addr');
        assert.strictEqual(delta(db, 22, 11), '2.75');
        assert.match(String(db.doQuery.firstCall.args[0]), /SELECT[\s\S]*amount/);
    });

    it('reverses the replacement difference for a debit row', async function () {
        const db = ledgerDb([{ action_index: 1, amount: '7' }]);
        await db.createLedgerChangeRecord('debits', 1, 'TOK', '4', 'addr');
        assert.strictEqual(delta(db, 22, 11), '3');
    });

    it('accumulates by address and tick without mixing either key', async function () {
        const db = ledgerDb([]);
        await db.createLedgerChangeRecord('credits', 1, 'TOK', '8', 'addr');

        db.createTicker.resolves(12);
        db.createAddress.resolves(23);
        db.doQuery.resetBehavior();
        db.doQuery.resolves([]);
        await db.createLedgerChangeRecord('debits', 2, 'OTHER', '3', 'other');

        db.createTicker.resolves(11);
        db.createAddress.resolves(22);
        await db.createLedgerChangeRecord('debits', 3, 'TOK', '1.5', 'addr');

        assert.strictEqual(delta(db, 22, 11), '6.5');
        assert.strictEqual(delta(db, 23, 12), '-3');
        assert.strictEqual(db._balanceDelta.size, 2);
    });

    it('ignores escrows and writes made without an active block collector', async function () {
        const escrow = ledgerDb([]);
        await escrow.createLedgerChangeRecord('escrows', 1, 'TOK', '5', 'addr');
        assert.strictEqual(escrow._balanceDelta.size, 0);

        const outsideBlock = ledgerDb([]);
        outsideBlock._balanceDelta = null;
        await outsideBlock.createLedgerChangeRecord('credits', 1, 'TOK', '5', 'addr');
        assert.strictEqual(outsideBlock._balanceDelta, null);
    });

    it('records nothing when the ledger DML fails', async function () {
        const db = ledgerDb([]);
        db.doQuery.onCall(1).rejects(new Error('write failed'));
        await assert.rejects(
            () => db.createLedgerChangeRecord('credits', 1, 'TOK', '5', 'addr'),
            /write failed/
        );
        assert.strictEqual(db._balanceDelta.size, 0);
    });

    it('replaces stale deltas whenever a block transaction opens', async function () {
        const stale = new Map([[22, new Map([[11, '9']])]]);
        const indexerDb = { beginTransaction: sinon.stub().resolves(), _balanceDelta: stale };
        const ctx = {
            indexerDb: indexerDb,
            config: { NETWORK: 'mainnet', COIN: 'BTC' }
        };

        await blockParse.openBlockTransaction.call(ctx, 100);

        assert.ok(indexerDb._balanceDelta instanceof Map);
        assert.notStrictEqual(indexerDb._balanceDelta, stale);
        assert.strictEqual(indexerDb._balanceDelta.size, 0);
    });
});
