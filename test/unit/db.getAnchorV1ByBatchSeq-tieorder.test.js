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
 * test/unit/db.getAnchorV1ByBatchSeq-tieorder.test.js
 *
 * CONSENSUS REGRESSION GUARD for db.getAnchorV1ByBatchSeq() head-selection determinism.
 *
 * match_batch_seq is NOT unique on anchor_actions: the replay guard in anchor.js
 * _parseCheckpoint accepts an EQUAL MATCH_BATCH_SEQ, so a permissionless re-broadcast or a
 * failover double-publish stores a SECOND v1/v6 row for the same batch. The returned parent
 * feeds a consensus-visible verdict in anchor.js _parseContinuation (TOTAL_CHUNKS geometry
 * gate + batch_crc32 reassembly, which stamps setAnchorArchiveStatus(parent.action_index,
 * 'invalid_archive')). The pre-fix query was `... match_batch_seq = ? LIMIT 1` with NO
 * ORDER BY, so two honest nodes could select different parents and persist divergent
 * anchor_actions status fleet-wide (same failure class as the getBlockHashes tie-order fork).
 *
 * The intended rule (PINNED here): pick the EARLIEST head - the anchor that actually STARTED
 * the batch - i.e. `ORDER BY action_index ASC LIMIT 1`. This is deliberately the OPPOSITE of
 * selectAnchorRow()'s 'highest action_index = newest supersedes' (a different, RPC-status
 * question), and it matches the 'lowest action_index wins' tie-break the v2-continuation
 * dedup uses. action_index is consensus-visible and unique on this single-network table;
 * ordering on the local AUTO_INCREMENT id would reintroduce per-node divergence.
 *
 * Technique mirrors db.getBlockHashes-tieorder.test.js: stub doQuery on a real Database so the
 * live query string runs, model the DB by applying the query's OWN trailing ORDER BY (column +
 * direction) to scrambled rows, and assert the earliest head wins. A negative control (the
 * pre-fix no-ORDER-BY query leaves scramble order intact and returns the wrong head) proves
 * the test has teeth.
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

// The raw trailing ORDER BY clause of a query (column + direction), or '' if none.
function orderClause(sql) {
    const idx = sql.toUpperCase().lastIndexOf('ORDER BY');
    if (idx < 0) return '';
    return sql.slice(idx + 'ORDER BY'.length).split(/;|\bLIMIT\b/i)[0].trim();
}

// Model MySQL honoring a single-column ORDER BY (col [ASC|DESC]) numerically. An empty clause
// leaves the injected scramble order intact - exactly what the pre-fix query did.
function applyOrder(rows, clause) {
    if (!clause) return rows.slice();
    const [rawCol, dir] = clause.split(/\s+/);
    const col  = rawCol.replace(/^[A-Za-z0-9_]+\./, '');
    const sign = /DESC/i.test(dir || '') ? -1 : 1;
    return rows.slice().sort((a, b) => sign * (Number(a[col]) - Number(b[col])));
}

afterEach(function () { sinon.restore(); });

describe('Database.getAnchorV1ByBatchSeq() head-selection determinism @regression @tier1', function () {

    // Two v1 rows sharing match_batch_seq 42 (a failover double-publish), injected HIGH-first so
    // insertion order alone would return the wrong (later) head. action_index 5 is canonical.
    const dupRows = [
        { action_index: 9, match_batch_seq: 42, version: 1, total_chunks: 4, batch_crc32: 'bbbb' },
        { action_index: 5, match_batch_seq: 42, version: 1, total_chunks: 3, batch_crc32: 'aaaa' }
    ];

    it('requests a deterministic total order on action_index ASC with LIMIT 1', async function () {
        const db = makeDb();
        let captured = null;
        sinon.stub(db, 'doQuery').callsFake(async (sql) => { captured = sql; return []; });
        await db.getAnchorV1ByBatchSeq(42);
        // The alias is optional in the pattern only because #3075 joined actions in (both
        // tables have an action_index column, so the ORDER BY has to qualify it now).
        assert.match(captured, /ORDER BY\s+(?:[A-Za-z0-9_]+\.)?action_index\s+ASC/i,
            'head selection must ORDER BY action_index ASC (canonical/earliest head)');
        assert.match(captured, /LIMIT\s+1/i);
        // Must NOT order on the local AUTO_INCREMENT surrogate (per-node divergent).
        assert.doesNotMatch(orderClause(captured), /\bid\b/i);
    });

    // #3075: the head row must carry its AUTHOR, because anchor.js binds every v2
    // continuation chunk to it. The address is resolved through actions.source_id
    // (authoritative for auth) - anchor_actions has no source column of its own, and its
    // `publisher` column is the v4/v5/v6 elected-PUBLISHER pubkey, a different thing.
    it('resolves the head AUTHOR through actions.source_id as `source` (#3075)', async function () {
        const db = makeDb();
        let captured = null;
        sinon.stub(db, 'doQuery').callsFake(async (sql) => { captured = sql; return []; });
        await db.getAnchorV1ByBatchSeq(42);
        assert.match(captured, /index_addresses/i, 'the author must come from index_addresses');
        assert.match(captured, /source_id/i,       'joined on actions.source_id, never re-derived from the tx');
        assert.match(captured, /AS\s+source/i,     'anchor.js reads parent.source');
        assert.doesNotMatch(captured, /a\.publisher\b/i,
            'publisher is the elected-PUBLISHER pubkey (v4/v5/v6 tail), not the author');
    });

    // The join must not be able to change WHICH head is selected: an inner join would
    // skip a head whose action linkage is missing and silently pick the NEXT one, moving
    // a consensus-visible geometry verdict (TOTAL_CHUNKS) and the authorship rule with it.
    // An unresolvable author must arrive as null instead, which anchor.js fails closed on.
    it('joins the author LEFT so the head PICK stays byte-identical to pre-#3075', async function () {
        const db = makeDb();
        let captured = null;
        sinon.stub(db, 'doQuery').callsFake(async (sql) => { captured = sql; return []; });
        await db.getAnchorV1ByBatchSeq(42);
        const joins = captured.match(/\b(LEFT\s+JOIN|INNER\s+JOIN|(?<!LEFT\s)(?<!OUTER\s)JOIN)\b/gi) || [];
        assert.ok(joins.length > 0, 'the author has to be joined in from somewhere');
        for (const j of joins)
            assert.match(j, /LEFT\s+JOIN/i,
                'every join on the head-selection query must be LEFT (author resolution must never filter the pick)');
    });

    it('returns the EARLIEST head (lowest action_index) when a batch_seq is duplicated', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').callsFake(async (sql) => applyOrder(dupRows, orderClause(sql)).slice(0, 1));
        const head = await db.getAnchorV1ByBatchSeq(42);
        assert.strictEqual(head.action_index, 5, 'canonical head is the batch starter (lowest action_index)');
        assert.strictEqual(head.batch_crc32, 'aaaa');
    });

    // Teeth: the pre-fix query (no ORDER BY) leaves the HIGH-first scramble intact and returns
    // the wrong head, so the assertion above genuinely depends on the fix.
    it('negative control: an un-ordered query would return the wrong (later) head', function () {
        const wrong = applyOrder(dupRows, '' /* pre-fix: no ORDER BY */)[0];
        assert.strictEqual(wrong.action_index, 9);
    });

    // ── : publisher-scoped head pick ───────────────────────────────────────
    // With an author supplied the candidate set narrows to that publisher's heads, so a
    // junk head squatting the batch seq is the head of its own batch and of nothing
    // else. Everything that made the pick deterministic must survive the narrowing.
    describe('author-scoped pick ', function () {

        it('binds the author as a parameter and keeps the deterministic order', async function () {
            const db = makeDb();
            let captured = null, args = null;
            sinon.stub(db, 'doQuery').callsFake(async (sql, params) => { captured = sql; args = params; return []; });
            await db.getAnchorV1ByBatchSeq(42, 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH');
            assert.match(captured, /adr\.address\s*=\s*\?/i, 'the author must be a bound parameter, never inlined');
            assert.deepStrictEqual(args, [42, 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH']);
            assert.match(captured, /ORDER BY\s+(?:[A-Za-z0-9_]+\.)?action_index\s+ASC/i);
            assert.match(captured, /LIMIT\s+1/i);
            const joins = captured.match(/\b(LEFT\s+JOIN|INNER\s+JOIN|(?<!LEFT\s)(?<!OUTER\s)JOIN)\b/gi) || [];
            for (const j of joins) assert.match(j, /LEFT\s+JOIN/i);
        });

        it('adds NOTHING to the query when no author is supplied (inert below the flag day)', async function () {
            const db = makeDb();
            let captured = null, args = null;
            sinon.stub(db, 'doQuery').callsFake(async (sql, params) => { captured = sql; args = params; return []; });
            await db.getAnchorV1ByBatchSeq(42);
            assert.doesNotMatch(captured, /adr\.address\s*=/i,
                'the legacy canonical-head pick must not gain an authorship predicate');
            assert.deepStrictEqual(args, [42]);
        });

        it('returns the earliest head OF THAT AUTHOR, not the earliest head overall', async function () {
            // Rows as MariaDB would return them for the narrowed predicate: the junk head
            // (action_index 1, another author) is not a candidate at all.
            const db = makeDb();
            sinon.stub(db, 'doQuery').callsFake(async (sql, params) => {
                const rows = [
                    { action_index: 1, source: 'OUTSIDER', batch_crc32: 'junk' },
                    { action_index: 5, source: 'PUBLISHER', batch_crc32: 'aaaa' },
                    { action_index: 9, source: 'PUBLISHER', batch_crc32: 'bbbb' }
                ].filter(r => /adr\.address\s*=\s*\?/i.test(sql) ? r.source === params[1] : true);
                return applyOrder(rows, orderClause(sql)).slice(0, 1);
            });
            const head = await db.getAnchorV1ByBatchSeq(42, 'PUBLISHER');
            assert.strictEqual(head.action_index, 5);
            assert.strictEqual(head.batch_crc32, 'aaaa');
            const captured = await db.getAnchorV1ByBatchSeq(42);
            assert.strictEqual(captured.action_index, 1, 'unscoped, the junk head is still the canonical head');
        });
    });
});
