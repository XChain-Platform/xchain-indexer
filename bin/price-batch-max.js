#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 *********************************************************************/

'use strict';

function parseArgs(argv){
    const out = { db: null, chain: 'BTC', network: 'regtest' };
    for(let i = 2; i < argv.length; i++){
        switch(argv[i]){
            case '--db':      out.db      = argv[++i]; break;
            case '--chain':   out.chain   = String(argv[++i] || '').toUpperCase(); break;
            case '--network': out.network = argv[++i]; break;
            default: console.error('unknown arg: ' + argv[i]); process.exit(64);
        }
    }
    if(!out.db){ console.error('--db <database> is required'); process.exit(64); }
    return out;
}

(async () => {
    const opts = parseArgs(process.argv);
    const host = process.env.INDEXER_DB_HOST, port = process.env.INDEXER_DB_PORT;
    const user = process.env.INDEXER_DB_USER, pass = process.env.INDEXER_DB_PASS;
    if(!host || !user){
        console.error('INDEXER_DB_HOST and INDEXER_DB_USER are required');
        process.exit(2);
    }

    const Database = require('../src/db');
    const config   = require('../src/config.js');
    const Utility  = require('../src/utility.js');
    const cfg = config.getConfig(opts.chain, opts.network);
    const db  = new Database(host, port, opts.db, user, pass, { config: cfg, util: new Utility(cfg) });
    const tipBlock = await db.getLatestBlockIndex();
    const tipBlockTime = Number(await db.getBlockTime(tipBlock)) || 0;
    const maxBatchBlockTime = await db.getMaxBatchBlockTime();

    const reading = JSON.stringify({
        chain: opts.chain + ':' + opts.network,
        tipBlockTime,
        maxBatchBlockTime,
        readAt: Math.floor(Date.now() / 1000)
    });
    process.stdout.write(reading + '\n', () => process.exit(0));
})().catch(err => { console.error(err); process.exit(1); });
