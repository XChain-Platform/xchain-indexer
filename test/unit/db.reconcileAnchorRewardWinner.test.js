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
 * test/unit/db.reconcileAnchorRewardWinner.test.js
 *
 * CONSENSUS REGRESSION GUARD for reconcileAnchorRewardWinner() — the
 * replace-on-push collapse that keeps exactly ONE validator_rewards row per
 * (reward_type, round_reference) for anchor rewards (#3963).
 *
 * The hub's RewardTracker dedups failover-race anchor rewards to the
 * lexicographically-smallest signing pubkey in its OWN DB, but its BTC-indexer
 * push has no retract path: a loser pubkey pushed before the winner arrives
 * survives on the indexer as a phantom COLLECT-claimable reward and forks the
 * recovery ledger hash. reconcileAnchorRewardWinner applies the IDENTICAL
 * smallest-pubkey rule indexer-side, order-independently.
 *
 * This file guards the JS wiring + guard (no-op for non-anchor types, correct
 * DELETE + params for anchor types). The SQL's runtime behaviour against a real
 * MariaDB (the DELETE…JOIN derived-table must not self-reference its target) is
 * proven by the real-DB drill in claude/scratch/reconcile-anchor-reward-drill.js.
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
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

afterEach(function () { sinon.restore(); });

describe('reconcileAnchorRewardWinner() @regression @tier1', function () {

    it('is a no-op for non-anchor reward types (issues no query)', async function () {
        const db    = makeDb();
        const query = sinon.stub(db, 'doQuery').resolves({ affectedRows: 7 });
        for (const type of ['oracle_round', 'attest_fee', 'anchor', 'anchorBTC', '']) {
            const removed = await db.reconcileAnchorRewardWinner(123, type);
            assert.strictEqual(removed, 0, 'non-anchor type ' + JSON.stringify(type) + ' must not retract');
        }
        assert.strictEqual(query.called, false, 'no DELETE may be issued for non-anchor types');
    });

    it('issues a single collapse DELETE for an anchor type with the right shape + params', async function () {
        const db    = makeDb();
        const query = sinon.stub(db, 'doQuery').resolves({ affectedRows: 2 });

        const removed = await db.reconcileAnchorRewardWinner(306, 'anchor_BTC');

        assert.strictEqual(query.callCount, 1);
        const [sql, args] = query.firstCall.args;
        // Deletes from validator_rewards, keyed by the lexicographically-smallest
        // signing pubkey, with the min materialised in a derived table (so the
        // DELETE does not self-reference its target table — MariaDB forbids that).
        assert.match(sql, /DELETE\s+vr\s+FROM\s+validator_rewards\s+vr/i);
        assert.match(sql, /JOIN\s+index_pubkeys\s+pk\s+ON\s+pk\.id\s*=\s*vr\.signing_pubkey_id/i);
        assert.match(sql, /MIN\(pk2\.pubkey\)\s+AS\s+min_pubkey/i);
        assert.match(sql, /pk\.pubkey\s*>\s*m\.min_pubkey/i);
        // Subquery params first (it appears earlier in the text), then the outer WHERE.
        assert.deepStrictEqual(args, ['anchor_BTC', 306, 'anchor_BTC', 306]);
        assert.strictEqual(removed, 2, 'returns affectedRows');
    });

    it('returns 0 when the DELETE affects nothing', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves({ affectedRows: 0 });
        assert.strictEqual(await db.reconcileAnchorRewardWinner(306, 'anchor_archive'), 0);
    });

    it('tolerates a driver result without affectedRows', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves(undefined);
        assert.strictEqual(await db.reconcileAnchorRewardWinner(306, 'anchor_DOGE'), 0);
    });
});
