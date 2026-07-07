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
 * test/unit/rollback-coverage.test.js
 *
 * Rollback coverage guard.
 *
 * Every table the indexer owns is defined by a file in src/sql/ (that is the
 * exact set verifyTables() creates (table name = filename minus ".sql"). On a
 * chain reorg, Rollback.rollback() must do *something* deliberate with each of
 * those tables, or rows written in the orphaned block range survive and the
 * indexer DB silently diverges from chain truth (and from other validators).
 *
 * Historically tables shipped before they were wired into the rollback set.
 * e.g. gated_files (table 2026-05-22, rollback 2026-05-28, a 6-day window) and
 * slash_events (2-day window). Invisible on regtest; silent corruption on
 * mainnet. This test closes the *class*: a new src/sql/<table>.sql that nobody
 * classifies fails here instead of shipping.
 *
 * To satisfy this test, a new table needs ONE entry in the table-lifecycle
 * registry (src/tableLifecycle.js) declaring its replication, rollback, and
 * hash-coverage classification; the rollback buckets checked here (generic
 * lists, RECOMPUTED, SPECIAL_CASE, ROLLBACK_EXEMPT, inert lookups) are all
 * derived from that registry. Classify by understanding the table, not by
 * silencing the test; see the registry header for the field definitions.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { createMockIndexer } = require('../fixtures/mocks');
const Rollback              = require('../../src/rollback.js');
const lifecycle             = require('../../src/tableLifecycle.js');

// The universe: every table the indexer creates, straight from src/sql/.
// Mirrors db.js verifyTables() exactly (all *.sql, name = filename minus .sql).
const SQL_DIR = path.join(__dirname, '../../src/sql');
const UNIVERSE = fs.readdirSync(SQL_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(f => f.slice(0, -'.sql'.length))
    .sort();

// Rollback buckets and the orphan-sweep manifest, derived from the
// table-lifecycle registry (the single classification point). Per-table
// rationale lives with each registry entry.
const { RECOMPUTED, SPECIAL_CASE, ROLLBACK_EXEMPT } = lifecycle.rollbackBuckets();
const ORPHAN_SWEEPS = lifecycle.ORPHAN_SWEEPS;

// Convention: append-only, id-keyed dedup lookups. Orphaned rows are inert
// because data tables reference them only by id. EXCEPTION: index_addresses and
// index_tickers can be named by a wire ^<id> reference, so their ids ARE
// consensus-relevant and they are rolled back (rollback.indexTables); they must be
// asserted as covered, not silently exempted as inert lookups. Derived from the
// registry ('lookup' rollback mode) and cross-checked structurally below.
const LOOKUP_TABLES = new Set(lifecycle.tablesWhere(t => t.rollback === 'lookup'));
const isLookupTable = (t) => LOOKUP_TABLES.has(t);

describe('Rollback coverage guard @regression', function () {
    let rollback;

    before(function () {
        const indexer = createMockIndexer();
        indexer.protocolChanges = {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        };
        rollback = new Rollback(indexer);
    });

    it('sanity: src/sql contains a meaningful number of tables', function () {
        // Guards against a path/glob regression silently emptying the universe
        // and making every coverage assertion below vacuously pass.
        assert.ok(UNIVERSE.length > 50, `expected >50 tables in src/sql, found ${UNIVERSE.length}`);
    });

    it('every table the indexer owns is covered by the rollback strategy', function () {
        const covered = new Set([
            ...rollback.dataTables,
            ...rollback.blockTables,
            ...rollback.indexTables,
            ...RECOMPUTED,
            ...SPECIAL_CASE,
            ...Object.keys(ROLLBACK_EXEMPT),
        ]);

        const uncovered = UNIVERSE.filter(t => !covered.has(t) && !isLookupTable(t));

        assert.deepStrictEqual(
            uncovered,
            [],
            uncovered.length
                ? `\n\nThese src/sql tables are written by the indexer but NOT handled on reorg:\n` +
                  uncovered.map(t => `    - ${t}`).join('\n') +
                  `\n\nRows in these tables would survive a rollback and silently diverge from\n` +
                  `chain truth. Classify each into one of: dataTables / blockTables (rollback.js),\n` +
                  `RECOMPUTED / SPECIAL_CASE / ROLLBACK_EXEMPT (rollback-coverage.test.js).\n` +
                  `See the header of this file for what each bucket means.\n`
                : undefined
        );
    });

    it('every rollback.js table reference points at a real src/sql table (no stale/renamed names)', function () {
        const universeSet = new Set(UNIVERSE);
        const dangling = [...rollback.dataTables, ...rollback.blockTables, ...rollback.indexTables]
            .filter(t => !universeSet.has(t));

        assert.deepStrictEqual(
            dangling,
            [],
            dangling.length
                ? `rollback.js deletes from tables with no src/sql definition (typo or dropped table): ${dangling.join(', ')}. ` +
                  `A DELETE against a nonexistent table will throw and abort the whole rollback.`
                : undefined
        );
    });

    it('a table is never in both dataTables and blockTables', function () {
        const inBoth = rollback.dataTables.filter(t => rollback.blockTables.includes(t));
        assert.deepStrictEqual(
            inBoth,
            [],
            inBoth.length
                ? `Tables keyed by BOTH action_index and block_index deletes: ${inBoth.join(', ')}. ` +
                  `Pick one: a row has one or the other, and a double delete signals a modelling mistake.`
                : undefined
        );
    });

    it('every ROLLBACK_EXEMPT entry names a real table (the exempt list cannot rot)', function () {
        const universeSet = new Set(UNIVERSE);
        const stale = Object.keys(ROLLBACK_EXEMPT).filter(t => !universeSet.has(t));
        assert.deepStrictEqual(
            stale,
            [],
            stale.length
                ? `ROLLBACK_EXEMPT names tables that no longer exist in src/sql: ${stale.join(', ')}. Remove them.`
                : undefined
        );
    });

    // ── Table-lifecycle registry gates ──────────────────────────────────
    // The registry (src/tableLifecycle.js) is the single place a new table is
    // classified for replication, rollback, and hash coverage. These tests make
    // "forgot to classify" impossible in each direction.

    it('every src/sql table has a table-lifecycle registry entry', function () {
        const registered = new Set(lifecycle.allTables().filter(t => t.owner === 'indexer').map(t => t.table));
        const missing = UNIVERSE.filter(t => !registered.has(t));
        assert.deepStrictEqual(
            missing,
            [],
            missing.length
                ? `\n\nThese src/sql tables have NO entry in src/tableLifecycle.js:\n` +
                  missing.map(t => `    - ${t}`).join('\n') +
                  `\n\nEvery table must declare its replication, rollback, and hash-coverage\n` +
                  `lifecycle in the registry (see its header for field definitions), then be\n` +
                  `mirrored into the xchain-sync twin copy.\n`
                : undefined
        );
    });

    it('every indexer-owned registry entry names a real src/sql table (the registry cannot rot)', function () {
        const universeSet = new Set(UNIVERSE);
        const stale = lifecycle.allTables()
            .filter(t => t.owner === 'indexer' && !universeSet.has(t.table))
            .map(t => t.table);
        assert.deepStrictEqual(stale, [],
            stale.length ? `tableLifecycle.js entries with no src/sql definition (typo or dropped table): ${stale.join(', ')}` : undefined);
    });

    it('every registry entry declares all three lifecycle dimensions with valid values', function () {
        const REPLICATION = ['stream:action', 'stream:block', 'stream:index', 'stream:special',
            'snapshot', 'hub-mirror', 'local', 'follower-derived'];
        const ROLLBACK    = ['action', 'block', 'index', 'recomputed', 'special', 'exempt', 'lookup'];
        const REPLICA     = ['mirror', 'recomputed', 'special', 'exempt', 'lookup', 'local'];
        const HASH        = ['ledger', 'actions', 'contracts', 'state_hash', 'state_commitment', 'index_map', 'quorum'];
        const problems = [];
        for (const t of lifecycle.allTables()) {
            if (!REPLICATION.includes(t.replication))
                problems.push(`${t.table}: invalid replication '${t.replication}'`);
            if (t.owner === 'indexer' ? !ROLLBACK.includes(t.rollback) : t.rollback !== null)
                problems.push(`${t.table}: invalid rollback '${t.rollback}' for owner '${t.owner}'`);
            if (!REPLICA.includes(t.replicaRollback))
                problems.push(`${t.table}: invalid replicaRollback '${t.replicaRollback}'`);
            if (!t.hashed || !Array.isArray(t.hashed.classes))
                problems.push(`${t.table}: hashed.classes missing`);
            else {
                for (const c of t.hashed.classes)
                    if (!HASH.includes(c)) problems.push(`${t.table}: unknown hash class '${c}'`);
                // A table with no hash class must SAY why (derived / operational /
                // quorum-covered); that declaration is the whole point of the dimension.
                if (t.hashed.classes.length === 0 && !(t.hashed.note && t.hashed.note.length > 10))
                    problems.push(`${t.table}: empty hashed.classes without a substantive note`);
            }
            if (t.rollback === 'exempt' && !(t.note && t.note.length > 20))
                problems.push(`${t.table}: rollback 'exempt' requires a substantive note (why is never rolling back safe?)`);
        }
        assert.deepStrictEqual(problems, [], problems.join('\n'));
    });

    it('registry lookup entries follow the index_ naming convention (inertness relies on it)', function () {
        const offenders = lifecycle.tablesWhere(t => t.rollback === 'lookup' && !t.table.startsWith('index_'));
        assert.deepStrictEqual(offenders, [],
            `Non-index_* tables classified as inert lookups: ${offenders.join(', ')}. ` +
            `The inert-lookup argument (ids only ever referenced by id, never hashed) is a ` +
            `property of the dedup lookup tables; anything else needs a real rollback mode.`);
    });

    it('every orphan-sweep DELETE classified in SPECIAL_CASE actually exists in rollback.js', function () {
        // A derived/cache table that dangles after the index-table delete is only
        // covered if rollback.js actually sweeps it. Without this, the SPECIAL_CASE
        // classification could silently outlive a removed sweep (the very failure
        // that re-opened the orphaned-only-address zombie balance), so assert the
        // `DELETE FROM <table> ... NOT IN (SELECT id FROM <index>)` is present in source.
        const src = fs.readFileSync(path.join(__dirname, '../../src/rollback.js'), 'utf8');
        const missing = ORPHAN_SWEEPS.filter(({ table, index }) => {
            const re = new RegExp(`DELETE\\s+FROM\\s+${table}\\b[\\s\\S]{0,400}?SELECT\\s+id\\s+FROM\\s+${index}\\b`, 'i');
            return !re.test(src);
        }).map(({ table, index }) => `${table} (NOT IN ${index})`);

        assert.deepStrictEqual(
            missing,
            [],
            missing.length
                ? `rollback.js is missing orphan-sweep DELETE(s): ${missing.join(', ')}. ` +
                  `These tables reference a rolled-back index id but are not action/block deleted, ` +
                  `so without the sweep an orphaned-only entity leaves a dangling-ref row that ` +
                  `diverges from a from-genesis node (zombie balance -> sanityCheck halt; ` +
                  `markets/pubkeys mis-association on id reuse). Restore the sweep or re-justify ` +
                  `the SPECIAL_CASE entry.`
                : undefined
        );
    });
});
