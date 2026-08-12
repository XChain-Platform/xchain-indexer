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
 *   node src/migrate.js                       # or: npm run migrate
 *   node src/migrate.js --file <name.sql>     # scope the run to named file(s)
 *
 * Reads INDEXER_DB_* from the service environment (.env). Run with the indexer
 * process stopped if a pending migration's header says so.
 *
 ********************************************************************/

const dotenv   = require('dotenv');
dotenv.config();

const Database = require('./db.js');
const config   = require('./config.js');
const Utility  = require('./utility.js');

// Parse `--file <name>` / `--file=<name>` / `-f <name>` occurrences into a list of
// migration filenames to scope the run to. Values may be comma-separated. Returns []
// when no targeting flag is present (the default apply-everything behavior).
function parseFileTargets(argv){
    const targets = [];
    const push = (v) => {
        for(const part of String(v).split(',')){
            const name = part.trim();
            if(name) targets.push(name);
        }
    };
    for(let i = 0; i < argv.length; i++){
        const a = argv[i];
        if(a === '--file' || a === '-f'){
            const v = argv[i + 1];
            if(v === undefined || v.startsWith('-')){
                console.error('migrate: ' + a + ' requires a migration filename argument.');
                process.exit(2);
                return targets;  // (unreachable when exit is real; guards stubbed-exit tests)
            }
            push(v);
            i++;
        } else if(a.startsWith('--file=')){
            push(a.slice('--file='.length));
        }
    }
    return targets;
}

async function main(){
    const host = process.env.INDEXER_DB_HOST;
    const port = process.env.INDEXER_DB_PORT;
    const name = process.env.INDEXER_DB_NAME;
    const user = process.env.INDEXER_DB_USER;
    const pass = process.env.INDEXER_DB_PASS;
    if(!host || !name || !user){
        console.error('migrate: INDEXER_DB_HOST / INDEXER_DB_NAME / INDEXER_DB_USER must be set (load the service .env).');
        process.exit(2);
    }

    const only = parseFileTargets(process.argv.slice(2));

    // The Database constructor only needs { config, util } off its parent.
    // Share ONE config object between the two (see Utility constructor).
    const cfg = config.getConfig();
    const indexerLike = { config: cfg, util: new Utility(cfg) };
    const db = new Database(host, port, name, user, pass, indexerLike);

    try {
        const runOpts = { includeManual: true };
        if(only.length){
            runOpts.only = only;
            console.log('migrate: applying ONLY targeted migration(s) ' + JSON.stringify(only) + ' to ' + name + ' ...');
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
