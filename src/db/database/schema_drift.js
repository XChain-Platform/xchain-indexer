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
 * XChain Indexer - Database class part: column drift
 *
 * Column drift at boot: the CREATE TABLE parsers, the undeclared-shape detectors and
 * alterTableForDrift, plus the standalone index parser reconcileTableIndexes reads.
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
const { recordShapeDrift } = require('../shared.js');

// alterTableForDrift, a column the SQL source declares and the live table lacks: added from
// the source definition, at the position the source gives it.
async function addMissingColumn(db, table, expected, i, liveByName){
    const exp = expected[i];
    // BLIND SPOT, stated so migration prose stops assuming otherwise: this
    // branch also swallows AUTO_INCREMENT / PRIMARY KEY columns, because
    // parseExpectedColumns reads both as NOT NULL with no DEFAULT. Such an add
    // is actually safe (the engine backfills the sequence), but the parsed
    // shape cannot express that, so the reconciler is NOT a convergence path
    // for a surrogate key - only a dated migration is. A migration that adds
    // one must never be squashed or baselined as "the reconciler already did
    // it" (attest_validator_stats.id, 2026-08-19). Pinned by
    // test/unit/migration/schema_drift_column_order.test.js.
    if(exp.notNull && !exp.hasDefault){
        getLogger().info('Schema drift on ' + table + '.' + exp.name + ': column missing live, source is NOT NULL with no DEFAULT - cannot backfill existing rows safely. Skipping; add manually.');
        return;
    }
    // Place the column where the SQL source puts it, not at the tail. A bare
    // ADD COLUMN appends, so an aged table reconciled at boot ended up with a
    // different column ORDER than a fresh createTable of the same definition
    // (contract_state.state_key_bin: mid-table on fresh installs, tail on aged
    // ones) - logically equivalent, but not a byte-identical SHOW CREATE TABLE.
    // Anchor on the nearest PRECEDING source column that exists live (columns
    // added in this same pass count, hence the liveByName update below); a
    // source-leading column has no anchor and goes FIRST.
    let anchor = null;
    for(let j = i - 1; j >= 0 && !anchor; j--){
        if(liveByName.has(expected[j].name.toLowerCase())) anchor = expected[j].name;
    }
    const placement = anchor ? ' AFTER `' + anchor + '`' : ' FIRST';
    getLogger().info('Schema drift on ' + table + '.' + exp.name + ': column missing live. Adding column from SQL source' + (anchor ? ' after ' + anchor : ' first') + '.');
    await db.query('ALTER TABLE `' + table + '` ADD COLUMN ' + exp.definition + placement);
    liveByName.set(exp.name.toLowerCase(), { COLUMN_NAME: exp.name, IS_NULLABLE: exp.notNull ? 'NO' : 'YES', COLUMN_TYPE: '', COLUMN_KEY: '', EXTRA: '' });
}

// alterTableForDrift, a column live as NOT NULL that the source declares nullable: relaxed
// only when the bare MODIFY that does it would lose nothing.
async function relaxNullability(db, table, exp, cur){
    const liveIsNullable = cur.IS_NULLABLE === 'YES';
    if(!liveIsNullable && exp.nullable){
        // NEVER relax a primary-key or auto-increment column: a PK can't be
        // NULL anyway, and a bare `MODIFY <type> NULL` silently strips the
        // AUTO_INCREMENT attribute (the mirror-cursor corruption found live
        // 2026-06-10). parseExpectedColumns already treats such sources as
        // NOT NULL; this guards against any parse gap.
        const isPk     = String(cur.COLUMN_KEY || '').toUpperCase() === 'PRI';
        const isAutoInc = /auto_increment/i.test(String(cur.EXTRA || ''));
        if(isPk || isAutoInc){
            getLogger().info('Schema drift on ' + table + '.' + exp.name + ': live=NOT NULL, source=NULL - SKIPPING relax (' + (isPk ? 'PRIMARY KEY' : 'AUTO_INCREMENT') + ' column; a bare MODIFY would strip attributes).');
            return;
        }
        // A MODIFY restates the whole column, so anything the statement omits is
        // dropped - DEFAULT, COMMENT, ON UPDATE, and the generation expression all
        // vanish, silently diverging an aged DB from a fresh install of the same
        // source (#4359). Rebuilding those clauses out of information_schema is its
        // own footgun (DEFAULT quoting, expression defaults, virtual vs stored), so
        // relax only when there is nothing to lose and surface the rest as drift -
        // the same skip-and-log posture as the two guards above.
        const lossy = [];
        if(cur.COLUMN_DEFAULT !== null && cur.COLUMN_DEFAULT !== undefined) lossy.push('DEFAULT');
        if(String(cur.COLUMN_COMMENT || '') !== '')                         lossy.push('COMMENT');
        if(String(cur.GENERATION_EXPRESSION || '') !== '')                  lossy.push('generation expression');
        if(/on update/i.test(String(cur.EXTRA || '')))                      lossy.push('ON UPDATE');
        if(lossy.length){
            getLogger().warn('Schema drift on ' + table + '.' + exp.name + ': live=NOT NULL, source=NULL - SKIPPING relax (a bare MODIFY would drop ' + lossy.join(', ') + '). Relax it in a dated migration that restates the full column instead.');
            return;
        }
        // Restate the live collation: it is a bare identifier (no quoting hazard) and
        // omitting it re-collates an explicitly-collated column to the table default.
        const collate = /^[A-Za-z0-9_]+$/.test(String(cur.COLLATION_NAME || '')) ? ' COLLATE ' + cur.COLLATION_NAME : '';
        getLogger().info('Schema drift on ' + table + '.' + exp.name + ': live=NOT NULL, source=NULL. Relaxing constraint.');
        await db.query('ALTER TABLE `' + table + '` MODIFY `' + exp.name + '` ' + cur.COLUMN_TYPE + collate + ' NULL');
    }
}

module.exports = {

    // Parse a CREATE TABLE statement to extract expected column nullability.
    // Conservative - only used for drift detection, not for full schema mgmt.
    // Returns array of {name, nullable} or null when parsing can't recognize
    // the file (e.g. a non-CREATE-TABLE definition).
    parseExpectedColumns(sqlData){
        // Strip `--` line comments BEFORE any structural parsing. Inline comments
        // routinely contain commas and parens (e.g. `-- 0=request, 1=response
        // (matches ...)`) that otherwise fool the top-level-comma split below into
        // emitting phantom columns and triggering bogus ADD COLUMN drift fixes.
        sqlData = this.stripSqlLineComments(sqlData);
        // `IF NOT EXISTS` is optional: the src/sql/<table>.sql definitions omit it, but a
        // dated migration that CREATEs a whole new table always carries it (idempotent
        // replay), and the schema-parity guard runs this same parser over those migrations
        // so a migration-created table is checked against its definition instead of being
        // parked in the pre-ledger baseline (#3164).
        const m = sqlData.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s*\(([\s\S]+?)\)\s*ENGINE/i);
        if(!m) return null;
        // Split on top-level commas (i.e. commas not inside type parens like VARCHAR(250))
        const parts = m[1].split(/,(?![^()]*\))/g);
        const cols = [];
        for(let raw of parts){
            // Strip trailing `-- comment` text
            let line = raw.replace(/--[^\n\r]*/g, '').trim();
            if(!line) continue;
            // Skip constraint/index/key lines - column definitions only
            if(/^(PRIMARY|UNIQUE|INDEX|KEY|CHECK|CONSTRAINT|FOREIGN)\b/i.test(line)) continue;
            const tokens = line.split(/\s+/);
            if(tokens.length < 2) continue;
            const name = tokens[0].replace(/`/g, '');
            // SQL columns are NULL unless explicitly NOT NULL. Column-level
            // PRIMARY KEY and AUTO_INCREMENT both IMPLY NOT NULL (SQL semantics)
            // - without this, a source line like `id BIGINT AUTO_INCREMENT
            // PRIMARY KEY` reads as "nullable", the reconciler "relaxes" the
            // live NOT NULL with a bare `MODIFY <type> NULL`, and that MODIFY
            // silently STRIPS the AUTO_INCREMENT attribute on every startup
            // (live-diagnosed 2026-06-10: capability_snapshots / price_snapshots /
            // cross_chain_matches / state_checkpoints id cursors lost
            // AUTO_INCREMENT, so id-omitting INSERT IGNORE writers collided on
            // id=0 and were silently swallowed).
            const nullable = !/\bNOT\s+NULL\b/i.test(line) &&
                             !/\bPRIMARY\s+KEY\b/i.test(line) &&
                             !/\bAUTO_INCREMENT\b/i.test(line);
            // Keep the full (comment-stripped) column definition so a missing
            // column can be re-added verbatim - this preserves the DEFAULT
            // clause, which is what backfills existing rows on NOT NULL columns.
            const notNull    = !nullable;
            const hasDefault = /\bDEFAULT\b/i.test(line);
            cols.push({ name, nullable, definition: line, notNull, hasDefault });
        }
        return cols.length > 0 ? cols : null;
    },

    // Parse the index declarations that live INSIDE the CREATE TABLE block: inline
    // `PRIMARY KEY (...)` / `KEY` / `UNIQUE KEY` / `FULLTEXT KEY` clauses, plus the
    // column-level `PRIMARY KEY` and `UNIQUE` attributes the engine turns into an index
    // of its own. parseExpectedIndexes deliberately ignores all of these (they are
    // created WITH the table, so there is nothing for the reconciler to re-add), but the
    // undeclared-index detector below needs them: without them every inline KEY on every
    // table would read as an orphan and the warning would be pure noise.
    //
    // Returns [{ name, columns:[...] }] with `name` null for an unnamed inline key (the
    // engine derives its live name from the first column, so the detector falls back to
    // matching such a key by column set).
    parseInlineIndexes(sqlData, table){
        sqlData = this.stripSqlLineComments(sqlData);
        const m = sqlData.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s*\(([\s\S]+?)\)\s*ENGINE/i);
        if(!m) return [];
        const cols = (list) => String(list).split(',')
            .map(c => c.trim().replace(/`/g, '').split(/\s+/)[0].replace(/\(\d+\)$/, ''))
            .filter(Boolean);
        const out = [];
        // Same top-level-comma split parseExpectedColumns uses, so a type's own parens
        // (VARCHAR(250), DECIMAL(30,8)) do not shred a declaration into fragments.
        for(let raw of m[1].split(/,(?![^()]*\))/g)){
            const line = raw.replace(/--[^\n\r]*/g, '').trim();
            if(!line) continue;
            let k;
            if((k = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(line))){
                out.push({ name: 'PRIMARY', columns: cols(k[1]) });
            } else if((k = /^(?:UNIQUE|FULLTEXT|SPATIAL)?\s*(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)/i.exec(line))){
                out.push({ name: k[1], columns: cols(k[2]) });
            } else if((k = /^(?:UNIQUE|FULLTEXT|SPATIAL)?\s*(?:KEY|INDEX)\s*\(([^)]*)\)/i.exec(line))){
                out.push({ name: null, columns: cols(k[1]) });
            } else if(/^(?:CHECK|CONSTRAINT|FOREIGN)\b/i.test(line)){
                continue;
            } else {
                // A column definition. Column-level PRIMARY KEY / UNIQUE each create an
                // index the CREATE TABLE never names as a key line.
                const name = line.split(/\s+/)[0].replace(/`/g, '');
                if(!name) continue;
                if(/\bPRIMARY\s+KEY\b/i.test(line)) out.push({ name: 'PRIMARY',  columns: [name] });
                else if(/\bUNIQUE\b/i.test(line))   out.push({ name: name,       columns: [name] });
            }
        }
        return out;
    },

    // Live columns that NO SQL source declares - the other half of drift detection.
    //
    // alterTableForDrift converges the source onto the DB (adds what is declared and
    // missing) but has never looked the other way, so a column that exists only live is
    // invisible on every startup: a retired column whose declaration was deleted, a
    // mirror twin from a superseded wire, or one an operator added by hand. DOGE regtest
    // carried 8 such signed mirror-twin columns plus a pre-fence checkpoint key - a shape
    // no other DB in the fleet had - and nothing reported it until a manual migration
    // backlog converged it by hand.
    //
    // Detection only, never a DROP: dropping a column we did not create destroys data
    // unattended, and this is the same never-DROP posture reconcileTableIndexes already
    // takes on its name-collision branch. Returns the live column names, in live order.
    undeclaredLiveColumns(expected, live){
        const declared = new Set((expected || []).map(c => String(c.name).toLowerCase()));
        return (live || []).map(c => c.COLUMN_NAME).filter(n => !declared.has(String(n).toLowerCase()));
    },

    // Live indexes that NO SQL source declares - the index half of the same gap. An index
    // counts as declared when either its NAME or its ordered COLUMN SET appears in the
    // definition (standalone CREATE INDEX or an inline key), because both forms are
    // legitimate and a renamed-but-equivalent index is the shape the reconciler already
    // treats as present. The column-set fallback is also what covers an unnamed inline
    // key, whose live name the engine invents.
    //
    // The pre-fence state_checkpoints key is the canonical case: the definition moved from
    // (chain, network, block_index, checkpoint_seq) to the narrower (chain, network,
    // checkpoint_seq), the reconciler added the new one, and the old wider UNIQUE key
    // stayed live forever because nothing ever looked for indexes the source did not name.
    undeclaredLiveIndexes(declared, byName){
        const names = new Set();
        const keys  = new Set();
        for(const d of declared || []){
            if(d.name) names.add(String(d.name).toLowerCase());
            if(d.columns && d.columns.length) keys.add(d.columns.map(c => String(c).toLowerCase()).join(','));
        }
        const out = [];
        for(const [name, info] of byName){
            if(names.has(String(name).toLowerCase())) continue;
            if(keys.has(info.cols.join(','))) continue;
            out.push({ name, unique: !!info.unique, fulltext: !!info.fulltext, columns: info.cols.slice() });
        }
        return out;
    },

    // Detect schema drift between the live table and its SQL source, and fix
    // it by ALTER. Two kinds of drift are handled:
    //   1. Missing columns - a column declared in the SQL source but absent
    //      from the live table is added with ADD COLUMN, reusing the source
    //      definition verbatim so its DEFAULT clause backfills existing rows,
    //      and placed with AFTER/FIRST so the reconciled table keeps the source's
    //      column ORDER (a bare ADD COLUMN appends, which diverges an aged table
    //      from a fresh createTable of the same definition).
    //      (A NOT NULL column with no DEFAULT can't be backfilled safely, so
    //      it's skipped with a loud warning rather than aborting startup.)
    //   2. Nullability - only relaxes NOT NULL -> NULL (the safe direction -
    //      never strengthens to NOT NULL since live rows might hold NULLs that
    //      would block the ALTER), and only when the bare MODIFY that does it
    //      would lose nothing: a MODIFY restates the WHOLE column, so a live
    //      DEFAULT / COMMENT / ON UPDATE / generation expression not named in the
    //      statement is dropped. A column carrying any of those is skipped with a
    //      loud warning and left to a dated migration (#4359).
    // Doesn't touch types or defaults of existing columns. Index reconciliation
    // is handled separately by reconcileTableIndexes(). Each applied ALTER is loudly logged.
    //
    // Byte-identity scope boundary (#2456): COLUMN position IS part of the
    // byte-identical SHOW CREATE TABLE goal - it affects on-disk row layout, which
    // is why missing columns are placed with AFTER/FIRST above and why the
    // 2026-07-16-reposition-state-key-bin migration exists. KEY / index declaration
    // ORDER is explicitly OUT of scope: MySQL/MariaDB print KEY lines in internal
    // index-creation order and attach no semantics to it, and a DROP+CREATE index
    // migration necessarily re-appends the rebuilt index at the tail, so a migrated
    // DB and a fresh install legitimately differ in KEY ordering for attests,
    // votes, and index_addresses. This is cosmetic and has no consensus effect
    // (consensus hashes ledger/state data, never SHOW CREATE TABLE text). The
    // fresh-vs-migrated schema-convergence comparator should sort KEY lines before
    // comparing; do NOT reorder the CREATE INDEX statements in the definition files
    // to chase it (that would only converge installs bootstrapped after the edit).
    async alterTableForDrift(file, db){
        const dir      = path.join(__dirname, '..', '..', 'sql');
        const data     = fs.readFileSync(dir + '/' + file, "utf8");
        const table    = file.substring(0, file.indexOf('.sql'));
        const expected = this.parseExpectedColumns(data);
        if(!expected){
            // parseExpectedColumns returns null when the file has no recognizable
            // `CREATE TABLE ... ) ENGINE ...` block (e.g. a missing ENGINE clause).
            // That silently disables ALL column-drift reconciliation for this table -
            // exactly the gap that left cross_chain_matches without its Phase B columns.
            // Make it loud so a malformed source file can't hide. (Non-fatal: index
            // reconciliation and table creation are unaffected; the parse-coverage
            // unit test is the hard guardrail.)
            getLogger().warn('Schema drift check SKIPPED for `' + table + '`: could not parse columns from ' + file + ' - expected a `CREATE TABLE ... ) ENGINE ...` definition. Additive column/nullability drift will NOT auto-reconcile for this table until the SQL source is fixed.');
            return;
        }
        const live = await db.query(
            // COLUMN_DEFAULT / COLLATION_NAME / COLUMN_COMMENT / GENERATION_EXPRESSION are
            // read for the nullability branch below: a bare MODIFY drops every attribute it
            // does not restate, so the reconciler has to see them to know what it would lose.
            "SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE, COLUMN_KEY, EXTRA, COLUMN_DEFAULT, COLLATION_NAME, COLUMN_COMMENT, GENERATION_EXPRESSION FROM information_schema.columns WHERE table_schema = ? AND table_name = ?",
            [this.dbName, table]
        );
        const liveByName = new Map(live.map(c => [c.COLUMN_NAME.toLowerCase(), c]));
        for(let i = 0; i < expected.length; i++){
            const exp = expected[i];
            const cur = liveByName.get(exp.name.toLowerCase());
            if(!cur){
                // Column declared in the SQL source but absent from the live
                // table (schema created before the column was introduced).
                await addMissingColumn(db, table, expected, i, liveByName);
                continue;
            }
            await relaxNullability(db, table, exp, cur);
        }
        // The other direction: columns the live table carries that the source declares
        // nowhere. Never healed here (a DROP would destroy data unattended), but reported
        // so a DB whose shape has diverged from a fresh install of this release says so on
        // every boot instead of being found by a hand comparison across the fleet.
        const undeclared = this.undeclaredLiveColumns(expected, live);
        if(undeclared.length){
            getLogger().warn('Schema shape drift on ' + table + ': live column(s) ' + undeclared.join(', ') +
                ' are declared by NO SQL source. Not auto-healed (never DROP a column we did not create); ' +
                'converge with a dated migration via node src/db/migration/migrate.js, or restore the declaration to ' + file + '.');
            recordShapeDrift(this.schemaShapeDrift, table, 'columns', undeclared);
        }
    },

    // Parse standalone `CREATE [UNIQUE] INDEX <name> ON <table> (<cols>)` statements
    // from a table's SQL source. Returns [{name, unique, columns:[...]}]. Inline
    // PRIMARY KEY / UNIQUE clauses inside CREATE TABLE are created with the table and
    // are not reconciled here. Index/column names come from the trusted SQL files.
    parseExpectedIndexes(sqlData, table){
        sqlData = this.stripSqlLineComments(sqlData);
        // UNIQUE and FULLTEXT are both admitted: a FULLTEXT index (contracts.meta_search)
        // was invisible to this parser, so an aged database could never self-heal it and
        // the migration was its only creation path.
        const re = /CREATE\s+(UNIQUE\s+|FULLTEXT\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?\s*\(\s*([\s\S]+?)\s*\)\s*;/gi;
        const out = [];
        let m;
        while((m = re.exec(sqlData)) !== null){
            if(m[3].toLowerCase() !== table.toLowerCase()) continue;
            // Split the column list on commas and strip backticks. Any (len) prefix is kept
            // SEPARATELY (prefixes, null = full column) so the reconciler can detect
            // prefix-width drift instead of treating a prefixed and a full-column index on
            // the same columns as identical (#2261). Sort direction is kept the same way
            // (directions) so a rebuilt index carries the declared DESC (#4357); matching
            // still keys on `columns` alone, which is direction- and width-blind by design.
            const specs = m[4].split(',').map(c => c.trim().replace(/`/g, '')).filter(Boolean);
            const parts      = specs.map(c => c.split(/\s+/)[0]);
            const columns    = parts.map(c => c.replace(/\(\d+\)$/, ''));
            const prefixes   = parts.map(c => { const pm = /\((\d+)\)$/.exec(c); return pm ? Number(pm[1]) : null; });
            const directions = specs.map(c => /\sDESC\b/i.test(c) ? 'DESC' : 'ASC');
            const kind = (m[1] || '').trim().toUpperCase();
            if(columns.length) out.push({ name: m[2], unique: kind === 'UNIQUE', fulltext: kind === 'FULLTEXT', columns, prefixes, directions });
        }
        return out;
    },

};
