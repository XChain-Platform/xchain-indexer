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
 * Legacy-DDL port parity: convergence-relevant DDL in the untracked legacy
 * xchain-indexer/migrations/ directory must have a tracked counterpart.
 *
 * Sibling of sql-schema-column-parity.test.js / sql-schema-index-parity.test.js,
 * which cover tracked ADDs. Those tests' stated blind spot: the
 * legacy migrations/ directory is documentation-only - runMigrations() scans
 * ONLY src/sql/migrations/ - yet it carries DDL an aged DB still needs:
 *   1. DROP COLUMN: verifyTables()/alterTableForDrift never drops an
 *      undeclared column, so a definition-removed column persists on aged
 *      DBs forever unless a tracked migration drops it (how sweeps.escrows
 *      drifted).
 *   2. dedup + ADD UNIQUE INDEX: reconcileTableIndexes auto-builds a declared
 *      UNIQUE only for tables on the AUTO_DEDUP_TABLES allow-list; for any
 *      other table with pre-existing duplicates the build is skipped, so the
 *      dedup DELETE must be ported (how markets uq_markets_pair drifted).
 *   3. DROP INDEX: the removal direction, symmetric to (1). reconcileTableIndexes
 *      only ADDs declared indexes and never drops one it did not create
 *      (db.js "never DROP an index we did not create"), so an index retired from
 *      a src/sql/<table>.sql definition strands on aged DBs forever unless a
 *      dated DROP INDEX migration ships. That is a non-byte-identical
 *      SHOW CREATE TABLE, the exact drift class the convergence audit flags, and
 *      it has bitten twice on balances.address_id (2026-05-30, then 2026-07-13),
 *      caught reactively both times because nothing asserted it.
 *
 * The counterpart rule is deliberately narrow to avoid false alarms: for each
 * legacy `DROP COLUMN <col>` / `ADD UNIQUE INDEX <name>` / `DROP INDEX <name>`
 * statement, SOME tracked src/sql/migrations/*.sql must reference the same table
 * AND the same column/index name. Plain (non-UNIQUE) legacy index ADDs are
 * exempt from the port rule (reconcileTableIndexes converges those
 * unconditionally at boot), but they are still cross-referenced against the
 * current definitions: one that is no longer declared has been RETIRED and needs
 * its own tracked DROP INDEX.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const LEGACY_DIR  = path.join(__dirname, '..', '..', 'migrations');
const TRACKED_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');
const DEFN_DIR    = path.join(__dirname, '..', '..', 'src', 'sql');

function readSqlFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

// Strip -- line comments so commented-out DDL never counts.
function stripComments(sql) {
    return sql.split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');
}

// Extract { table, column } for every DROP COLUMN, and { table, index } for
// every ADD UNIQUE INDEX/KEY, every index ADD, and every DROP INDEX, from one
// SQL text.
function extractConvergenceDdl(sql) {
    const text = stripComments(sql);
    const out = { drops: [], uniques: [], indexAdds: [], indexDrops: [] };
    // Walk ALTER TABLE blocks so multi-action ALTERs attribute to the right table.
    const alterRe = /ALTER\s+TABLE\s+`?(\w+)`?([\s\S]*?);/gi;
    let m;
    while ((m = alterRe.exec(text)) !== null) {
        const table = m[1].toLowerCase();
        const body  = m[2];
        const dropRe = /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?/gi;
        let d;
        while ((d = dropRe.exec(body)) !== null) out.drops.push({ table, column: d[1].toLowerCase() });
        const uqRe = /ADD\s+UNIQUE\s+(?:INDEX|KEY)\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi;
        let u;
        while ((u = uqRe.exec(body)) !== null) out.uniques.push({ table, index: u[1].toLowerCase() });
        // Every index ADD, unique or not; the retired-index rule below needs the
        // full set, not just the uniques the port rule cares about.
        const addRe = /ADD\s+(?:UNIQUE\s+)?(?:INDEX|KEY)\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi;
        let a;
        while ((a = addRe.exec(body)) !== null) out.indexAdds.push({ table, index: a[1].toLowerCase() });
        const dropIdxRe = /DROP\s+(?:INDEX|KEY)\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?/gi;
        let di;
        while ((di = dropIdxRe.exec(body)) !== null) out.indexDrops.push({ table, index: di[1].toLowerCase() });
    }
    // Standalone form: DROP INDEX <name> ON <table>.
    const dropOnRe = /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?\s+ON\s+`?(\w+)`?/gi;
    let dn;
    while ((dn = dropOnRe.exec(text)) !== null) out.indexDrops.push({ table: dn[2].toLowerCase(), index: dn[1].toLowerCase() });
    const cuRe = /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s+ON\s+`?(\w+)`?/gi;
    let c;
    while ((c = cuRe.exec(text)) !== null) out.uniques.push({ table: c[2].toLowerCase(), index: c[1].toLowerCase() });
    const ciRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s+ON\s+`?(\w+)`?/gi;
    let ci;
    while ((ci = ciRe.exec(text)) !== null) out.indexAdds.push({ table: ci[2].toLowerCase(), index: ci[1].toLowerCase() });
    return out;
}

// Index names each src/sql/<table>.sql currently DECLARES, keyed by table. Both
// legitimate forms count: a standalone CREATE INDEX, and an inline KEY/INDEX
// clause inside the CREATE TABLE block (same two forms sql-schema-index-parity
// recognises). PRIMARY KEY / FOREIGN KEY carry no index name and are skipped.
function declaredIndexesByTable(dir) {
    const declared = new Map();
    const add = (table, index) => {
        const key = table.toLowerCase();
        if (!declared.has(key)) declared.set(key, new Set());
        declared.get(key).add(index.toLowerCase());
    };
    for (const { text } of readSqlFiles(dir)) {
        const sql = stripComments(text);
        const createRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s+ON\s+`?(\w+)`?/gi;
        let c;
        while ((c = createRe.exec(sql)) !== null) add(c[2], c[1]);
        const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(([\s\S]*?)\n\s*\)/gi;
        let t;
        while ((t = tableRe.exec(sql)) !== null) {
            const inlineRe = /(?:^|,)\s*(?:UNIQUE\s+)?(?:KEY|INDEX)\s+`?(\w+)`?\s*\(/gim;
            let i;
            while ((i = inlineRe.exec(t[2])) !== null) add(t[1], i[1]);
        }
    }
    return declared;
}

// Column names each src/sql/<table>.sql currently DECLARES, keyed by table. The
// column twin of declaredIndexesByTable: read the CREATE TABLE body and take the
// first identifier of every line that is a column definition, skipping the
// key/constraint clauses (which have no column name in that position).
function declaredColumnsByTable(dir) {
    const declared = new Map();
    const KEYWORDS = ['PRIMARY', 'UNIQUE', 'KEY', 'INDEX', 'CONSTRAINT', 'FOREIGN', 'FULLTEXT', 'SPATIAL', 'CHECK'];
    for (const { text } of readSqlFiles(dir)) {
        const sql = stripComments(text);
        const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(([\s\S]*?)\n\s*\)/gi;
        let t;
        while ((t = tableRe.exec(sql)) !== null) {
            const key = t[1].toLowerCase();
            if (!declared.has(key)) declared.set(key, new Set());
            for (const line of t[2].split('\n')) {
                const m = /^\s*`?(\w+)`?\s+[A-Za-z]/.exec(line);
                if (!m || KEYWORDS.includes(m[1].toUpperCase())) continue;
                declared.get(key).add(m[1].toLowerCase());
            }
        }
    }
    return declared;
}

// ORDERED DDL events for one SQL text: { kind: 'index'|'column', key: 'table.name',
// act: 'add'|'drop', at: <byte offset> }, sorted by position. extractConvergenceDdl
// buckets by kind and so cannot tell "DROP INDEX x then ADD INDEX x" from the
// reverse; the drop-direction rules need that order, because a drop-then-recreate
// inside one ALTER must resolve to the ADD.
function ddlTimeline(sql) {
    const text = stripComments(sql);
    const ev = [];
    const alterRe = /ALTER\s+TABLE\s+`?(\w+)`?([\s\S]*?);/gi;
    let m;
    while ((m = alterRe.exec(text)) !== null) {
        const table = m[1].toLowerCase();
        const body  = m[2];
        const base  = m.index + m[0].indexOf(body);
        const scan = (re, kind, act) => {
            let x;
            while ((x = re.exec(body)) !== null)
                ev.push({ kind, key: table + '.' + x[1].toLowerCase(), act, at: base + x.index });
        };
        scan(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?/gi, 'column', 'drop');
        scan(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi, 'column', 'add');
        scan(/ADD\s+(?:UNIQUE\s+)?(?:INDEX|KEY)\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi, 'index', 'add');
        scan(/DROP\s+(?:INDEX|KEY)\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?/gi, 'index', 'drop');
        // A CHANGE/MODIFY re-declares the column, so it counts as an ADD for the
        // last-writer rule: a column renamed back into existence is not dropped.
        const chRe = /(?:CHANGE|MODIFY)\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?`?(\w+)`?\s+`?(\w+)`?/gi;
        let ch;
        while ((ch = chRe.exec(body)) !== null)
            ev.push({ kind: 'column', key: table + '.' + ch[2].toLowerCase(), act: 'add', at: base + ch.index });
    }
    let r, x;
    r = /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?\s+ON\s+`?(\w+)`?/gi;
    while ((x = r.exec(text)) !== null)
        ev.push({ kind: 'index', key: x[2].toLowerCase() + '.' + x[1].toLowerCase(), act: 'drop', at: x.index });
    r = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s+ON\s+`?(\w+)`?/gi;
    while ((x = r.exec(text)) !== null)
        ev.push({ kind: 'index', key: x[2].toLowerCase() + '.' + x[1].toLowerCase(), act: 'add', at: x.index });
    ev.sort((a, b) => a.at - b.at);
    return ev;
}

describe('legacy migrations/ DDL is ported to the tracked ledger', function () {
    const legacy  = readSqlFiles(LEGACY_DIR);
    const tracked = readSqlFiles(TRACKED_DIR);
    const trackedText = tracked.map((t) => stripComments(t.text).toLowerCase()).join('\n');

    it('every legacy DROP COLUMN has a tracked counterpart naming the same table + column', function () {
        for (const { file, text } of legacy) {
            for (const { table, column } of extractConvergenceDdl(text).drops) {
                const ok = trackedText.includes(table) && new RegExp(
                    `drop\\s+column\\s+(if\\s+exists\\s+)?\`?${column}\`?`).test(trackedText);
                assert.ok(ok,
                    `${file}: legacy "ALTER TABLE ${table} ... DROP COLUMN ${column}" has no tracked ` +
                    `src/sql/migrations/ counterpart; aged DBs keep the column forever ` +
                    `(alterTableForDrift never drops). Port it (mode=manual).`);
            }
        }
    });

    it('every legacy dedup+UNIQUE has a tracked counterpart naming the same index', function () {
        for (const { file, text } of legacy) {
            for (const { table, index } of extractConvergenceDdl(text).uniques) {
                const ok = trackedText.includes(index);
                assert.ok(ok,
                    `${file}: legacy UNIQUE index ${index} on ${table} has no tracked counterpart; ` +
                    `tables off the AUTO_DEDUP_TABLES allow-list never converge when duplicates ` +
                    `block the reconciler's build. Port the dedup+UNIQUE (mode=manual).`);
            }
        }
    });

    // Tracked DROP INDEX statements as exact `table.index` keys. The index-name
    // namespace is per table (`source_id` exists on several), so unlike the older
    // name-only rules above these two match on the pair or a drop on some other
    // table would satisfy the check.
    const trackedIndexDrops = new Set(
        tracked.flatMap((t) => extractConvergenceDdl(t.text).indexDrops).map((d) => `${d.table}.${d.index}`)
    );

    it('every legacy DROP INDEX has a tracked counterpart naming the same index', function () {
        for (const { file, text } of legacy) {
            for (const { table, index } of extractConvergenceDdl(text).indexDrops) {
                const ok = trackedIndexDrops.has(`${table}.${index}`);
                assert.ok(ok,
                    `${file}: legacy "ALTER TABLE ${table} ... DROP INDEX ${index}" has no tracked ` +
                    `src/sql/migrations/ counterpart; reconcileTableIndexes never drops an index it ` +
                    `did not create, so aged DBs keep it forever and their SHOW CREATE TABLE stops ` +
                    `matching a fresh install. Port it (mode=manual).`);
            }
        }
    });

    it('every legacy-added index retired from its definition has a tracked DROP INDEX', function () {
        // The removal path a static definition-vs-ledger diff cannot see: once an
        // index is deleted from src/sql/<table>.sql it leaves no trace there, so
        // "was it ever declared?" has to be answered from the legacy ledger. Any
        // legacy-added name the definitions no longer declare is RETIRED and owes
        // a dated DROP INDEX, or aged DBs strand on it.
        const declared = declaredIndexesByTable(DEFN_DIR);
        for (const { file, text } of legacy) {
            for (const { table, index } of extractConvergenceDdl(text).indexAdds) {
                if ((declared.get(table) || new Set()).has(index)) continue;   // still declared
                const ok = trackedIndexDrops.has(`${table}.${index}`);
                assert.ok(ok,
                    `${file}: index ${index} on ${table} was added by a legacy migration and is no ` +
                    `longer declared in src/sql/${table}.sql, but no tracked src/sql/migrations/ file ` +
                    `drops it. reconcileTableIndexes only ADDs declared indexes, so every aged DB ` +
                    `keeps ${index} forever while a fresh install never builds it. Ship a dated ` +
                    `DROP INDEX migration (mode=manual).`);
            }
        }
    });

    it('sanity: the extractor sees the known legacy drifts', function () {
        // Falsifiability anchor: these are the documented drift cases; if the
        // legacy files are ever deleted/renamed this test must be revisited
        // rather than silently passing on empty input.
        const all = legacy.map((l) => extractConvergenceDdl(l.text));
        const drops = all.flatMap((a) => a.drops).map((d) => `${d.table}.${d.column}`);
        const uqs   = all.flatMap((a) => a.uniques).map((u) => u.index);
        const idrop = all.flatMap((a) => a.indexDrops).map((d) => `${d.table}.${d.index}`);
        const iadd  = all.flatMap((a) => a.indexAdds).map((a2) => `${a2.table}.${a2.index}`);
        assert.ok(drops.includes('sweeps.escrows'), `expected legacy sweeps.escrows drop, saw: ${drops.join(', ')}`);
        assert.ok(uqs.includes('uq_markets_pair'), `expected legacy uq_markets_pair, saw: ${uqs.join(', ')}`);
        assert.ok(idrop.includes('balances.address_id'), `expected legacy balances.address_id index drop, saw: ${idrop.join(', ')}`);
        assert.ok(iadd.includes('actions.source_id'), `expected legacy actions.source_id index add, saw: ${iadd.join(', ')}`);
    });

    // ── the DROP direction, for TRACKED migrations ─────────────────────────────
    //
    // Every rule above (and both sql-schema-*-parity suites) runs in the ADD
    // direction: definition declares it, so the ledger must too. The inverse is
    // unguarded and is NOT inert, because the boot reconcilers actively undo it.
    // A tracked migration that DROPs an index while src/sql/<table>.sql still
    // declares it is re-created by reconcileTableIndexes (db.js, "Schema drift on
    // <table>: missing index ... Adding.") at EVERY startup, and the column twin is
    // re-added by alterTableForDrift. A replay-only replica never runs verifyTables,
    // so it keeps the object dropped, and the two paths diverge permanently with
    // nothing asserting anything. balances.address_id is the shape: it has bitten
    // twice, caught reactively both times.
    //
    // Last-writer-wins over the tracked ledger, in filename (date) order and, within
    // one file, in byte order: a drop-then-recreate in one ALTER (destroys.action_index,
    // capability_snapshots.uq_cap_snap) ends on the ADD, so the definition is expected
    // to keep declaring it. Only a TERMINAL drop obliges the definition to be silent.
    const terminalDdlState = (function () {
        const state = new Map();   // 'index:table.name' | 'column:table.name' -> { act, file }
        // Filenames are date-prefixed, so lexical order IS ledger order. readSqlFiles
        // leans on readdir order, which is not guaranteed; sort explicitly or the
        // last-writer rule reads the ledger in whatever order the filesystem hands back.
        const ordered = tracked.slice().sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
        for (const { file, text } of ordered)
            for (const ev of ddlTimeline(text)) state.set(ev.kind + ':' + ev.key, { act: ev.act, file });
        return state;
    })();

    it('no tracked DROP INDEX leaves the index still declared in its definition', function () {
        const declared = declaredIndexesByTable(DEFN_DIR);
        let checked = 0;
        for (const [k, v] of terminalDdlState) {
            if (!k.startsWith('index:') || v.act !== 'drop') continue;
            checked++;
            const [table, index] = k.slice('index:'.length).split('.');
            assert.ok(!(declared.get(table) || new Set()).has(index),
                `${v.file} drops index ${index} on ${table}, but src/sql/${table}.sql still declares it. ` +
                `reconcileTableIndexes re-ADDs any declared-but-missing index at every boot, so a ` +
                `verifyTables node silently undoes this migration while a replay-only replica keeps it ` +
                `dropped - the two diverge permanently. Either remove the declaration or drop the migration.`);
        }
        // Falsifiability anchor: the rule must be iterating real terminal drops, not
        // an empty set. A parser change that returned nothing would pass silently.
        assert.ok(checked >= 5, `expected the ledger to carry terminal index drops; saw ${checked}`);
    });

    it('no tracked DROP COLUMN leaves the column still declared in its definition', function () {
        const declared = declaredColumnsByTable(DEFN_DIR);
        let checked = 0;
        for (const [k, v] of terminalDdlState) {
            if (!k.startsWith('column:') || v.act !== 'drop') continue;
            checked++;
            const [table, column] = k.slice('column:'.length).split('.');
            assert.ok(!(declared.get(table) || new Set()).has(column),
                `${v.file} drops column ${column} from ${table}, but src/sql/${table}.sql still declares it. ` +
                `alterTableForDrift re-ADDs any declared-but-missing column at every boot, so a ` +
                `verifyTables node silently undoes this migration while a replay-only replica keeps it ` +
                `dropped. Either remove the declaration or drop the migration.`);
        }
        assert.ok(checked >= 1, `expected the ledger to carry at least one terminal column drop; saw ${checked}`);
    });

    it('sanity: the drop-direction timeline orders a drop-then-recreate onto the ADD', function () {
        // The whole rule rests on within-file byte order. destroys.action_index is
        // dropped as a UNIQUE and re-created as a plain index inside ONE migration;
        // reading that pair drop-last would make the rule demand the definition stop
        // declaring an index the same file rebuilds, i.e. a false red on real DDL.
        const st = terminalDdlState.get('index:destroys.action_index');
        assert.ok(st, 'expected destroys.action_index in the tracked DDL timeline');
        assert.strictEqual(st.act, 'add',
            `destroys.action_index is dropped and re-created in one migration; the timeline must end on ` +
            `the ADD, saw "${st.act}" from ${st.file}`);
    });

    it('sanity: the definition column parser sees real columns', function () {
        // Falsifiability anchor for the DROP COLUMN rule, matching the index twin
        // below: a parser returning nothing would make that rule pass on empty input.
        const declared = declaredColumnsByTable(DEFN_DIR);
        assert.ok((declared.get('balances') || new Set()).has('address_id'),
            `expected balances.address_id declared, saw: ${[...(declared.get('balances') || [])].join(', ')}`);
        assert.ok(!(declared.get('sweeps') || new Set()).has('escrows'),
            'sweeps.escrows was dropped by a tracked migration and must not be declared');
        assert.ok(declared.size > 20, `column parser found only ${declared.size} tables; it is not reading src/sql/`);
    });

    it('sanity: the definition parser sees both declaration forms', function () {
        // Falsifiability anchor for the retired-index rule: a parser that silently
        // returned nothing would make that rule pass by finding no declarations at
        // all. balances.addr_tick is a standalone CREATE UNIQUE INDEX; actions
        // declares source_id the same way. A table whose index set comes back empty
        // means the parser, not the schema, changed.
        const declared = declaredIndexesByTable(DEFN_DIR);
        assert.ok((declared.get('balances') || new Set()).has('addr_tick'),
            `expected balances.addr_tick declared, saw: ${[...(declared.get('balances') || [])].join(', ')}`);
        assert.ok((declared.get('actions') || new Set()).has('source_id'),
            `expected actions.source_id declared, saw: ${[...(declared.get('actions') || [])].join(', ')}`);
        assert.ok(declared.size > 20, `definition parser found only ${declared.size} tables; it is not reading src/sql/`);
    });
});
