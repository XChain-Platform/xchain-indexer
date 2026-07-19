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
 * test/unit/poll-early-decide-watermark.test.js
 *
 * : processVoteFinalizations step 2 re-tallied every armed poll from
 * full ledger/vote/delegation history on EVERY block. For a non-time_weighted
 * poll the tally is a pure function of its input rows, so if none of the input
 * tables (votes for the poll, delegations for the tick, the tick's credits/debits)
 * gained a row since the last tally, the early-decide decision is byte-identical
 * and can be skipped. The watermark is an in-memory fingerprint of MAX(action_index)
 * across those tables, reorg-invalidated. time_weighted polls are never skipped
 * (their weight shifts as the measure window extends even without new rows).
 *
 * Uses a real Database (so the real watermark helpers run) with doQuery + the poll
 * selectors stubbed; no MariaDB required.
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
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    return { db, util };
}

// A non-crossing tally: leader 10 of supply 100 = 0.1 < threshold 0.5.
function nonCrossingTally() {
    return { options: [{ weight: '10' }, { weight: '5' }], supply: '100', quorum_met: true, min_voters_met: true };
}

describe('early-decide tally watermark ()', function () {

    afterEach(() => sinon.restore());

    it('skips the full re-tally when no input row landed since the last tally', async function () {
        const { db, util } = makeDb();
        const actions = { processAction: sinon.stub().resolves(), actionVote: { processDueCallbacks: sinon.stub().resolves() } };

        sinon.stub(db, 'getDuePolls').resolves([]);
        sinon.stub(db, 'getArmedPolls').resolves([
            { action_index: 42, tick_id: 7, weight_mode: 'balance', decide_threshold: '0.5' },
        ]);
        const getPollTally = sinon.stub(db, 'getPollTally').resolves(nonCrossingTally());
        // Watermark probe: unchanged tuple across the first two blocks, then a new vote lands.
        let wm = { v: 3, d: 0, l: 9 };
        sinon.stub(db, 'doQuery').callsFake(async () => [{ v: wm.v, d: wm.d, l: wm.l }]);

        // Block N: first sight -> full tally, no early-decide, watermark cached.
        await util.processVoteFinalizations(actions, db, 100, 1700000000);
        assert.strictEqual(getPollTally.callCount, 1, 'first block tallies');
        assert.strictEqual(actions.processAction.callCount, 0, 'did not early-decide');

        // Block N+1: identical fingerprint -> skip the full tally entirely.
        await util.processVoteFinalizations(actions, db, 101, 1700000600);
        assert.strictEqual(getPollTally.callCount, 1, 'second block skipped the re-tally (watermark hit)');

        // Block N+2: a new vote row (v bumps) -> fingerprint changes -> re-tally.
        wm = { v: 4, d: 0, l: 9 };
        await util.processVoteFinalizations(actions, db, 102, 1700001200);
        assert.strictEqual(getPollTally.callCount, 2, 'input change forces a fresh tally');
    });

    it('never skips a time_weighted poll (window-extension changes weight with no new row)', async function () {
        const { db, util } = makeDb();
        const actions = { processAction: sinon.stub().resolves(), actionVote: { processDueCallbacks: sinon.stub().resolves() } };

        sinon.stub(db, 'getDuePolls').resolves([]);
        sinon.stub(db, 'getArmedPolls').resolves([
            { action_index: 42, tick_id: 7, weight_mode: 'time_weighted', decide_threshold: '0.5' },
        ]);
        const getPollTally = sinon.stub(db, 'getPollTally').resolves(nonCrossingTally());
        const doQuery      = sinon.stub(db, 'doQuery').resolves([{ v: 1, d: 1, l: 1 }]);

        await util.processVoteFinalizations(actions, db, 100, 1700000000);
        await util.processVoteFinalizations(actions, db, 101, 1700000600);

        assert.strictEqual(getPollTally.callCount, 2, 'time_weighted poll tallies every block');
        assert.strictEqual(doQuery.callCount, 0, 'no watermark probe for time_weighted polls');
    });

    it('clears the watermark entry when a poll early-decides so a reused index cannot rehydrate it', async function () {
        const { db, util } = makeDb();
        const actions = { processAction: sinon.stub().resolves(), actionVote: { processDueCallbacks: sinon.stub().resolves() } };

        sinon.stub(db, 'getDuePolls').resolves([]);
        sinon.stub(db, 'getArmedPolls').resolves([
            { action_index: 42, tick_id: 7, weight_mode: 'balance', decide_threshold: '0.5' },
        ]);
        // Crossing tally: leader 60 of supply 100 = 0.6 >= 0.5.
        sinon.stub(db, 'getPollTally').resolves({ options: [{ weight: '60' }], supply: '100', quorum_met: true, min_voters_met: true });
        sinon.stub(db, 'doQuery').resolves([{ v: 1, d: 0, l: 2 }]);

        await util.processVoteFinalizations(actions, db, 100, 1700000000);

        assert.strictEqual(actions.processAction.callCount, 1, 'early-decided');
        assert.ok(!db.pollTallyWatermarkMatches(42, '1:0:2'), 'watermark entry cleared after finalization');
    });

    it('clearPollTallyWatermark drops all cached fingerprints (reorg invalidation)', function () {
        const { db } = makeDb();
        db.setPollTallyWatermark(42, '1:2:3');
        assert.ok(db.pollTallyWatermarkMatches(42, '1:2:3'));
        db.clearPollTallyWatermark();
        assert.ok(!db.pollTallyWatermarkMatches(42, '1:2:3'), 'all watermarks cleared');
    });

    it('getPollTallyInputWatermark fingerprints MAX(action_index) of the three input tables', async function () {
        const { db } = makeDb();
        const doQuery = sinon.stub(db, 'doQuery').resolves([{ v: 12, d: 4, l: 30 }]);
        const fp = await db.getPollTallyInputWatermark(42, 7);
        assert.strictEqual(fp, '12:4:30');
        const [sql, args] = doQuery.firstCall.args;
        assert.ok(/FROM votes WHERE poll_index=\?/.test(sql), 'votes probe keyed by poll');
        assert.ok(/FROM vote_delegations WHERE tick_id=\?/.test(sql), 'delegations probe keyed by tick');
        assert.ok(/FROM credits WHERE tick_id=\?/.test(sql) && /FROM debits  WHERE tick_id=\?/.test(sql), 'ledger probe over credits+debits');
        assert.deepStrictEqual(args, [42, 7, 7, 7]);
    });
});
