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
 *********************************************************************/

/*
 * test/unit/reward-push-stake-floor.test.js
 *
 * The stake-source FLOOR under the anchor-reward flag-day gates.
 *
 * The retirement gates on the reward-push rail are an OR of two planes, and on
 * mainnet both planes read a zero as "flag-day not yet active": the activation
 * heights there are 961000 (anchor) and 963000 (archive), so a request carrying
 * block_index 0 AND round 0 clears both and reaches the writer. That is not a
 * hole today, but it is only closed by a SECOND, unrelated mechanism further
 * down: createValidatorReward resolves an ACTIVE staking source at the reward's
 * own earn block before it writes anything, and no stake is active at block 0,
 * so the write is refused, `written` stays 0, and the smallest-pubkey reconcile
 * that does the deleting is never invoked.
 *
 * That floor is load-bearing and nothing else pins it as such. Two refactors
 * would silently remove it: writing the row before (or without) resolving a
 * source, and resolving the source at some other height (a chain tip, the
 * latest stake by action_index) instead of at the reward's earn block, which
 * would hand a block-0 reward a live source. This file pins both, plus the
 * mainnet-only shape of the residual, so a future change to either has to be
 * deliberate.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert   = require('assert');
const sinon    = require('sinon');
const Database = require('../../src/db');
const ar       = require('../../src/anchor_reward_activation');

const PUB = 'cd'.repeat(32); // 64 hex chars

// Minimal db-like object carrying only the methods under test, mirroring the
// makeDb pattern in reward-source-resolution.test.js.
function makeDb({ pubkeyId = 7, validId = 1, doQuery } = {}) {
    return {
        getPubkeyId: sinon.stub().resolves(pubkeyId),
        getStatusId: sinon.stub().resolves(validId),
        doQuery:     doQuery || sinon.stub().resolves([]),
        _resolveActiveStakeSourceId: Database.prototype._resolveActiveStakeSourceId,
        createValidatorReward:       Database.prototype.createValidatorReward,
    };
}

const insertCalls = db => db.doQuery.getCalls()
    .filter(c => /INSERT/i.test(String(c.args[0])) && /validator_rewards/.test(String(c.args[0])));

describe('anchor-reward push: both gate planes read zero as pre-flag-day on mainnet @regression @tier1', function () {

    it('reads block_index 0 and round 0 as inactive on mainnet, so the gate passes them through', function () {
        // The per-chain leg ORs the wire block_index with `round`; the archive leg ORs
        // the wire block_index with the node's own committed tip. A caller who can set
        // both of the wire-side inputs to 0 clears both legs on mainnet, because the
        // mainnet thresholds are non-zero heights.
        assert.strictEqual(ar.isAnchorRewardActive(0,  'mainnet'), false);
        assert.strictEqual(ar.isArchiveRewardActive(0, 'mainnet'), false);
        assert.ok(ar.ANCHOR_REWARD_ACTIVATION.mainnet  > 0);
        assert.ok(ar.ARCHIVE_REWARD_ACTIVATION.mainnet > 0);
    });

    it('has no such residual on testnet or regtest, where the flag-days sit at 0', function () {
        // Both networks are armed from genesis, so zero is at/above the threshold and
        // the gate itself refuses. The residual below is a mainnet-only shape.
        for (const network of ['testnet', 'regtest']) {
            assert.strictEqual(ar.isAnchorRewardActive(0,  network), true, network);
            assert.strictEqual(ar.isArchiveRewardActive(0, network), true, network);
        }
    });
});

describe('anchor-reward push: the stake-source floor under the gate @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('refuses to write a reward earned at block 0, because no stake is active there', async function () {
        sinon.stub(console, 'warn');
        // Both resolution legs (stakes, then delegations) come back empty, which is what
        // block 0 produces on a real chain: every stake activates in a block that carries
        // a STAKE action, and no such block precedes the genesis height.
        const db = makeDb({ doQuery: sinon.stub().resolves([]) });
        const ok = await db.createValidatorReward.call(db, PUB, 0, 'anchor_BTC', '10.00000000', 0, true);
        assert.strictEqual(ok, false,
            'a reward with no active stake at its earn block must not be written');
        assert.strictEqual(insertCalls(db).length, 0,
            'nothing may be inserted into validator_rewards when no source resolves');
    });

    it('resolves the source at the REWARD\'s block, not at any later height', async function () {
        sinon.stub(console, 'warn');
        const db = makeDb({ doQuery: sinon.stub().resolves([]) });
        await db.createValidatorReward.call(db, PUB, 0, 'anchor_BTC', '10.00000000', 0, true);
        const stakeLeg = db.doQuery.getCalls().find(c => /FROM stakes/.test(String(c.args[0])));
        assert.ok(stakeLeg, 'the stakes resolution leg must run before any write');
        // The activation/deactivation window and both NOT EXISTS legs are all bound to
        // the reward's own block. Binding a tip or a "latest stake" instead would hand a
        // block-0 reward a live source and take the floor out from under the gate.
        assert.deepStrictEqual(stakeLeg.args[1], [7, 1, 0, 0, 1, 0, 0],
            'every height bound in the source query must be the reward block that was passed in');
    });

    it('still writes a reward whose earn block DOES carry an active stake', async function () {
        // Positive control: the refusal above is the unresolved-source branch, not a
        // blanket refusal. Without this, a mutation that made the writer always return
        // false would still look green.
        const doQuery = sinon.stub().callsFake(function (sql) {
            if (/FROM stakes/.test(sql))       return Promise.resolve([{ source_id: 55 }]);
            if (/validator_rewards/.test(sql)) return Promise.resolve({ affectedRows: 1 });
            return Promise.resolve([]);
        });
        const db = makeDb({ doQuery });
        const ok = await db.createValidatorReward.call(db, PUB, 850000, 'anchor_BTC', '10.00000000', 850000, true);
        assert.strictEqual(ok, true);
        const inserts = insertCalls(db);
        assert.strictEqual(inserts.length, 1, 'the resolved-source path must insert exactly one row');
        assert.strictEqual(inserts[0].args[1][0], 55, 'the insert must carry the resolved source_id');
    });
});
