#!/usr/bin/env node
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
 * Operator migration CLI.
 *
 * Indexer startup auto-applies only `auto`-tagged schema migrations (additive,
 * idempotent). This is the explicit, operator-initiated path that ALSO applies
 * pending `manual` migrations (the destructive / data-backfill / dedup-then-unique
 * ones that must not run unattended across a validator fleet). Idempotent and
 * ledger-tracked (schema_migrations), so re-running only applies what's pending.
 *
 *   node src/db/migration/migrate.js                   # or: npm run migrate
 *   node src/db/migration/migrate.js --file <name.sql> # scope the run to named file(s)
 *   node src/db/migration/migrate.js --status [--json] # read-only: report, apply nothing
 *
 * Any argument this CLI does not recognize is REFUSED with the usage text and
 * exit 2. It is never ignored: a no-argument run means APPLY EVERYTHING, so an
 * ignored token (a typo, `--dry-run`, `--help`) would silently apply every
 * pending manual migration the operator was only asking about. `--status`
 * exists for the same reason: before it shipped, the only way to see what a
 * blanket run would touch was to run it.
 *
 * Reads INDEXER_DB_* from the service environment (.env). Run with the indexer
 * process stopped if a pending migration's header says so.
 *
 ********************************************************************/

const fs       = require('fs');
const path     = require('path');
const dotenv   = require('dotenv');
dotenv.config();

const Database = require('..');
const config   = require('../../config.js');
const Utility  = require('../../utility.js');

const { CONFIG_ENV } = require('../../config.js');
// Spelled out for an operator reading it mid-incident: the difference between a
// blanket run and a scoped one is the whole risk of this command, so each mode
// says what it applies rather than naming a flag.
const USAGE = [
    'Usage: node src/db/migration/migrate.js [--file <name.sql> ...]',
    '',
    '  (no arguments)         APPLY EVERYTHING. Runs every pending migration, auto',
    '                         AND manual, against the database in INDEXER_DB_NAME.',
    '                         Manual migrations are the destructive / backfill ones.',
    '  --file, -f <name.sql>  APPLY ONE. Runs only the named migration file(s).',
    '                         Repeat the flag or comma-separate to name several.',
    '  --status               READ-ONLY. Reports which migrations are applied vs',
    '                         pending against INDEXER_DB_NAME. Applies nothing.',
    '  --status --json        Same report, as JSON on stdout.',
    '  --help, -h             Print this usage and exit 0. Touches no database.',
    '',
    'Reads INDEXER_DB_HOST / INDEXER_DB_PORT / INDEXER_DB_NAME / INDEXER_DB_USER /',
    'INDEXER_DB_PASS from the service environment (.env). Any other argument is',
    'refused with exit 2, because ignoring one would mean APPLY EVERYTHING.',
].join('\n');

// Print the usage and exit. Returns null so main() bails even where process.exit
// is stubbed (tests), instead of falling through to an apply-everything run.
function refuse(message){
    console.error('migrate: ' + message);
    console.error(USAGE);
    process.exit(2);
    return null;
}

// Parse the full argv into { only, status, json }. `only` holds `--file <name>` /
// `--file=<name>` / `-f <name>` occurrences (values may be comma-separated); []
// means no targeting flag (the apply-everything default). Returns null when the
// request was already refused or served (--help), so main() must stop.
function parseArgs(argv){
    const targets = [];
    let status = false;
    let json   = false;
    const push = (v) => {
        for(const part of String(v).split(',')){
            const name = part.trim();
            if(name) targets.push(name);
        }
    };
    for(let i = 0; i < argv.length; i++){
        const a = argv[i];
        // Usage requests are served before anything else reads the environment, so
        // asking what this command does never needs a loaded .env and never runs.
        if(a === '--help' || a === '-h'){
            console.log(USAGE);
            process.exit(0);
            return null;  // (unreachable when exit is real; keeps a stubbed exit from applying)
        }
        if(a === '--status'){ status = true; continue; }
        if(a === '--json'){ json = true; continue; }
        const named = targets.length;
        if(a === '--file' || a === '-f'){
            const v = argv[i + 1];
            if(v === undefined || v.startsWith('-')){
                return refuse(a + ' requires a migration filename argument.');
            }
            push(v);
            i++;
        } else if(a.startsWith('--file=')){
            push(a.slice('--file='.length));
        } else {
            // Refuse anything else, including a bare filename: only --file scopes a
            // run, and guessing here is what turns a typo into APPLY EVERYTHING.
            return refuse('unrecognized argument "' + a + '".');
        }
        // A targeting flag that named nothing (`--file=`, `--file ,`) would leave the
        // scope empty, and an empty scope means APPLY EVERYTHING: the opposite of
        // what the operator asked for. Refuse instead of widening the run.
        if(targets.length === named){
            return refuse(a + ' names no migration file.');
        }
    }
    if(json && !status) return refuse('--json only means something alongside --status.');
    if(status && targets.length) return refuse('--status cannot be combined with --file/-f.');
    return { only: targets, status, json };
}

// Migration source directory, resolved the same way runMigrations resolves it
// (src/db/database/../../sql/migrations); migrate.js sits one directory over, at
// src/db/migration/, but two levels up lands in the same place.
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'sql', 'migrations');

// The applied-migration ledger, read-only. A missing schema_migrations table (a
// database no run has ever touched) is not an error here: it just means nothing
// is applied yet, same as runMigrations' own dir-missing case.
async function readAppliedLedger(db){
    const conn = await db.getConnection();
    try {
        const rows = await conn.query('SELECT name, mode, applied_at FROM schema_migrations');
        return new Map(rows.map(r => [r.name, { mode: r.mode, appliedAt: r.applied_at }]));
    } catch(err){
        if(err && (err.errno === 1146 || err.code === 'ER_NO_SUCH_TABLE')) return new Map();
        throw err;
    } finally {
        try { await conn.release(); } catch(_){}
    }
}

// `--status`: report applied vs. pending against the live ledger without ever
// opening the migration lock or running a statement.
async function reportStatus(db, dbName, json){
    let files;
    try { files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort(); }
    catch(_){ files = []; }

    const applied = await readAppliedLedger(db);
    const rows = files.map(file => {
        const record = applied.get(file);
        return record
            ? { file, applied: true, mode: record.mode, appliedAt: record.appliedAt }
            : { file, applied: false, mode: db.migrationMode(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')), appliedAt: null };
    });
    const pendingCount = rows.filter(r => !r.applied).length;

    if(json){
        console.log(JSON.stringify({
            database: dbName,
            total: rows.length,
            applied: rows.length - pendingCount,
            pending: pendingCount,
            migrations: rows,
        }, null, 2));
        return;
    }

    console.log('migrate: status for ' + dbName + ' (read-only; nothing applied)');
    for(const r of rows){
        console.log('  [' + (r.applied ? 'applied' : 'PENDING') + ', mode=' + r.mode + '] ' + r.file +
            (r.applied && r.appliedAt ? ' (applied_at=' + r.appliedAt + ')' : ''));
    }
    console.log('migrate: ' + rows.length + ' migration(s), ' + (rows.length - pendingCount) + ' applied, ' + pendingCount + ' pending.');
}

async function main(){
    // Argv is settled first so `--help` answers without a loaded .env, and so a
    // refused argument never reaches the database checks below.
    const parsed = parseArgs(process.argv.slice(2));
    if(parsed === null) return;

    const host = CONFIG_ENV.INDEXER_DB_HOST;
    const port = CONFIG_ENV.INDEXER_DB_PORT;
    const name = CONFIG_ENV.INDEXER_DB_NAME;
    const user = CONFIG_ENV.INDEXER_DB_USER;
    const pass = CONFIG_ENV.INDEXER_DB_PASS;
    if(!host || !name || !user){
        console.error('migrate: INDEXER_DB_HOST / INDEXER_DB_NAME / INDEXER_DB_USER must be set (load the service .env).');
        process.exit(2);
    }

    // The Database constructor only needs { config, util } off its parent.
    // Share ONE config object between the two (see Utility constructor).
    const cfg = config.getConfig();
    const indexerLike = { config: cfg, util: new Utility(cfg) };
    const db = new Database(host, port, name, user, pass, indexerLike);

    if(parsed.status){
        try {
            await reportStatus(db, name, parsed.json);
        } catch(err){
            console.error('migrate: STATUS FAILED: ' + ((err && err.stack) || err));
            process.exitCode = 1;
        } finally {
            try { if(db.pool) await db.pool.end(); } catch(_){}
        }
        return;
    }

    try {
        const runOpts = { includeManual: true };
        if(parsed.only.length){
            runOpts.only = parsed.only;
            console.log('migrate: applying ONLY targeted migration(s) ' + JSON.stringify(parsed.only) + ' to ' + name + ' ...');
        } else {
            console.log('migrate: applying pending migrations (auto + manual) to ' + name + ' ...');
        }
        const res = await db.runMigrations(runOpts);
        if(res.lockSkipped){
            // A lock-skip examined nothing; do not report it as a completed run.
            console.error('migrate: SKIPPED - another process holds the migration lock (xchain_migrate_' + name + '). Nothing was applied and the schema may still be un-migrated. Re-run once the other migrator finishes.');
            process.exitCode = 2;
        } else {
            console.log('migrate: done. applied=' + JSON.stringify(res.applied) + ' still-pending=' + JSON.stringify(res.pending));
        }
    } catch(err){
        console.error('migrate: FAILED: ' + ((err && err.stack) || err));
        process.exitCode = 1;
    } finally {
        try { if(db.pool) await db.pool.end(); } catch(_){}
    }
}

main();
