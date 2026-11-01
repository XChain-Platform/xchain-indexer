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
 * NAME/USER/PASS, INDEXER_COIN, INDEXER_NETWORK). Exits 0 on success, 1 when
 * a batched net differs from the per-key net, and 2 on a usage or database error.
 *
 * Usage:  node bin/bench_net_balance.js [--keys N] [--repeat R] [--blocks N] [--db NAME] [--batched] [--json]
 *
 * --batched (default off) also times the grouped getNetBalances over the same
 * hot keys, after the per-key timings, and checks each batched net against the
 * net the per-key read recorded. A mismatch sets the exit status to 1.
 *
 ********************************************************************/

'use strict';

const {
    getNetBalance,
    getNetBalances,
    getHottestLedgerKeys,
    ledgerKeysForBlock
} = require('../src/db/state_commitment/ledger_reads.js');

const DEFAULTS = { keys: 20, repeat: 3, blocks: 0, db: null, json: false, batched: false };

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
        else if(a === '--blocks') opts.blocks = positiveInt(a, argv[++i]);
        else if(a === '--db'){
            opts.db = argv[++i];
            if(!opts.db) throw new Error('--db needs a database name');
        }
        else if(a === '--json')   opts.json = true;
        else if(a === '--batched') opts.batched = true;
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

function recentLedgerBlocksQuery(limit){
    return {
        sql: `SELECT DISTINCT s.block_index AS block_index FROM (
                SELECT a.block_index FROM credits c
                  INNER JOIN actions a ON a.action_index = c.action_index
                UNION ALL
                SELECT a.block_index FROM debits d
                  INNER JOIN actions a ON a.action_index = d.action_index
              ) s
              ORDER BY s.block_index DESC
              LIMIT ?`,
        args: [limit]
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

// Times getNetBalances over the keys timeKeys measured, as [address, tick] pairs, `repeat`
// times: the first read is coldMs, the fastest is ms. mismatches counts keys whose
// batched net differs from the net timeKeys recorded.
async function timeBatch(db, timings, repeat, now){
    const clock = now || (() => Number(process.hrtime.bigint()) / 1e6);
    const pairs = timings.map(t => [t.address, t.tick]);
    let best = Infinity, cold = null, nets = new Map();
    for(let i = 0; i < repeat; i++){
        const t0 = clock();
        nets = await getNetBalances(db, pairs);
        const dt = clock() - t0;
        if(cold === null) cold = dt;
        if(dt < best) best = dt;
    }
    const keys = timings.length;
    const ms = cold === null ? 0 : best;
    let mismatches = 0;
    for(const t of timings)
        if(nets.get(t.address + '\t' + t.tick) !== t.net) mismatches++;
    return { keys, coldMs: cold === null ? 0 : cold, ms, perKeyMs: keys ? ms / keys : 0, mismatches };
}

async function timeBlocks(db, limit, repeat, now){
    const clock = now || (() => Number(process.hrtime.bigint()) / 1e6);
    const query = recentLedgerBlocksQuery(limit);
    const rows = await db.doQueryStrict(query.sql, query.args);
    const blocks = [];
    for(const row of (rows || [])){
        const block = Number(row.block_index);
        const keysStarted = clock();
        const keySet = await ledgerKeysForBlock(db, block);
        const keysMs = clock() - keysStarted;
        const pairs = Array.from(keySet, key => key.split('\t'));
        let coldMs = null;
        let bestMs = Infinity;
        for(let i = 0; i < repeat; i++){
            const started = clock();
            await getNetBalances(db, pairs);
            const elapsed = clock() - started;
            if(coldMs === null) coldMs = elapsed;
            if(elapsed < bestMs) bestMs = elapsed;
        }
        blocks.push({
            block,
            keys: pairs.length,
            keysMs,
            coldMs: coldMs === null ? 0 : coldMs,
            ms: coldMs === null ? 0 : bestMs
        });
    }
    const timings = blocks.map(block => block.ms);
    return {
        blocks,
        summary: {
            count: blocks.length,
            maxKeys: blocks.length ? Math.max(...blocks.map(block => block.keys)) : 0,
            p50Ms: percentile(timings, 50),
            p95Ms: percentile(timings, 95),
            maxMs: timings.length ? Math.max(...timings) : 0
        }
    };
}

async function bench(db, opts, now){
    const keys = await getHottestLedgerKeys(db, opts.keys);
    const timings = await timeKeys(db, keys, opts.repeat, now);
    const result = { keys: keys.length, repeat: opts.repeat, timings, summary: summarize(timings) };
    if(opts.batched) result.batch = await timeBatch(db, timings, opts.repeat, now);
    if(opts.blocks > 0) result.perBlock = await timeBlocks(db, opts.blocks, opts.repeat, now);
    return result;
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
    const b = result.batch;
    if(b)
        lines.push('# batch keys=' + b.keys + ' repeat=' + result.repeat + ' cold=' + b.coldMs.toFixed(2) +
                   'ms best=' + b.ms.toFixed(2) + 'ms per-key=' + b.perKeyMs.toFixed(2) +
                   'ms mismatches=' + b.mismatches);
    const perBlock = result.perBlock;
    if(perBlock){
        for(const block of perBlock.blocks)
            lines.push('# block ' + block.block + ' keys=' + block.keys + ' keys-read=' + block.keysMs.toFixed(2) +
                       'ms cold=' + block.coldMs.toFixed(2) + 'ms best=' + block.ms.toFixed(2) + 'ms');
        const summary = perBlock.summary;
        lines.push('# per-block blocks=' + summary.count + ' max-keys=' + summary.maxKeys +
                   ' p50=' + summary.p50Ms.toFixed(2) + 'ms p95=' + summary.p95Ms.toFixed(2) +
                   'ms max=' + summary.maxMs.toFixed(2) + 'ms');
    }
    return lines.join('\n');
}

function exitCodeFor(result){
    return result.batch && result.batch.mismatches > 0 ? 1 : 0;
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
        const result = await bench(db, opts);
        console.log(render(result, opts.json));
        return exitCodeFor(result);
    } finally {
        if(db.close) await db.close();
    }
}

if(require.main === module){
    main(process.argv.slice(2)).then(code => {
        process.exit(code);
    }).catch(err => {
        console.error('bench_net_balance: ' + err.message);
        process.exit(2);
    });
}

module.exports = {
    parseArgs,
    percentile,
    summarize,
    recentLedgerBlocksQuery,
    timeKeys,
    timeBatch,
    timeBlocks,
    bench,
    render,
    exitCodeFor
};
