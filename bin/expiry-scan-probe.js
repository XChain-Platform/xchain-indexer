#!/usr/bin/env node
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
 * Print the EXPLAIN plan and per-query wall time of the per-block expiry scans
 * (getExpiredItems and findCancelledDispensers) against the indexer DB named by the
 * INDEXER_DB_* settings, plus whether the cancelled-dispenser latest-status probe reads
 * the dispenser_action_action index. Read-only: every statement goes through
 * src/db/probes/expiry_scan.js, which refuses anything but a SELECT, and this script
 * holds no SQL of its own.
 *
 *   node bin/expiry-scan-probe.js                     probe at the latest parsed block
 *   node bin/expiry-scan-probe.js --block-index 900   probe as of block 900
 *   node bin/expiry-scan-probe.js --block-time 1700000000 --block-index 900
 *   node bin/expiry-scan-probe.js --json              the raw result as JSON
 *
 ********************************************************************/

'use strict';

const USAGE = 'usage: expiry-scan-probe.js [--block-index <n>] [--block-time <unix>] [--json]';

function parseArgs(argv){
    const opts = { blockIndex: null, blockTime: null, json: false };
    for(let i = 0; i < argv.length; i++){
        const arg = argv[i];
        if(arg === '--json'){ opts.json = true; continue; }
        if(arg === '--block-index' || arg === '--block-time'){
            const value = Number(argv[i + 1]);
            if(!Number.isSafeInteger(value) || value < 0) throw new Error(arg + ' needs a non-negative integer\n' + USAGE);
            opts[arg === '--block-index' ? 'blockIndex' : 'blockTime'] = value;
            i += 1;
            continue;
        }
        throw new Error('unknown argument ' + arg + '\n' + USAGE);
    }
    return opts;
}

// Open the indexer DB through the standard Database class, as the indexer itself does.
function openIndexerDb(){
    require('dotenv').config();
    // Required after dotenv: src/config.js captures the environment once at load.
    const config   = require('../src/config.js');
    const Database = require('../src/db');
    const Utility  = require('../src/utility.js');
    const env = config.CONFIG_ENV;
    for(const key of ['INDEXER_DB_HOST', 'INDEXER_DB_PORT', 'INDEXER_DB_NAME', 'INDEXER_DB_USER', 'INDEXER_DB_PASS']){
        if(!env[key]) throw new Error('Missing required environment variable: ' + key);
    }
    const parent = { config: config.getConfig(), util: new Utility() };
    const db = new Database(env.INDEXER_DB_HOST, env.INDEXER_DB_PORT, env.INDEXER_DB_NAME,
        env.INDEXER_DB_USER, env.INDEXER_DB_PASS, parent);
    parent.indexerDb = db;
    return db;
}

function jsonText(value){
    return JSON.stringify(value, (key, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

// Probe one block's expiry scans and write the report. `deps` lets a test supply the db
// and capture the output; a missing --block-index or --block-time comes from the DB.
async function main(argv, deps){
    const { probeExpiryScan, renderExpiryScanProbe } = require('../src/db/probes/expiry_scan.js');
    const opts  = parseArgs(argv);
    const write = (deps && deps.write) || (text => process.stdout.write(text));
    const db    = (deps && deps.db) || openIndexerDb();
    try {
        const blockIndex = opts.blockIndex != null ? opts.blockIndex : await db.getLatestBlockIndex();
        const blockTime  = opts.blockTime  != null ? opts.blockTime  : Number(await db.getBlockTime(blockIndex));
        const result = await probeExpiryScan(db, { blockTime, blockIndex, clock: deps && deps.clock });
        write((opts.json ? jsonText(result) : renderExpiryScanProbe(result)) + '\n');
        return result;
    } finally {
        if(!(deps && deps.db) && db.pool) await db.pool.end();
    }
}

if(require.main === module){
    main(process.argv.slice(2)).catch(err => {
        process.stderr.write('expiry-scan-probe: ' + ((err && err.message) || err) + '\n');
        process.exit(1);
    });
}

module.exports = { parseArgs, main };
