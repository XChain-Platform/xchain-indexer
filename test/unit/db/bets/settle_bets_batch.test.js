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
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const bets          = require('../../../../src/db/bets/index.js');
const terminalBatch = require('../../../../src/db/bets/terminal_batch.js');

const STATUS_IDS = { refunded: 41, open: 7 };

// Pull the ids out of a parenthesised placeholder list's bound args.
function idsAfter(args, skip) {
    return args.slice(skip).map(Number);
}

// Apply one statement to the two-table store; only the shapes the per-bet and batch
// writers issue are understood, and anything else fails the test loudly.
function applyStatement(store, sql, args) {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (/^UPDATE bets SET bet_status_id=\?, settled_block=\? WHERE action_index(=\?| IN \()/.test(q)) {
        for (const id of idsAfter(args, 2)) {
            const row = store.bets.get(id);
            if (row) { row.bet_status_id = args[0]; row.settled_block = args[1]; }
        }
        return [];
    }
    if (/^SELECT (bet_)?action_index FROM bet_statuses WHERE action_index=\? AND bet_action_index(=\?| IN \()/.test(q)) {
        const want = new Set(idsAfter(args, 1));
        return store.statuses.filter(r => r.action_index === Number(args[0]) && want.has(r.bet_action_index))
            .map(r => ({ action_index: r.action_index, bet_action_index: r.bet_action_index }));
    }
    if (/^UPDATE bet_statuses SET status_id=\? WHERE action_index=\? AND bet_action_index(=\?| IN \()/.test(q)) {
        const want = new Set(idsAfter(args, 2));
        for (const r of store.statuses)
            if (r.action_index === Number(args[1]) && want.has(r.bet_action_index)) r.status_id = args[0];
        return [];
    }
    if (/^INSERT INTO bet_statuses \(status_id, action_index, bet_action_index\) values /.test(q)) {
        for (let i = 0; i < args.length; i += 3)
            store.statuses.push({ status_id: args[i], action_index: Number(args[i + 1]), bet_action_index: Number(args[i + 2]) });
        return [];
    }
    throw new Error('unexpected statement: ' + q);
}

// A Database double over a fresh store: `open` bets 1..n plus one prior history row.
function dbOver(n) {
    const store = { bets: new Map(), statuses: [{ status_id: STATUS_IDS.open, action_index: 900, bet_action_index: 2 }] };
    for (let id = 1; id <= n; id++) store.bets.set(id, { bet_status_id: STATUS_IDS.open, settled_block: null });
    const db = Object.assign({}, bets, {
        createStatus: sinon.stub().callsFake(async s => STATUS_IDS[s]),
        doQuery: sinon.stub().callsFake(async (sql, args) => applyStatement(store, sql, args)),
    });
    return { db, store };
}

// Run the per-bet writers BET_EXPIRE used before the batch, one bet at a time.
async function perBet(db, actionIndex, ids, status, block) {
    for (const id of ids) {
        await db.setBetSettled(id, status, block);
        await db.createBetStatus(actionIndex, id, status);
    }
}

describe('settleBetsBatch writes the same rows as the per-bet terminal writers @regression @tier1', function () {

    afterEach(() => sinon.restore());

    it('leaves identical bets and bet_statuses rows across several chunks, repeats and a prior row', async function () {
        const ids = [];
        for (let id = 1; id <= 1201; id++) ids.push(id);
        ids.push(5, 600);
        const a = dbOver(1201), b = dbOver(1201);
        // Bet 2 already has a history row under this action, so both paths must update it
        a.store.statuses.push({ status_id: STATUS_IDS.open, action_index: 950, bet_action_index: 2 });
        b.store.statuses.push({ status_id: STATUS_IDS.open, action_index: 950, bet_action_index: 2 });

        await perBet(a.db, 950, ids, 'refunded', 77);
        await terminalBatch.settleBetsBatch.call(b.db, 950, ids, 'refunded', 77);

        assert.deepStrictEqual([...b.store.bets.entries()], [...a.store.bets.entries()]);
        assert.deepStrictEqual(b.store.statuses, a.store.statuses);
        assert.strictEqual(b.store.statuses.filter(r => r.action_index === 950).length, 1201);
    });

    it('writes one history row for a bet repeated inside the same chunk', async function () {
        const a = dbOver(5), b = dbOver(5);

        await perBet(a.db, 950, [3, 4, 3], 'refunded', 77);
        await terminalBatch.settleBetsBatch.call(b.db, 950, [3, 4, 3], 'refunded', 77);

        assert.deepStrictEqual(b.store.statuses, a.store.statuses);
        assert.strictEqual(b.store.statuses.filter(r => r.action_index === 950).length, 2);
    });

    it('issues a bounded number of statements and resolves the status id once', async function () {
        const ids = [];
        for (let id = 1; id <= 1201; id++) ids.push(id);
        const { db } = dbOver(1201);

        await terminalBatch.settleBetsBatch.call(db, 950, ids, 'refunded', 77);

        sinon.assert.calledOnceWithExactly(db.createStatus, 'refunded');
        // Three chunks of at most 500, each an UPDATE, a SELECT and an INSERT
        assert.strictEqual(db.doQuery.callCount, 9);
        const updates = db.doQuery.args.filter(c => /^UPDATE bets/.test(c[0]));
        assert.deepStrictEqual(updates.map(c => c[1].length - 2), [500, 500, 201]);
    });

    it('writes nothing for an empty list', async function () {
        const { db } = dbOver(3);

        await terminalBatch.settleBetsBatch.call(db, 950, [], 'refunded', 77);

        sinon.assert.notCalled(db.doQuery);
        sinon.assert.notCalled(db.createStatus);
    });
});
