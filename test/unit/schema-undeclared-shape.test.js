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
 * The OTHER half of startup drift detection.
 *
 * The reconciler converges the SQL source ONTO the database: it adds a declared
 * column or index that is missing live. It has never looked the other way, so a
 * column or index that exists ONLY live is invisible on every boot. That is how
 * DOGE regtest ran for months carrying a pre-fence state_checkpoints key and 8
 * signed mirror-twin columns - a shape no other DB in the fleet had - until a
 * hand audit found it and a seven-file migration backlog converged it.
 *
 * These tests pin the detection, not a heal: dropping a column or index we did
 * not create is never safe unattended (same never-DROP posture as the index
 * name-collision branch), so the contract is that the drift is REPORTED, loudly,
 * on the boot log of every DB that carries it, and that a clean DB reports
 * nothing so the signal stays readable.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../src/db');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');

// Minimal harness over the real src/sql sources: the reconcilers need `dbName`, the
// parsers, and a `db` with query(). Live columns/index rows are the fixture.
function makeCtx(extra) {
    return Object.assign({
        dbName: 'xchain_test',
        stripSqlLineComments:   Database.prototype.stripSqlLineComments,
        parseExpectedColumns:   Database.prototype.parseExpectedColumns,
        parseExpectedIndexes:   Database.prototype.parseExpectedIndexes,
        parseInlineIndexes:     Database.prototype.parseInlineIndexes,
        undeclaredLiveColumns:  Database.prototype.undeclaredLiveColumns,
        undeclaredLiveIndexes:  Database.prototype.undeclaredLiveIndexes,
        dedupeForUniqueIndex:   async () => false,
    }, extra || {});
}

// Capture console.warn/log for the assertion, and keep the ALTERs the reconciler issued.
async function runColumns(table, liveColumns, ctxExtra) {
    const ctx    = makeCtx(ctxExtra);
    const alters = [];
    const db = {
        query: async (sql) => {
            if (/^ALTER TABLE/i.test(sql)) { alters.push(sql); return []; }
            if (/information_schema\.columns/i.test(sql)) {
                return liveColumns.map(name => ({
                    COLUMN_NAME: name, IS_NULLABLE: 'YES', COLUMN_TYPE: 'varchar(256)',
                    COLUMN_KEY: '', EXTRA: '', COLUMN_DEFAULT: null, COLLATION_NAME: null,
                    COLUMN_COMMENT: '', GENERATION_EXPRESSION: '',
                }));
            }
            return [];
        },
    };
    const warns = [];
    const orig  = { warn: console.warn, log: console.log };
    console.warn = (m) => warns.push(String(m));
    console.log  = () => {};
    try { await Database.prototype.alterTableForDrift.call(ctx, table + '.sql', db); }
    finally { console.warn = orig.warn; console.log = orig.log; }
    return { warns, alters, ctx };
}

// Build information_schema.statistics rows for a set of live indexes.
function statisticsRows(indexes) {
    const rows = [];
    for (const idx of indexes) {
        idx.columns.forEach((col, i) => rows.push({
            INDEX_NAME: idx.name, NON_UNIQUE: idx.unique ? 0 : 1,
            INDEX_TYPE: idx.fulltext ? 'FULLTEXT' : 'BTREE',
            COLUMN_NAME: col, SEQ_IN_INDEX: i + 1, SUB_PART: idx.prefixes ? idx.prefixes[i] : null,
        }));
    }
    return rows;
}

async function runIndexes(table, liveIndexes, ctxExtra) {
    const ctx    = makeCtx(ctxExtra);
    const alters = [];
    const db = {
        query: async (sql) => {
            if (/^ALTER TABLE/i.test(sql)) { alters.push(sql); return []; }
            if (/information_schema\.statistics/i.test(sql)) return statisticsRows(liveIndexes);
            return [];
        },
    };
    const warns = [];
    const orig  = { warn: console.warn, log: console.log };
    console.warn = (m) => warns.push(String(m));
    console.log  = () => {};
    try { await Database.prototype.reconcileTableIndexes.call(ctx, table + '.sql', db); }
    finally { console.warn = orig.warn; console.log = orig.log; }
    return { warns, alters, ctx };
}

// The full declared shape of a table, straight off its real definition file: every
// inline key plus every standalone CREATE INDEX. It builds a CLEAN live table, so
// the no-false-positive cases are driven by the sources rather than by a hand list.
function declaredIndexes(table) {
    const ctx = makeCtx();
    const raw = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    return ctx.parseExpectedIndexes.call(ctx, raw, table)
        .concat(ctx.parseInlineIndexes.call(ctx, raw, table))
        .filter(i => i.name)
        .map(i => ({ name: i.name, columns: i.columns, unique: !!i.unique, fulltext: !!i.fulltext }));
}

function declaredColumns(table) {
    const ctx = makeCtx();
    const raw = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    return ctx.parseExpectedColumns.call(ctx, raw).map(c => c.name);
}

describe('startup drift detection sees shape the SQL source does NOT declare @regression', function () {

    describe('columns', function () {

        it('reports a live column no source declares (the signed mirror-twin shape)', async function () {
            // An aged state_checkpoints that also carries two signed twin columns from a
            // superseded mirror wire. Nothing in state_checkpoints.sql names them.
            const live = declaredColumns('state_checkpoints').concat(['signed_ledger_hash', 'signed_state_root']);
            const { warns, alters } = await runColumns('state_checkpoints', live);
            const hit = warns.find(w => /Schema shape drift on state_checkpoints/.test(w));
            assert.ok(hit, 'undeclared live columns must be reported; warnings were: ' + JSON.stringify(warns));
            assert.ok(/signed_ledger_hash/.test(hit) && /signed_state_root/.test(hit),
                'the report must name every undeclared column: ' + hit);
            // Detection only: never a DROP of a column we did not create.
            assert.deepStrictEqual(alters.filter(q => /DROP\s+COLUMN/i.test(q)), [],
                'the reconciler must never drop a column it did not create');
        });

        it('a table matching its source reports nothing', async function () {
            const { warns } = await runColumns('state_checkpoints', declaredColumns('state_checkpoints'));
            assert.deepStrictEqual(warns.filter(w => /Schema shape drift/.test(w)), [],
                'a clean table must stay silent or the signal is unreadable');
        });

        it('matches declared columns case-insensitively', async function () {
            const live = declaredColumns('state_checkpoints').map(c => c.toUpperCase());
            const { warns } = await runColumns('state_checkpoints', live);
            assert.deepStrictEqual(warns.filter(w => /Schema shape drift/.test(w)), [],
                'MariaDB column names are case-insensitive; an upper-cased live name is not drift');
        });
    });

    describe('indexes', function () {

        it('reports the pre-fence state_checkpoints key (declared nowhere, added by nothing)', async function () {
            // The real shape: the definition narrowed uq_chain_seq to
            // (chain, network, checkpoint_seq); the older, wider UNIQUE key stayed live.
            const live = declaredIndexes('state_checkpoints').concat([{
                name: 'uq_chain_net_block_seq', unique: true, fulltext: false,
                columns: ['chain', 'network', 'block_index', 'checkpoint_seq'],
            }]);
            const { warns, alters } = await runIndexes('state_checkpoints', live);
            const hit = warns.find(w => /Schema shape drift on state_checkpoints/.test(w));
            assert.ok(hit, 'the undeclared wider key must be reported; warnings were: ' + JSON.stringify(warns));
            assert.ok(/uq_chain_net_block_seq/.test(hit), 'the report must name the index: ' + hit);
            assert.ok(/chain,network,block_index,checkpoint_seq/.test(hit),
                'the report must name the column set so it can be matched against the fleet: ' + hit);
            assert.deepStrictEqual(alters.filter(q => /DROP\s+(INDEX|KEY)/i.test(q)), [],
                'the reconciler must never drop an index it did not create');
        });

        it('an inline KEY declared in the CREATE TABLE block is NOT an orphan', async function () {
            // idx_checkpoint_seq and the PRIMARY key are declared inline only:
            // parseExpectedIndexes never sees them, so without parseInlineIndexes every
            // boot of every DB would report them as undeclared.
            const live = declaredIndexes('state_checkpoints').concat([
                { name: 'PRIMARY', unique: true, fulltext: false, columns: ['id'] },
            ]);
            const { warns } = await runIndexes('state_checkpoints', live);
            assert.deepStrictEqual(warns.filter(w => /Schema shape drift/.test(w)), [],
                'inline keys and the primary key are declarations; reporting them is noise');
        });

        it('a renamed but column-identical index is not reported (matched by column set)', async function () {
            const live = declaredIndexes('state_checkpoints').map(i =>
                i.name === 'idx_checkpoint_seq' ? Object.assign({}, i, { name: 'idx_seq_old_name' }) : i);
            const { warns } = await runIndexes('state_checkpoints', live);
            assert.deepStrictEqual(warns.filter(w => /Schema shape drift/.test(w)), [],
                'the reconciler already treats an equivalent column set as present; detection must agree');
        });

        it('detection runs on a table that declares no standalone CREATE INDEX', async function () {
            // Before reconcileTableIndexes returned before the live read whenever
            // parseExpectedIndexes found nothing, so an inline-keys-only table could never
            // be inspected at all. state_checkpoints declares its keys inline only.
            const idx = require('../../src/db').prototype.parseExpectedIndexes.call(
                makeCtx(), fs.readFileSync(path.join(SQL_DIR, 'state_checkpoints.sql'), 'utf8'), 'state_checkpoints');
            assert.deepStrictEqual(idx, [], 'fixture assumption: state_checkpoints has no standalone CREATE INDEX');
            const { warns } = await runIndexes('state_checkpoints', [
                { name: 'idx_hand_added', unique: false, fulltext: false, columns: ['block_hash'] },
            ]);
            assert.ok(warns.some(w => /Schema shape drift on state_checkpoints/.test(w) && /idx_hand_added/.test(w)),
                'an inline-keys-only table must still be inspected: ' + JSON.stringify(warns));
        });
    });

    describe('the boot summary', function () {

        it('names every drifted table once, so one line per DB is the fleet comparison', function () {
            const inst = Object.create(Database.prototype);
            inst.schemaShapeDrift = new Map([
                ['state_checkpoints', { columns: ['signed_state_root'], indexes: [{ name: 'uq_chain_net_block_seq' }] }],
                ['balances',          { columns: [], indexes: [{ name: 'idx_stale' }] }],
            ]);
            const summary = inst.schemaShapeSummary();
            assert.ok(/2 table\(s\)/.test(summary), summary);
            assert.ok(/1 undeclared column\(s\)/.test(summary), summary);
            assert.ok(/2 undeclared index\(es\)/.test(summary), summary);
            for (const token of ['state_checkpoints', 'signed_state_root', 'uq_chain_net_block_seq', 'balances', 'idx_stale'])
                assert.ok(summary.includes(token), 'summary must name ' + token + ': ' + summary);
        });

        it('a converged DB says so explicitly rather than printing nothing', function () {
            const inst = Object.create(Database.prototype);
            inst.schemaShapeDrift = new Map();
            assert.strictEqual(inst.schemaShapeSummary(), 'Schema shape: no undeclared columns or indexes.');
        });
    });
});
