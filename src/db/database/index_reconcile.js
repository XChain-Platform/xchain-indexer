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
 *
 * XChain Indexer - Database class part: index drift
 *
 * Index drift at boot: reconcileTableIndexes and the dedupe that clears the way for a
 * declared UNIQUE index.
 *
 * A part of the Database class body: db/index.js installs it onto Database.prototype,
 * non-enumerable and in the order the class declared it, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// Strict, as the class body these methods came from was.
'use strict';

const fs      = require('fs');
const path    = require('path');
const { getLogger } = require('../../observability/index.js');
// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { AUTO_DEDUP_TABLES, recordShapeDrift } = require('../shared.js');

// reconcileTableIndexes, the live index shape of one table: every index by name with its
// columns and prefix widths, the set of live names, and the indexes by column set.
async function readLiveIndexes(self, db, table){
    // Live indexes -> map keyed by ordered column-set: "c1,c2" => {unique}
    const rows = await db.query(
        "SELECT INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COLUMN_NAME, SEQ_IN_INDEX, SUB_PART FROM information_schema.statistics " +
        "WHERE table_schema = ? AND table_name = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        [self.dbName, table]);
    const byName = new Map();
    const liveNames = new Set();
    for(const r of rows){
        liveNames.add(r.INDEX_NAME.toLowerCase());
        if(!byName.has(r.INDEX_NAME)) byName.set(r.INDEX_NAME, { unique: Number(r.NON_UNIQUE) === 0, fulltext: String(r.INDEX_TYPE || '').toUpperCase() === 'FULLTEXT', cols: [], subParts: [] });
        byName.get(r.INDEX_NAME).cols.push(r.COLUMN_NAME.toLowerCase());
        byName.get(r.INDEX_NAME).subParts.push(r.SUB_PART == null ? null : Number(r.SUB_PART));
    }
    const liveByCols = new Map();
    for(const info of byName.values()) liveByCols.set(info.cols.join(','), info);
    return { byName, liveNames, liveByCols };
}

// A declared index already satisfied by its column set: warn when the prefix widths drifted.
function warnPrefixDrift(table, key, idx, live){
    // Satisfied by column set, but the column-set match is blind to
    // prefix widths: an aged `address(62)` index and the declared
    // full-column index read as identical here and no auto path
    // converges them (the DROP/CREATE is deliberately mode=manual;
    // rebuilding a UNIQUE index the boot upsert path depends on is
    // not safe to do unattended). Detect-and-warn so the drift is
    // auditable instead of invisible (#2261).
    const declared = idx.prefixes || idx.columns.map(() => null);
    const drift = idx.columns.map((c, i) => ({ col: c, want: declared[i] ?? null, have: (live.subParts && live.subParts[i]) ?? null }))
        .filter(d => d.want !== d.have);
    if(drift.length){
        const desc = drift.map(d =>
            d.col + ' live ' + (d.have === null ? 'full-column' : '(' + d.have + ')') +
            ' vs declared ' + (d.want === null ? 'full-column' : '(' + d.want + ')')).join('; ');
        getLogger().warn('Schema drift on ' + table + ': index on (' + key + ') differs in prefix width: ' + desc +
            '. Not auto-healed (UNIQUE index rebuild is gated manual); run the pending manual migration via node src/migration/migrate.js to converge.');
    }
}

// A declared index whose name a different live index already holds: warn, never DROP.
function warnNameCollision(table, key, idx, byName){
    // Name taken by a DIFFERENT live index (different column set, or same
    // name but not unique when we declare UNIQUE). We must never DROP an
    // index we did not create, so we leave it alone - but the declared
    // index is silently never applied, so the table can permanently run
    // without the declared uniqueness (degrading every
    // INSERT ... ON DUPLICATE KEY UPDATE to a plain INSERT) or without the
    // widened column set. Detect-and-warn so this drift is auditable
    // instead of invisible, matching the prefix-width branch above (#2261)
    // and the auto-dedup branch below (#2702).
    let liveInfo = null;
    for(const [nm, info] of byName){ if(nm.toLowerCase() === idx.name.toLowerCase()){ liveInfo = info; break; } }
    const liveDesc = liveInfo
        ? (liveInfo.unique ? 'UNIQUE' : liveInfo.fulltext ? 'FULLTEXT' : 'non-unique') + ' on (' + liveInfo.cols.join(',') + ')'
        : 'a differently-defined index';
    getLogger().warn('Schema drift on ' + table + ': declared ' + (idx.unique ? 'UNIQUE ' : idx.fulltext ? 'FULLTEXT ' : '') +
        'index ' + idx.name + ' on (' + key + ') cannot be applied - the name is already held by ' + liveDesc +
        '. Not auto-healed (never DROP an index we did not create); apply a manual migration via node src/migration/migrate.js to converge.');
}

// A declared index absent live: added the way the source declares it, deduping first when
// duplicate rows block a UNIQUE index on a table the auto-dedup allow-list names.
async function addDeclaredIndex(self, db, table, idx, key){
    // Rebuild the index the way the source DECLARES it. Dropping the (len) prefix
    // turns UNIQUE tick(200) into a full-column index on a TEXT column, which
    // MariaDB rejects (errno 1170) and the catch below only logs, so the table
    // permanently runs without its declared uniqueness; dropping DESC diverges an
    // auto-healed index from a fresh install of the same definition (#4357).
    const colList = idx.columns.map((c, i) => {
        const prefix = idx.prefixes    && idx.prefixes[i] != null      ? '(' + idx.prefixes[i] + ')' : '';
        const dir    = idx.directions  && idx.directions[i] === 'DESC' ? ' DESC'                     : '';
        return '`' + c + '`' + prefix + dir;
    }).join(', ');

    if(idx.fulltext){
        // A FULLTEXT index takes no prefix widths or directions; MariaDB refuses
        // both, so the heal names the columns bare.
        getLogger().info('Schema drift on ' + table + ': missing FULLTEXT index ' + idx.name + ' (' + key + '). Adding.');
        await db.query('ALTER TABLE `' + table + '` ADD FULLTEXT INDEX `' + idx.name + '` (' + idx.columns.map(c => '`' + c + '`').join(', ') + ')');
        return;
    }
    if(!idx.unique){
        getLogger().info('Schema drift on ' + table + ': missing index ' + idx.name + ' (' + key + '). Adding.');
        await db.query('ALTER TABLE `' + table + '` ADD INDEX `' + idx.name + '` (' + colList + ')');
        return;
    }
    try {
        getLogger().info('Schema drift on ' + table + ': missing UNIQUE index ' + idx.name + ' (' + key + '). Adding.');
        await db.query('ALTER TABLE `' + table + '` ADD UNIQUE INDEX `' + idx.name + '` (' + colList + ')');
    } catch(e){
        const dup = e && (Number(e.errno) === 1062 || /duplicate entry/i.test(e.message || ''));
        if(!dup){ getLogger().info('  could not add UNIQUE index ' + idx.name + ' on ' + table + ': ' + (e && e.message)); return; }
        if(!AUTO_DEDUP_TABLES.has(table)){
            getLogger().warn('  ' + table + '.' + idx.name + ': duplicate rows block the UNIQUE index, but ' + table + ' is NOT on the auto-dedup allow-list - skipping (no rows deleted). Apply a manual migration to resolve the duplicates.');
            return;
        }
        getLogger().info('  ' + table + '.' + idx.name + ': duplicate rows block the UNIQUE index - deduping (keep newest id per ' + key + ') then retrying.');
        if(!(await self.dedupeForUniqueIndex(db, table, idx.columns))) return;
        try {
            await db.query('ALTER TABLE `' + table + '` ADD UNIQUE INDEX `' + idx.name + '` (' + colList + ')');
            getLogger().info('  added ' + idx.name + ' after dedupe.');
        } catch(e2){
            getLogger().info('  ' + table + '.' + idx.name + ' still failing after dedupe - leaving as-is: ' + (e2 && e2.message));
        }
    }
}

module.exports = {

    // Reconcile declared indexes against the live table. Adds any index named in the
    // SQL source that is absent live (matched by column set, so a renamed-but-equivalent
    // index is treated as present). For a UNIQUE index blocked by pre-existing duplicate
    // rows, dedupes first (see dedupeForUniqueIndex) then retries. Never throws - a
    // failure is logged and startup continues. On a table that already has every declared
    // index (the normal case) this is a single information_schema read and a no-op.
    async reconcileTableIndexes(file, db){
        try {
            const dir      = path.join(__dirname, '..', '..', 'sql');
            const data     = fs.readFileSync(dir + '/' + file, "utf8");
            const table    = file.substring(0, file.indexOf('.sql'));
            const expected = this.parseExpectedIndexes(data, table);
            // The live read happens even with nothing to re-add: the undeclared-index
            // detector at the bottom runs on every table, and a table whose keys are all
            // inline declares no standalone CREATE INDEX at all.

            const { byName, liveNames, liveByCols } = await readLiveIndexes(this, db, table);

            for(const idx of expected){
                const key  = idx.columns.map(c => c.toLowerCase()).join(',');
                const live = liveByCols.get(key);
                if(live && (!idx.unique || live.unique) && (!idx.fulltext || live.fulltext)){
                    warnPrefixDrift(table, key, idx, live);
                    continue;                                               // already satisfied
                }
                if(liveNames.has(idx.name.toLowerCase())){
                    warnNameCollision(table, key, idx, byName);
                    continue;
                }
                await addDeclaredIndex(this, db, table, idx, key);
            }

            // Indexes present live that no declaration reaches. Matched against BOTH
            // declaration forms (standalone CREATE INDEX and the inline keys inside the
            // CREATE TABLE block) so only a genuine orphan is reported. Detection only -
            // the never-DROP rule that governs the name-collision branch above governs
            // this too; converging is a dated migration's job.
            const undeclared = this.undeclaredLiveIndexes(
                expected.concat(this.parseInlineIndexes(data, table)), byName);
            if(undeclared.length){
                getLogger().warn('Schema shape drift on ' + table + ': live index(es) ' +
                    undeclared.map(i => (i.unique ? 'UNIQUE ' : i.fulltext ? 'FULLTEXT ' : '') + i.name + ' (' + i.columns.join(',') + ')').join('; ') +
                    ' are declared by NO SQL source. Not auto-healed (never DROP an index we did not create); ' +
                    'converge with a dated migration via node src/migration/migrate.js, or restore the declaration to ' + file + '.');
                recordShapeDrift(this.schemaShapeDrift, table, 'indexes', undeclared);
            }
        } catch(e){
            // Never abort startup over index reconciliation.
            getLogger().warn('reconcileTableIndexes(' + file + ') failed (non-fatal): ' + (e && e.message));
        }
    },

    // Collapse duplicate rows on `columns` so a UNIQUE index can be added, keeping the
    // row with the highest `id` in each group. For the failure this repairs - an
    // INSERT ... ON DUPLICATE KEY UPDATE upsert that degraded to plain INSERT because the
    // unique index was missing - each balance change appended a fresh row with the current
    // value, so the highest id is the live (correct) value and the older rows are stale.
    // Uses `=` (not `<=>`) so NULL tuples are left intact, matching UNIQUE semantics (a
    // UNIQUE index permits multiple NULLs). Requires a single `id` column to pick a
    // survivor; skips with a warning if absent. Returns true if the table is now safe to index.
    async dedupeForUniqueIndex(db, table, columns){
        const hasId = (await db.query(
            "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND COLUMN_NAME = 'id'",
            [this.dbName, table])).length > 0;
        if(!hasId){
            getLogger().info('  cannot dedupe ' + table + ' (no `id` column to pick a surviving row) - skipping unique-index add.');
            return false;
        }
        const on  = columns.map(c => 't1.`' + c + '` = t2.`' + c + '`').join(' AND ');
        const res = await db.query('DELETE t1 FROM `' + table + '` t1 JOIN `' + table + '` t2 ON ' + on + ' AND t1.id < t2.id');
        getLogger().info('  deduped ' + table + ': removed ' + (res && res.affectedRows != null ? res.affectedRows : '?') + ' stale duplicate row(s).');
        return true;
    },

};
