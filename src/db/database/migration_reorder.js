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
 * XChain Indexer - migration reorder analysis
 *
 * The object-level half of the backdating guard. backdatedFrontierViolation says only
 * THAT a pending migration sorts before an applied one; these say whether that reorder
 * can actually produce a different schema, by reading which tables each file touches.
 *
 * Two migrations applied in either order leave the same schema when the object sets
 * they touch are disjoint: no statement in one can observe or be observed by the other.
 * When the sets intersect, order is observable (column position under AFTER, which index
 * a later DROP finds, what a backfill's WHERE clause sees) and the guard must stay loud.
 *
 * Attribution is a WHITELIST: a statement whose target table cannot be read off its
 * prefix is `opaque`, and an opaque statement on either side forces the divergent
 * verdict. Being wrong in the quiet direction is the only failure mode that matters
 * here, so every unrecognized form shouts.
 *
 * Plain module functions, not Database.prototype methods: they take statement lists and
 * never a connection, so migration_runner.js requires them directly and db/index.js has
 * nothing to install.
 *
 ********************************************************************/

'use strict';

// A table identifier: backtick-quoted or bare, optionally schema-qualified. The capture
// is the table part, so `XChain_Indexer`.`tokens` and tokens both yield tokens.
const IDENT = '(?:`[^`]+`|[A-Za-z0-9_$]+)';
const QUAL  = '(?:' + IDENT + '\\s*\\.\\s*)?(' + IDENT + ')';

// Statement forms whose target table is readable straight off the prefix. Each is
// anchored at the statement start, so a keyword appearing later in the body cannot
// match. Everything not listed here is opaque by construction.
const TABLE_FORMS = [
    new RegExp('^ALTER\\s+(?:ONLINE\\s+|IGNORE\\s+)*TABLE\\s+' + QUAL, 'i'),
    new RegExp('^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?' + QUAL, 'i'),
    new RegExp('^CREATE\\s+(?:UNIQUE\\s+|FULLTEXT\\s+|SPATIAL\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?' + IDENT + '\\s+ON\\s+' + QUAL, 'i'),
    new RegExp('^DROP\\s+INDEX\\s+(?:IF\\s+EXISTS\\s+)?' + IDENT + '\\s+ON\\s+' + QUAL, 'i'),
    new RegExp('^TRUNCATE\\s+(?:TABLE\\s+)?' + QUAL, 'i'),
];

const DROP_TABLE_HEAD = new RegExp('^DROP\\s+(?:TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+EXISTS\\s+)?', 'i');
const REFERENCES_RE   = new RegExp('\\bREFERENCES\\s+' + QUAL, 'gi');

// One table name as the comparison sees it. MariaDB table names are case-insensitive on
// the platform's installs and backticks are decoration, so both are normalized away.
const normalizeTable = (name) => String(name).replace(/`/g, '').trim().toLowerCase();

// The tables one statement touches: { tables: [...] } when the form is recognized, or
// { opaque: <the statement> } when it is not and the caller must assume the worst.
function statementTables(rawStmt){
    // Versioned comments (/*!50000 ... */, /*M! ... */) are executed verbatim by the
    // server but removed by the block-comment strip below, so the payload would be
    // invisible after it - the same blind spot destructiveAutoStatement refuses to
    // accept. Checked on the RAW statement and before the empty test, because a
    // statement that is nothing but a versioned comment strips to the empty string and
    // would otherwise read as touching nothing at all.
    if(/\/\*(?:!|M!)/.test(String(rawStmt))) return { tables: [], opaque: String(rawStmt).trim().slice(0, 120) };
    const stmt = String(rawStmt).replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
    if(!stmt) return { tables: [], opaque: null };
    // A session-variable SET (SET NAMES, SET sql_mode) touches no table. A user-variable
    // SET (SET @s = ...) stages dynamic SQL whose target cannot be read, so it falls
    // through to the opaque default below.
    if(/^SET\s+(?!@(?!@))/i.test(stmt)) return { tables: [], opaque: null };
    // A SELECT anywhere means the statement reads rows from tables the prefix does not
    // name (CREATE TABLE ... SELECT, INSERT ... SELECT, a correlated UPDATE subquery).
    // Enumerating those sources is a query parser's job, so refuse instead.
    if(/\bSELECT\b/i.test(stmt)) return { tables: [], opaque: stmt.slice(0, 120) };

    const tables = [];
    let recognized = false;
    for(const form of TABLE_FORMS){
        const m = form.exec(stmt);
        if(m){ tables.push(normalizeTable(m[1])); recognized = true; break; }
    }
    // DROP TABLE takes a comma-separated list, so it is read apart from the single-target
    // forms above rather than folded into them.
    if(DROP_TABLE_HEAD.test(stmt)){
        const list = stmt.replace(DROP_TABLE_HEAD, '').replace(/[;\s]+$/, '');
        for(const one of list.split(',')) tables.push(normalizeTable(one.split('.').pop()));
        recognized = true;
    }
    if(!recognized) return { tables: [], opaque: stmt.slice(0, 120) };

    // A foreign key names a second table the statement depends on, so it joins the set.
    REFERENCES_RE.lastIndex = 0;
    let ref;
    while((ref = REFERENCES_RE.exec(stmt)) !== null) tables.push(normalizeTable(ref[1]));
    return { tables, opaque: null };
}

// Every table a migration file touches, folded over its statements. Stops at the first
// opaque statement: one unreadable statement already settles the verdict, and the
// statement text is what the operator needs to see.
function migrationTouchedTables(statements){
    const tables = new Set();
    for(const raw of (statements || [])){
        const one = statementTables(raw);
        if(one.opaque) return { tables: [...tables].sort(), opaque: one.opaque };
        for(const t of one.tables) tables.add(t);
    }
    return { tables: [...tables].sort(), opaque: null };
}

// Can applying `pending` here, after the already-applied migrations it sorts before,
// leave a different schema than a fresh database gets?
//
// `pending` is { file, statements }. `jumped` is one entry per already-applied migration
// that sorts AFTER the pending file, each { file, statements }, with statements null when
// the file could not be read from the tree (a migration deleted after the fleet applied
// it: unreadable is unprovable, so it counts as opaque).
//
// Returns { divergent, tables, shared, opaque }: `tables` is what the pending file
// touches, `shared` lists each jumped file with the tables it has in common, `opaque`
// lists each file whose SQL could not be attributed and why.
function reorderVerdict(pending, jumped){
    const mine   = migrationTouchedTables(pending && pending.statements);
    const shared = [];
    const opaque = [];
    if(mine.opaque) opaque.push({ file: pending.file, reason: mine.opaque });
    for(const other of (jumped || [])){
        if(!other.statements){
            opaque.push({ file: other.file, reason: 'not readable in the migrations directory' });
            continue;
        }
        const theirs = migrationTouchedTables(other.statements);
        if(theirs.opaque){ opaque.push({ file: other.file, reason: theirs.opaque }); continue; }
        const common = theirs.tables.filter(t => mine.tables.includes(t));
        if(common.length) shared.push({ file: other.file, tables: common });
    }
    return {
        divergent: (shared.length > 0 || opaque.length > 0),
        tables:    mine.tables,
        shared,
        opaque,
    };
}

// The operator-facing half of the verdict: which objects are at stake, named. An
// operator reading a boot log has no way to act on "review manually", so every branch
// here ends in a concrete table list or a concrete statement.
function describeReorder(verdict, jumpedCount){
    const touched = verdict.tables.length ? verdict.tables.join(', ') : '(no table)';
    if(!verdict.divergent){
        return 'it touches ' + touched + ', and none of the ' + jumpedCount +
            ' already-applied migration(s) it sorts before touch those tables, so both ' +
            'orders leave the same schema.';
    }
    // One example of each kind plus a count, not the whole list. A divergence report an
    // operator has to scroll is one nobody reads: the first shared object names the thing
    // to look at, and the count says how much else is behind it.
    const parts = [];
    if(verdict.shared.length){
        const first = verdict.shared[0];
        parts.push('already-applied ' + first.file + ' touches the same table(s): ' + first.tables.join(', ') +
            (verdict.shared.length > 1 ? ' (and ' + (verdict.shared.length - 1) + ' more applied migration(s) overlap)' : ''));
    }
    if(verdict.opaque.length){
        const first = verdict.opaque[0];
        parts.push(verdict.opaque.length + ' migration(s) could not be attributed to a table, so no overlap can be ' +
            'ruled out - first is ' + first.file + ': "' + String(first.reason).replace(/\s+/g, ' ').slice(0, 100) + '"');
    }
    return 'it touches ' + touched + ' and ' + parts.join('; ') + '.';
}

module.exports = {
    statementTables,
    migrationTouchedTables,
    reorderVerdict,
    describeReorder,
};
