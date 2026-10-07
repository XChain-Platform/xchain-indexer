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
 * XChain Indexer - getNetBalance benchmark
 *
 * Read-only. Picks the (address, tick) pairs with the longest credit/debit
 * history in one venue database and times getNetBalance for each through the
 * indexer's own db layer, then prints per-key timings and p50/p95/max.
 * Issues SELECTs only.
 *
 * Reads connection settings from the indexer environment (INDEXER_DB_HOST/PORT/
 * NAME/USER/PASS, INDEXER_COIN, INDEXER_NETWORK).
 *
 * Usage:  node scripts/bench_net_balance.js [--keys N] [--repeat R] [--db NAME] [--json]
 *
 ********************************************************************/

'use strict';

const { getNetBalance, getHottestLedgerKeys } = require('../src/db/state_commitment/ledger_reads.js');

const DEFAULTS = { keys: 20, repeat: 3, db: null, json: false };

function positiveInt(flag, raw){
    const n = Number(raw);
    if(!Number.isInteger(n) || n < 1)
        throw new Error(flag + ' needs a positive integer, got "' + raw + '"');
    return n;
}

function parseArgs(argv){
    const opts = Object.assign({}, DEFAULTS);
    for(let i = 0; i < argv.length; i++){
        const a = argv[i];
        if(a === '--keys')        opts.keys   = positiveInt(a, argv[++i]);
        else if(a === '--repeat') opts.repeat = positiveInt(a, argv[++i]);
        else if(a === '--db'){
            opts.db = argv[++i];
            if(!opts.db) throw new Error('--db needs a database name');
        }
        else if(a === '--json')   opts.json = true;
        else throw new Error('unknown argument ' + a);
    }
    return opts;
}

// Nearest-rank percentile over an unsorted list of numbers.
function percentile(values, p){
    if(!values.length) return 0;
    const sorted = values.slice().sort((x, y) => x - y);
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
    return sorted[rank - 1];
}

function summarize(timings){
    const ms = timings.map(t => t.ms);
    return {
        count: ms.length,
        totalMs: ms.reduce((x, y) => x + y, 0),
        p50Ms: percentile(ms, 50),
        p95Ms: percentile(ms, 95),
        maxMs: ms.length ? Math.max(...ms) : 0
    };
}

// Each key is read `repeat` times and the fastest read kept, so a cold buffer pool
// on the first read does not stand in for the steady-state cost. The first read's
// time is reported separately as coldMs.
async function timeKeys(db, keys, repeat, now){
    const clock = now || (() => Number(process.hrtime.bigint()) / 1e6);
    const out = [];
    for(const k of keys){
        let best = Infinity, cold = null, net = null;
        for(let i = 0; i < repeat; i++){
            const t0 = clock();
            net = await getNetBalance(db, k.address, k.tick);
            const dt = clock() - t0;
            if(cold === null) cold = dt;
            if(dt < best) best = dt;
        }
        out.push({ address: k.address, tick: k.tick, rows: k.rows, net, coldMs: cold, ms: best });
    }
    return out;
}

async function bench(db, opts, now){
    const keys = await getHottestLedgerKeys(db, opts.keys);
    const timings = await timeKeys(db, keys, opts.repeat, now);
    return { keys: keys.length, repeat: opts.repeat, timings, summary: summarize(timings) };
}

function render(result, json){
    if(json) return JSON.stringify(result, null, 2);
    const lines = ['# rows     cold ms   best ms   tick  address'];
    for(const t of result.timings)
        lines.push(String(t.rows).padEnd(10) + t.coldMs.toFixed(2).padEnd(10) +
                   t.ms.toFixed(2).padEnd(10) + t.tick + '  ' + t.address);
    const s = result.summary;
    lines.push('# keys=' + s.count + ' repeat=' + result.repeat + ' p50=' + s.p50Ms.toFixed(2) +
               'ms p95=' + s.p95Ms.toFixed(2) + 'ms max=' + s.maxMs.toFixed(2) + 'ms');
    return lines.join('\n');
}

async function openIndexerDb(opts){
    const Database = require('../src/db');
    const config   = require('../src/config.js');
    const Utility  = require('../src/utility.js');
    const host = process.env.INDEXER_DB_HOST;
    const port = process.env.INDEXER_DB_PORT;
    const user = process.env.INDEXER_DB_USER;
    const pass = process.env.INDEXER_DB_PASS;
    const name = opts.db || process.env.INDEXER_DB_NAME;
    if(!host || !user || !name)
        throw new Error('INDEXER_DB_HOST / INDEXER_DB_USER / INDEXER_DB_NAME must be set');
    const cfg = config.getConfig();
    return new Database(host, port, name, user, pass, { config: cfg, util: new Utility(cfg) });
}

async function main(argv){
    require('dotenv').config();
    const opts = parseArgs(argv);
    const db = await openIndexerDb(opts);
    try {
        console.log(render(await bench(db, opts), opts.json));
    } finally {
        if(db.close) await db.close();
    }
}

if(require.main === module){
    main(process.argv.slice(2)).catch(err => {
        console.error('bench_net_balance: ' + err.message);
        process.exit(1);
    });
}

module.exports = { parseArgs, percentile, summarize, timeKeys, bench, render };
