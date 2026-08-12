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
