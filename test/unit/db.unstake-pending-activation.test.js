/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db.unstake-pending-activation.test.js
 *
 * ECONOMIC REGRESSION GUARD for the UNSTAKE pending-activation-top-up orphan.
 *
 * The unstake AMOUNT is summed from ACTIVATED rows only (activation_block <= blockIndex), but the
 * deactivation setters used to mark EVERY undeactivated row — so a pending-activation top-up
 * (activation_block > blockIndex) got deactivated yet was excluded from the unstake amount; the
 * cooldown sweep (reads only unstakes/contract_unstakes) never refunds it → tokens orphaned.
 *
 * Fix: both setters filter `activation_block <= currentBlock`, so the deactivated set matches exactly
 * the rows the unstake amount counted. A pending top-up stays an active stake until a later UNSTAKE.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    return db;
}

afterEach(function () { sinon.restore(); });

describe('UNSTAKE deactivation setters exclude pending-activation rows @regression @tier1', function () {

    it('setStakeDeactivationByPubkey filters by activation window (currentBlock)', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(10);
        sinon.stub(db, 'getStatusId').resolves(1);
        let captured = null;
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => { captured = { sql, args }; return []; });

        await db.setStakeDeactivationByPubkey('pk', 310 /* deactivationBlock */, 300 /* currentBlock */);

        assert.ok(captured, 'UPDATE ran');
        assert.ok(/UPDATE\s+stakes/i.test(captured.sql));
        assert.ok(/activation_block <= \?/.test(captured.sql),
            'must filter to already-activated rows (excludes pending-activation top-ups)');
        assert.strictEqual(captured.args[0], 310, 'deactivation_block value');
        assert.ok(captured.args.includes(300), 'currentBlock bound for the activation filter');
    });

    it('setContractStakeDeactivationByPubkey filters by activation window (currentBlock)', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(10);
        sinon.stub(db, 'getTickerId').resolves(1);
        sinon.stub(db, 'getStatusId').resolves(1);
        let captured = null;
        sinon.stub(db, 'doQuery').callsFake(async (sql, args) => { captured = { sql, args }; return []; });

        await db.setContractStakeDeactivationByPubkey(1, 'pk', 'TICK', 310, 300);

        assert.ok(captured, 'UPDATE ran');
        assert.ok(/UPDATE\s+contract_stakes/i.test(captured.sql));
        assert.ok(/activation_block <= \?/.test(captured.sql),
            'must filter to already-activated rows (excludes pending-activation top-ups)');
        assert.strictEqual(captured.args[0], 310, 'deactivation_block value');
        assert.ok(captured.args.includes(300), 'currentBlock bound for the activation filter');
    });
});
