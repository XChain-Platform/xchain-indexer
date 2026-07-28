'use strict';

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
 * Integration tests: characterization of the expiry-sweep SQL push-down.
 *
 * . db.getExpiredItems used to fetch the ENTIRE open order/swap/dispenser
 * book every block, resolve the edits overlay with a second batched query per
 * type, and apply the expiration cut in JS. The cut now lives in SQL, so only
 * the rows actually expiring this block come back.
 *
 * Expiry firing is consensus state: an item that expires one block early or
 * late, or never, changes the ledger. So this suite does NOT assert a
 * hand-written expectation. It runs the VERBATIM pre-push-down implementation
 * (legacyGetExpiredItems below) and the current one against the SAME populated
 * database over a sweep of block times and asserts the results are identical,
 * element for element.
 *
 * The trap this pins down: all six `expiration` columns (orders/swaps/dispensers
 * and their `_edits`) are nullable. The legacy JS predicate `expiration <
 * block_time` coerced a null to 0, so a null effective expiration expired on the
 * first block that swept it. A naive SQL `eff_expiration < ?` evaluates to NULL
 * for those rows, drops them, and that item would NEVER expire. The seed data
 * below therefore includes null base expirations, null edit expirations, and a
 * null edit layered on top of a non-null one.
 *
 * Venue: real MariaDB, indexer schema built by verifyTables(). No chain access.
 */

const assert = require('assert');
const {
    createDatabases, closeAll,
} = require('../setup/db-connection');
const { initIndexer, destroyIndexer } = require('../setup/indexer-launcher');

let indexer;
let db;

// index_statuses ids, resolved in before()
let OPEN_ID, EXPIRED_ID, CANCELLED_ID, VALID_ID, INVALID_ID;

const TYPES = ['order', 'swap', 'dispenser'];

// Per-type action_index bases. Item indexes stay globally unique across types so
// the UNION's `ORDER BY action_index ASC` has a total order to produce.
const ITEM_BASE   = { order: 1000, swap: 1100, dispenser: 1200 };
const STATUS_BASE = { order: 2000, swap: 2100, dispenser: 2200 };
const EDIT_BASE   = { order: 3000, swap: 3100, dispenser: 3200 };

/**
 * The pre- implementation, copied verbatim from src/db.js so the
 * characterization compares against the real prior behaviour rather than a
 * paraphrase of it. Only `this` was rebound to an explicit db argument.
 */
async function legacyGetExpiredItems(db, block_time) {
    let expired = [];
    let types   = ['order','swap','dispenser'];
    let query   = '';
    let args    = [];
    // Build out the query for each of the table types to get 'open' items
    for(let type of types){
        if(query!='')
            query += 'UNION ';
        query += `SELECT
                    m.action_index,
                    m.expiration,
                    '` + type + `' as type
                FROM
                    ` + type + `s m
                    INNER JOIN ` + type + `_statuses s1 ON (s1.` + type + `_action_index=m.action_index)
                    INNER JOIN index_statuses        s2 ON (s2.id=s1.status_id)
                WHERE
                    s1.action_index = (
                        SELECT
                            MAX(s3.action_index)
                        FROM
                            ` + type + `_statuses s3
                        WHERE
                            s3.` + type + `_action_index=m.action_index
                    ) AND
                    s2.status='open'`;
    }
    query += ' ORDER BY action_index ASC';
    let results = await db.doQuery(query, args);
    if(results.length > 0){
        let byType = {};
        for(let info of results){
            if(!byType[info.type])
                byType[info.type] = [];
            byType[info.type].push(info);
        }
        for(let type of Object.keys(byType)){
            let items        = byType[type];
            let placeholders = items.map(() => '?').join(',');
            query  = `SELECT
                        s1.` + type + `_action_index as item_action_index,
                        s1.expiration
                    FROM
                        ` + type + `_edits s1
                        INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.` + type + `_action_index IN (` + placeholders + `) AND
                        s2.status=?
                    ORDER BY
                        s1.action_index ASC`;
            args         = items.map(i => i.action_index).concat(['valid']);
            let results2 = await db.doQuery(query, args);
            if(results2.length > 0){
                let latest = {};
                for(let row of results2){
                    if(!db.util.isNull(row.expiration))
                        latest[row.item_action_index] = row.expiration;
                }
                for(let info of items){
                    if(latest[info.action_index] !== undefined)
                        info.expiration = latest[info.action_index];
                }
            }
        }
        for(let info of results){
            if(info.expiration < block_time){
                expired.push({
                    type:         info.type,
                    action_index: Number(info.action_index),
                    expiration:   Number(info.expiration)
                });
            }
        }
    }
    return expired;
}

/** Insert one base item row (only the columns the sweep reads). */
async function seedItem(type, offset, expiration) {
    const action_index = ITEM_BASE[type] + offset;
    await db.doQuery(
        `INSERT INTO ${type}s (action_index, expiration, status_id) VALUES (?, ?, ?)`,
        [action_index, expiration, OPEN_ID]
    );
    return action_index;
}

/** Append a status row; the HIGHEST status action_index is the latest status. */
let statusSeq = {};
async function seedStatus(type, item_action_index, status_id) {
    statusSeq[type] = (statusSeq[type] || 0) + 1;
    await db.doQuery(
        `INSERT INTO ${type}_statuses (action_index, ${type}_action_index, status_id) VALUES (?, ?, ?)`,
        [STATUS_BASE[type] + statusSeq[type], item_action_index, status_id]
    );
}

/** Append an edit row; the HIGHEST edit action_index is the newest edit. */
let editSeq = {};
async function seedEdit(type, item_action_index, expiration, status_id) {
    editSeq[type] = (editSeq[type] || 0) + 1;
    await db.doQuery(
        `INSERT INTO ${type}_edits (action_index, ${type}_action_index, expiration, status_id) VALUES (?, ?, ?, ?)`,
        [EDIT_BASE[type] + editSeq[type], item_action_index, expiration, status_id]
    );
}

/**
 * Seed the same twelve-case book for every item type. Cases are keyed by their
 * per-type offset so a failure names the shape that diverged.
 */
const CASES = {
    0:  'base 1000, no edits',
    1:  'base 1000, valid edit extends to 3000',
    2:  'base 3000, valid edit shortens to 1000',
    3:  'base 1000, valid edit with NULL expiration (leave unchanged)',
    4:  'base 1000, INVALID edit to 5000 (ignored)',
    5:  'base NULL, no edits',
    6:  'base NULL, valid edit sets 2000',
    7:  'base 1000, two valid edits, newest (1500) wins over older (5000)',
    8:  'base 1000, latest status expired (not open)',
    9:  'base 1000, latest status cancelled (not open)',
    10: 'base 2000, no edits (exact cutoff boundary)',
    11: 'base 1000, valid edit 4000 then a NULL-expiration valid edit on top',
};

async function seedBook(type) {
    let ai;

    ai = await seedItem(type, 0, 1000);
    await seedStatus(type, ai, OPEN_ID);

    ai = await seedItem(type, 1, 1000);
    await seedStatus(type, ai, OPEN_ID);
    await seedEdit(type, ai, 3000, VALID_ID);

    ai = await seedItem(type, 2, 3000);
    await seedStatus(type, ai, OPEN_ID);
    await seedEdit(type, ai, 1000, VALID_ID);

    ai = await seedItem(type, 3, 1000);
    await seedStatus(type, ai, OPEN_ID);
    await seedEdit(type, ai, null, VALID_ID);

    ai = await seedItem(type, 4, 1000);
    await seedStatus(type, ai, OPEN_ID);
    await seedEdit(type, ai, 5000, INVALID_ID);

    ai = await seedItem(type, 5, null);
    await seedStatus(type, ai, OPEN_ID);

    ai = await seedItem(type, 6, null);
    await seedStatus(type, ai, OPEN_ID);
    await seedEdit(type, ai, 2000, VALID_ID);

    ai = await seedItem(type, 7, 1000);
    await seedStatus(type, ai, OPEN_ID);
    await seedEdit(type, ai, 5000, VALID_ID);
    await seedEdit(type, ai, 1500, VALID_ID);

    ai = await seedItem(type, 8, 1000);
    await seedStatus(type, ai, OPEN_ID);
    await seedStatus(type, ai, EXPIRED_ID);

    ai = await seedItem(type, 9, 1000);
    await seedStatus(type, ai, OPEN_ID);
    await seedStatus(type, ai, CANCELLED_ID);

    ai = await seedItem(type, 10, 2000);
    await seedStatus(type, ai, OPEN_ID);

    ai = await seedItem(type, 11, 1000);
    await seedStatus(type, ai, OPEN_ID);
    await seedEdit(type, ai, 4000, VALID_ID);
    await seedEdit(type, ai, null, VALID_ID);
}

/** Human-readable label for an action_index, for assertion messages. */
function label(action_index) {
    for (const type of TYPES) {
        const offset = action_index - ITEM_BASE[type];
        if (offset >= 0 && offset < 12)
            return `${type} #${action_index} (${CASES[offset]})`;
    }
    return `#${action_index}`;
}

/** True when an action_index belongs to this suite's seeded book. */
function isOurs(action_index) {
    return TYPES.some(type => {
        const offset = action_index - ITEM_BASE[type];
        return offset >= 0 && offset < 12;
    });
}

/** Drop only this suite's rows, so re-runs and shared-database runs are clean. */
async function clearBook(type) {
    const lo = ITEM_BASE[type], hi = lo + 99;
    await db.doQuery(`DELETE FROM ${type}s WHERE action_index BETWEEN ? AND ?`, [lo, hi]);
    await db.doQuery(`DELETE FROM ${type}_statuses WHERE ${type}_action_index BETWEEN ? AND ?`, [lo, hi]);
    await db.doQuery(`DELETE FROM ${type}_edits WHERE ${type}_action_index BETWEEN ? AND ?`, [lo, hi]);
}

before(async function () {
    this.timeout(60000);
    await createDatabases();
    indexer = await initIndexer();
    db = indexer.indexerDb;
});

after(async function () {
    await destroyIndexer(indexer);
    await closeAll();
});

describe('27 Expiry-sweep push-down characterization @regression @tier2', function () {
    this.timeout(60000);

    // Seed at suite level, not in a root hook: every scenario file's root hooks
    // run before ANY test, and several of them reset the indexer database, so a
    // root-level seed would be wiped in a whole-directory run. Only this suite's
    // action_index ranges are touched, so residue from other scenarios is left
    // alone (the legacy/current comparison spans the whole book either way).
    before(async function () {
        this.timeout(60000);
        OPEN_ID      = await db.createStatus('open');
        EXPIRED_ID   = await db.createStatus('expired');
        CANCELLED_ID = await db.createStatus('cancelled');
        VALID_ID     = await db.createStatus('valid');
        INVALID_ID   = await db.createStatus('invalid');
        statusSeq = {};
        editSeq   = {};
        for (const type of TYPES) {
            await clearBook(type);
            await seedBook(type);
        }
    });

    // Straddles every expiration in the seed book, both sides of each boundary,
    // plus the degenerate 0 case (where a null expiration must NOT expire,
    // because the legacy predicate compared the coerced 0 against 0).
    const BLOCK_TIMES = [
        0, 1, 999, 1000, 1001, 1499, 1500, 1501,
        1999, 2000, 2001, 2999, 3000, 3001, 4000, 5000, 9999999,
    ];

    it('matches the pre-push-down implementation at every block time', async function () {
        for (const block_time of BLOCK_TIMES) {
            const legacy  = await legacyGetExpiredItems(db, block_time);
            const current = await db.getExpiredItems(block_time);
            assert.deepStrictEqual(
                current,
                legacy,
                `divergence at block_time=${block_time}\n` +
                `  legacy : ${legacy.map(r => label(r.action_index)).join(', ') || '(none)'}\n` +
                `  current: ${current.map(r => label(r.action_index)).join(', ') || '(none)'}`
            );
        }
    });

    // Guards against a vacuous pass: if the seed book expired nothing (or
    // everything) at every block time, the comparison above proves nothing.
    it('the seed book actually exercises both sides of the cut', async function () {
        const counts = [];
        for (const block_time of BLOCK_TIMES) {
            const rows = await db.getExpiredItems(block_time);
            counts.push(rows.filter(r => isOurs(r.action_index)).length);
        }
        const openItems = 3 * 10; // 12 cases per type, 2 of which are not 'open'
        assert.strictEqual(Math.min(...counts), 0, 'some block time must expire nothing');
        assert.strictEqual(Math.max(...counts), openItems, 'the last block time must expire the whole open book');
        assert.ok(new Set(counts).size > 3, 'the cut must move across the sweep, not jump once');
    });

    // The consensus trap, stated directly rather than only implied by the
    // legacy comparison: a null effective expiration expires, it does not
    // survive forever. Cases 5 (null base) and 3/11 (null edit over a base)
    // are the ones at risk from a bare `eff_expiration < ?`.
    it('expires items whose effective expiration is NULL', async function () {
        const expired = await db.getExpiredItems(9999999);
        for (const type of TYPES) {
            const row = expired.find(r => r.action_index === ITEM_BASE[type] + 5);
            assert.ok(row, `${type} with a NULL base expiration must expire, not survive forever`);
            assert.strictEqual(row.expiration, 0, 'a NULL expiration is reported as 0');
        }
    });

    // A null edit means "leave the expiration unchanged", so it must not blank
    // out an expiration set by an earlier edit or by the base row.
    it('a NULL edit expiration does not erase the effective expiration', async function () {
        // At 3999 the base-1000 item edited to 4000 (case 11, with a null edit
        // layered on top) is NOT yet expired; at 4001 it is.
        for (const type of TYPES) {
            const ai = ITEM_BASE[type] + 11;
            const before = await db.getExpiredItems(3999);
            const after  = await db.getExpiredItems(4001);
            assert.ok(!before.some(r => r.action_index === ai), `${label(ai)} must not expire before 4000`);
            const row = after.find(r => r.action_index === ai);
            assert.ok(row, `${label(ai)} must expire after 4000`);
            assert.strictEqual(row.expiration, 4000);
        }
    });

    it('returns rows in ascending action_index order', async function () {
        const expired = await db.getExpiredItems(9999999);
        const indexes = expired.map(r => r.action_index);
        assert.deepStrictEqual(indexes, [...indexes].sort((a, b) => a - b));
        assert.ok(indexes.length > 0, 'nothing expired, so the ordering claim is vacuous');
    });

    // The push-down's reason for existing: the sweep must not drag the whole
    // open book back to the client. One round trip, and only expiring rows.
    it('is a single round trip that returns only the expiring rows', async function () {
        const calls = [];
        const realDoQuery = db.doQuery.bind(db);
        db.doQuery = async function (sql, args) {
            calls.push(sql);
            return realDoQuery(sql, args);
        };
        try {
            const expired = await db.getExpiredItems(1001);
            assert.strictEqual(calls.length, 1, 'the sweep must issue exactly one query');
            // Only the rows past their cut come back, not the whole open book.
            const legacy = await legacyGetExpiredItems(db, 1001);
            assert.strictEqual(expired.length, legacy.length);
            const ours = expired.filter(r => isOurs(r.action_index)).length;
            assert.ok(ours > 0 && ours < 30,
                'the block time must be a partial cut for this assertion to mean anything');
        } finally {
            delete db.doQuery;
        }
    });
});
