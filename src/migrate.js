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
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Operator migration CLI.
 *
 * Indexer startup auto-applies only `auto`-tagged schema migrations (additive,
 * idempotent). This is the explicit, operator-initiated path that ALSO applies
 * pending `manual` migrations — the destructive / data-backfill / dedup-then-unique
 * ones that must not run unattended across a validator fleet. Idempotent and
 * ledger-tracked (schema_migrations), so re-running only applies what's pending.
 *
 *   node src/migrate.js          # or: npm run migrate
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

    // The Database constructor only needs { config, util } off its parent.
    const indexerLike = { config: config.getConfig(), util: new Utility() };
    const db = new Database(host, port, name, user, pass, indexerLike);

    try {
        console.log('migrate: applying pending migrations (auto + manual) to ' + name + ' ...');
        const res = await db.runMigrations({ includeManual: true });
        console.log('migrate: done. applied=' + JSON.stringify(res.applied) + ' still-pending=' + JSON.stringify(res.pending));
    } catch(err){
        console.error('migrate: FAILED — ' + ((err && err.stack) || err));
        process.exitCode = 1;
    } finally {
        try { if(db.pool) await db.pool.end(); } catch(_){}
    }
}

main();
