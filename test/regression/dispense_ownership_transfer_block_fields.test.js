/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/regression/dispense_ownership_transfer_block_fields.test.js
 *
 * The ownership-transfer ledger row of an ownership dispense carries its block fields.
 *
 * Filling an ownership dispenser writes a synthetic ISSUE through
 * util.transferTokenOwnership, and that row's actions entry needs BLOCK_INDEX for
 * the NOT NULL actions.block_index. The row takes BLOCK_INDEX, TX_INDEX and
 * BLOCK_TIME from the paying transaction's data, the same source every other
 * ownership caller uses, on all three entry shapes: a native-coin payment, a
 * token-priced SEND trigger, and a DISPENSE inside a BATCH.
 *
 * The settle path here is the real one end to end: the real DISPENSE (and BATCH)
 * handler, the real transferTokenOwnership, and the real createActionIndex writing
 * into the project's own src/sql/actions.sql DDL on node:sqlite, so the NOT NULL
 * contract the block commit depends on is the one under test. Only the reads that
 * locate the dispenser and the other table writers are stubbed.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const actionIndexMixin    = require('../../src/db/actions/action_index.js');
const Batch               = require('../../src/actions/batch/index.js');
const Actions             = require('../../src/actions/index.js');
const { makeMigrationDb } = require('../helpers/sqlMigrationDb');
const { createBaseData, createTokenInfo } = require('../fixtures/mocks');
const {
    makeDispenserInfo, OWNER_ADDR, BUYER_ADDR, BLOCK_TIME, freshDispenseSuite,
} = require('../unit/actions/market/dispense.test/helpers/dispense_suite');

const SUITE     = '[regression:p0] ownership dispense: the ownership-transfer ledger row carries its block fields @money @regression @tier1';
const PAY_BLOCK = 100;
const PAY_TX    = 7;

// Route the indexer DB's action_index family to the real mixin over a real actions table.
function wireRealActionIndex(indexerDb, util){
    const sql = makeMigrationDb(['actions.sql']);
    indexerDb.util = util;
    indexerDb.doQuery = async (query, args) => {
        let stmt = sql.db.prepare(query);
        return /^\s*SELECT/i.test(query) ? stmt.all(...(args || [])) : stmt.run(...(args || []));
    };
    for(const name of ['getNextActionIndex', 'getActionIndex', 'createActionIndex'])
        indexerDb[name] = actionIndexMixin[name].bind(indexerDb);
    return sql;
}

// One open ownership dispenser selling a single unit of JDOG, priced in BTC or in a token.
function ownershipDispenser(overrides){
    return makeDispenserInfo(Object.assign({
        GIVE_OWNERSHIP: 1, GIVE_AMOUNT: '1', GIVE_ESCROW: '1', GIVE_REMAINING: '1',
    }, overrides || {}));
}

// The DISPENSE suite's mock indexer with the real action index wired in. A DISPENSE routed
// through processAction runs the real handler; the auto-close DISPENSER_CLOSE it mints is out of scope.
function freshOwnershipSuite(){
    let s = freshDispenseSuite();
    s.sql = wireRealActionIndex(s.indexer.indexerDb, s.indexer.util);
    s.indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
    s.indexer.indexerDb.getDispenserInfo.resolves(ownershipDispenser());
    s.actionsCtx.processAction = sinon.stub().callsFake(async (action, params, data, error) => {
        if(action === 'DISPENSE')
            await s.dispense.parse(params || [], data, error || false);
    });
    s.indexer.util.resetLists();
    return s;
}

// The paying transaction as actions/index.js hands it on, its own actions row already written.
async function payingTransaction(indexerDb, overrides){
    let data = createBaseData(Object.assign({
        SOURCE: BUYER_ADDR, BLOCK_INDEX: PAY_BLOCK, BLOCK_TIME, TX_INDEX: PAY_TX,
    }, overrides));
    data['ACTION_INDEX'] = await indexerDb.createActionIndex(data, true);
    return data;
}

// The ISSUE row and its actions entry carry the paying transaction's block fields, and its
// action_index is minted right after the dispense's own.
function assertOwnershipIssueRow(sql, indexer){
    let rec = indexer.indexerDb.createDispense.firstCall.args[0];
    assert.strictEqual(rec['STATUS'], 'valid', 'the ownership dispense must settle');
    sinon.assert.calledOnce(indexer.indexerDb.clearTokenEscrow);
    sinon.assert.calledOnce(indexer.indexerDb.createIssue);

    let issue = indexer.indexerDb.createIssue.firstCall.args[0];
    assert.strictEqual(issue['ACTION'], 'ISSUE');
    assert.strictEqual(issue['SOURCE'], OWNER_ADDR);
    assert.strictEqual(issue['TRANSFER'], BUYER_ADDR);
    assert.strictEqual(issue['BLOCK_INDEX'], PAY_BLOCK);
    assert.strictEqual(issue['TX_INDEX'], PAY_TX);
    assert.strictEqual(issue['BLOCK_TIME'], BLOCK_TIME);

    let row = sql.rows('SELECT action_index, block_index, tx_index FROM actions WHERE action_index = ?', [issue['ACTION_INDEX']]);
    assert.deepStrictEqual(row, [{ action_index: issue['ACTION_INDEX'], block_index: PAY_BLOCK, tx_index: PAY_TX }]);
    assert.strictEqual(issue['ACTION_INDEX'], rec['ACTION_INDEX'] + 1,
        'the ISSUE action_index follows the dispense action_index, as on every other ownership caller');
}

describe(SUITE, function () {
    let s;
    beforeEach(function () { s = freshOwnershipSuite(); });
    afterEach(function () { s.sql.close(); sinon.restore(); });

    it('a native-coin payment writes the ISSUE with the paying transaction block fields', async function () {
        let data = await payingTransaction(s.indexer.indexerDb, { ACTION: 'DISPENSE', COIN_AMOUNT: '0.01' });

        await s.dispense.parse([], data, false);

        assertOwnershipIssueRow(s.sql, s.indexer);
    });

    it('a token-priced SEND trigger writes the ISSUE with the SEND block fields', async function () {
        let db = s.indexer.indexerDb;
        db.getDispenserInfo.resolves(ownershipDispenser({ GET_TICK: 'PAYT', GET_AMOUNT: '1' }));
        db.getTokenInfo.withArgs('PAYT', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PAYT', TICK_ID: 11, DECIMALS: 8 }));
        db.findDispenserSends = sinon.stub().resolves([
            { source: BUYER_ADDR, coin: 'BTC', tick: 'PAYT', amount: '1', destination: OWNER_ADDR },
        ]);
        let send = await payingTransaction(db, { ACTION: 'SEND' });

        await s.indexer.util.processDispenserSends(s.actionsCtx, db, send);

        assertOwnershipIssueRow(s.sql, s.indexer);
    });

    it('a DISPENSE inside a BATCH writes the ISSUE with the BATCH transaction block fields', async function () {
        s.actionsCtx.isBatchProbeForbiddenSubAction = Actions.isBatchProbeForbiddenSubAction;
        s.actionsCtx.actionAliases = {};
        s.indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
        s.indexer.indexerDb.isActionAllowed.resolves(true);
        let data = await payingTransaction(s.indexer.indexerDb, {
            ACTION: 'BATCH', FORMAT: 0, COIN_AMOUNT: '0.01', TX_DATA: 'BATCH|0|DISPENSE|0',
        });

        await new Batch(s.actionsCtx).parse(['0'], data, null);

        assert.ok(s.actionsCtx.processAction.calledWith('DISPENSE'), 'the BATCH must dispatch its DISPENSE');
        assertOwnershipIssueRow(s.sql, s.indexer);
    });
});

describe(SUITE, function () {
    let s;
    beforeEach(function () { s = freshOwnershipSuite(); });
    afterEach(function () { s.sql.close(); sinon.restore(); });

    it('transferTokenOwnership refuses a row without block fields before it writes anything', async function () {
        let row = { ACTION_INDEX: 3, GIVE_TICK: 'JDOG', DESTINATION: BUYER_ADDR };

        await assert.rejects(
            s.indexer.util.transferTokenOwnership(s.indexer.indexerDb, s.indexer.mapper, row, 'JDOG', OWNER_ADDR, BUYER_ADDR),
            /transferTokenOwnership\(JDOG\): action data is missing BLOCK_INDEX, BLOCK_TIME/);
        sinon.assert.notCalled(s.indexer.indexerDb.clearTokenEscrow);
        sinon.assert.notCalled(s.indexer.indexerDb.createIssue);
        assert.deepStrictEqual(s.sql.rows('SELECT action_index FROM actions'), []);
    });

    it('a block-level pass with no transaction still transfers, with a NULL tx_index', async function () {
        // COINPAY_EXPIRE, CROSS_SETTLE and a cancelled DISPENSER_CLOSE carry no TX_INDEX.
        let data = { ACTION: 'COINPAY_EXPIRE', BLOCK_INDEX: PAY_BLOCK, BLOCK_TIME, ACTION_INDEX: 1 };

        await s.indexer.util.transferTokenOwnership(s.indexer.indexerDb, s.indexer.mapper, data, 'JDOG', OWNER_ADDR, BUYER_ADDR);

        let issue = s.indexer.indexerDb.createIssue.firstCall.args[0];
        assert.deepStrictEqual(s.sql.rows('SELECT block_index, tx_index FROM actions WHERE action_index = ?', [issue['ACTION_INDEX']]),
            [{ block_index: PAY_BLOCK, tx_index: null }]);
    });
});
