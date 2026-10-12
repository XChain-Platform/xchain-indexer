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
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../../fixtures/mocks');
const { getLogger } = require('../../../src/observability/index.js');

const Rollback = require('../../../src/rollback/index.js');

// A reorg step that fails while the database connection is also failing must still
// surface the STEP's error: the fatal exit log is the only record of why the unwind died.
describe('Rollback.runRollbackTransaction keeps the step error when the rollback also fails', function () {
    let indexer, rollback, errorLog;

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.stallReason = 'reorg_rollback';
        rollback = new Rollback(indexer);
        sinon.stub(rollback, 'reverseCooldownMaturities').resolves();
        sinon.stub(rollback, 'restoreInPlaceFlips').rejects(new Error('step boom'));
        errorLog = sinon.stub(getLogger(), 'error');
    });

    afterEach(function () { sinon.restore(); });

    const SCOPE = { firstActionIndex: null, lastActionIndex: null, unlandedAttestBatches: [] };

    it('rethrows the step error, logs the rollback fault and clears the reorg marker', async function () {
        indexer.indexerDb.rollbackTransaction.rejects(new Error('injected driver fault'));
        await assert.rejects(rollback.runRollbackTransaction(900, SCOPE, [], [], []), /step boom/);
        assert.strictEqual(indexer.stallReason, null);
        assert.ok(errorLog.calledOnce, 'the rollback failure is logged');
        const line = String(errorLog.firstCall.args[0]);
        assert.match(line, /injected driver fault/);
        assert.match(line, /step boom/);
        assert.match(line, /block 900/);
    });

    it('control: a clean rollback still rethrows the step error and logs no rollback fault', async function () {
        await assert.rejects(rollback.runRollbackTransaction(900, SCOPE, [], [], []), /step boom/);
        assert.ok(indexer.indexerDb.rollbackTransaction.calledOnce);
        assert.strictEqual(indexer.stallReason, null);
        assert.ok(errorLog.notCalled);
    });
});
