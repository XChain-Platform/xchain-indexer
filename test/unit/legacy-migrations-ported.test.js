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
 * which cover tracked ADDs. Those tests' stated blind spot (): the
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
 *
 * The counterpart rule is deliberately narrow to avoid false alarms: for each
 * legacy `DROP COLUMN <col>` / `ADD UNIQUE INDEX <name>` statement, SOME
 * tracked src/sql/migrations/*.sql must reference the same table AND the same
 * column/index name. Plain (non-UNIQUE) legacy index adds are exempt:
 * reconcileTableIndexes converges those unconditionally at boot.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const LEGACY_DIR  = path.join(__dirname, '..', '..', 'migrations');
const TRACKED_DIR = path.join(__dirname, '..', '..', 'src', 'sql', 'migrations');

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
// every ADD UNIQUE INDEX/KEY, from one SQL text.
function extractConvergenceDdl(sql) {
    const text = stripComments(sql);
    const out = { drops: [], uniques: [] };
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
    }
    const cuRe = /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s+ON\s+`?(\w+)`?/gi;
    let c;
    while ((c = cuRe.exec(text)) !== null) out.uniques.push({ table: c[2].toLowerCase(), index: c[1].toLowerCase() });
    return out;
}

describe('legacy migrations/ DDL is ported to the tracked ledger ()', function () {
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

    it('sanity: the extractor sees the two known legacy drifts', function () {
        // Falsifiability anchor: these two are the documented drift cases; if
        // the legacy files are ever deleted/renamed this test must be revisited
        // rather than silently passing on empty input.
        const all = legacy.map((l) => extractConvergenceDdl(l.text));
        const drops = all.flatMap((a) => a.drops).map((d) => `${d.table}.${d.column}`);
        const uqs   = all.flatMap((a) => a.uniques).map((u) => u.index);
        assert.ok(drops.includes('sweeps.escrows'), `expected legacy sweeps.escrows drop, saw: ${drops.join(', ')}`);
        assert.ok(uqs.includes('uq_markets_pair'), `expected legacy uq_markets_pair, saw: ${uqs.join(', ')}`);
    });
});
