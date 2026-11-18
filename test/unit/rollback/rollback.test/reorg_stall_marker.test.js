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
 *
 * Unit: entering a reorg rollback replaces the previous pass's stall state with its own
 * marker, and every exit clears it.
 *
 * applyPendingReorgs runs before beginPollPass, so a deadline left by the previous pass
 * is still set when the rollback starts. It must not leak into the rollback, and the
 * rollback's start instant must survive a retried entry so a looping rollback still ages.
 */

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer } = require('../../../fixtures/mocks');
const Rollback = require('../../../../src/rollback/index.js');

const MIN = 60 * 1000;

describe('Rollback stall marker', function () {
    let indexer, rollback, seen;

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.stallReason = 'price_sync_barrier';
        indexer.stallClearsAt = Date.now() + 40 * MIN;
        indexer.futureWaitClearsAt = { block: 1001, at: indexer.stallClearsAt };
        indexer.rollbackStartedAt = null;
        rollback = new Rollback(indexer);
        seen = [];
        sinon.stub(rollback, 'readRollbackScope').callsFake(async () => {
            seen.push({ reason: indexer.stallReason, clearsAt: indexer.stallClearsAt,
                        remembered: indexer.futureWaitClearsAt, startedAt: indexer.rollbackStartedAt });
            throw new Error('scope read failed');
        });
    });

    afterEach(function () { sinon.restore(); });

    it('drops the inherited future-wait deadlines and stamps its own start', async function () {
        const before = Date.now();
        await assert.rejects(rollback.rollback(900), /scope read failed/);
        assert.strictEqual(seen[0].reason, 'reorg_rollback');
        assert.strictEqual(seen[0].clearsAt, null);
        assert.strictEqual(seen[0].remembered, null);
        assert.ok(seen[0].startedAt >= before && seen[0].startedAt <= Date.now());
    });

    it('keeps the first start instant when the entry is retried', async function () {
        await assert.rejects(rollback.rollback(900), /scope read failed/);
        const first = indexer.rollbackStartedAt;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await assert.rejects(rollback.rollback(900), /scope read failed/);
        assert.strictEqual(indexer.rollbackStartedAt, first);
    });

    it('stamps a fresh start once the previous rollback has cleared its reason', async function () {
        await assert.rejects(rollback.rollback(900), /scope read failed/);
        const first = indexer.rollbackStartedAt;
        indexer.stallReason = null;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await assert.rejects(rollback.rollback(900), /scope read failed/);
        assert.ok(indexer.rollbackStartedAt > first);
    });

    it('clears the reason and the start when the transaction fails', async function () {
        rollback.markRollbackStall(Date.now());
        sinon.stub(rollback, 'applyRollbackWrites').rejects(new Error('step boom'));
        await assert.rejects(rollback.runRollbackTransaction(900, {}, [], [], []), /step boom/);
        assert.strictEqual(indexer.stallReason, null);
        assert.strictEqual(indexer.rollbackStartedAt, null);
    });

    it('clears the reason and the start after the commit', async function () {
        rollback.markRollbackStall(Date.now());
        indexer.indexerDb.commitTransaction.resolves(true);
        await rollback.commitAndInvalidateCaches();
        assert.strictEqual(indexer.stallReason, null);
        assert.strictEqual(indexer.rollbackStartedAt, null);
    });
});
