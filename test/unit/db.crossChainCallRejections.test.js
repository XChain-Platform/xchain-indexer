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
 * test/unit/db.crossChainCallRejections.test.js
 *
 * XDISP-1: quorum-starved dispatch visibility. Pins the node-local rejection
 * diagnostics helpers:
 *   - recordCrossChainCallRejection upserts one row per call_id (attempts
 *     accumulate, last_block advances) with a bounded detail string;
 *   - recordCrossChainCallExecution clears the rejection row (a call that
 *     finally executed must not keep stale starvation evidence);
 *   - getCrossChainCallRejectionById normalizes the call_id to lowercase.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

const CALL_ID = 'A'.repeat(64); // uppercase input pins the lowercase normalization

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

describe('cross_chain_call_rejections helpers (XDISP-1)', function () {

    afterEach(() => sinon.restore());

    it('recordCrossChainCallRejection upserts by call_id with accumulating attempts', async function () {
        const db = makeDb();
        const doQuery = sinon.stub(db, 'doQuery').resolves([]);
        await db.recordCrossChainCallRejection(CALL_ID, 'quorum_not_met', 'insufficient signer stake (1 valid signers of 3 snapshot keys)', 210);
        assert.ok(doQuery.calledOnce);
        const [sql, args] = doQuery.firstCall.args;
        assert.ok(/INSERT INTO cross_chain_call_rejections/.test(sql));
        assert.ok(/ON DUPLICATE KEY UPDATE/.test(sql), 'must be an upsert: one row per call_id');
        assert.ok(/attempts\s*=\s*attempts \+ 1/.test(sql), 'repeat refusals accumulate the attempt count');
        assert.strictEqual(args[0], CALL_ID.toLowerCase());
        assert.strictEqual(args[1], 'quorum_not_met');
        assert.deepStrictEqual(args.slice(3), [210, 210], 'first_block and last_block both start at the refusing block');
    });

    it('recordCrossChainCallRejection bounds detail to the column width and keeps null null', async function () {
        const db = makeDb();
        const doQuery = sinon.stub(db, 'doQuery').resolves([]);
        await db.recordCrossChainCallRejection(CALL_ID, 'quorum_not_met', 'x'.repeat(300), 210);
        assert.strictEqual(doQuery.firstCall.args[1][2].length, 250);
        await db.recordCrossChainCallRejection(CALL_ID, 'quorum_not_met', null, 211);
        assert.strictEqual(doQuery.secondCall.args[1][2], null);
    });

    it('recordCrossChainCallExecution clears the rejection row for the executed call', async function () {
        const db = makeDb();
        const doQuery = sinon.stub(db, 'doQuery').resolves([]);
        await db.recordCrossChainCallExecution(5, CALL_ID, 6, 'ok', '', 100, 210);
        const deleteCall = doQuery.getCalls().find(c => /DELETE FROM cross_chain_call_rejections/.test(c.args[0]));
        assert.ok(deleteCall, 'executing the call must delete its starvation diagnostics');
        assert.deepStrictEqual(deleteCall.args[1], [CALL_ID.toLowerCase()]);
    });

    it('getCrossChainCallRejectionById lowercases the id and returns the row or null', async function () {
        const db  = makeDb();
        const row = { call_id: CALL_ID.toLowerCase(), reason: 'quorum_not_met', attempts: 3 };
        const doQuery = sinon.stub(db, 'doQuery').resolves([row]);
        assert.strictEqual(await db.getCrossChainCallRejectionById(CALL_ID), row);
        assert.strictEqual(doQuery.firstCall.args[1][0], CALL_ID.toLowerCase());
        doQuery.resolves([]);
        assert.strictEqual(await db.getCrossChainCallRejectionById(CALL_ID), null);
    });
});
