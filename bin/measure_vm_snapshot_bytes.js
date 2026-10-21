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
 * XChain Indexer - VM snapshot byte measurement
 *
 * Read-only. Builds the uncached cross-chain VM snapshot for recent
 * contract-execution blocks and reports its serialized size, build time and
 * serialization time. The serialization time is the sending half of the
 * worker IPC send: one JSON.stringify of the snapshot per send.
 *
 * Usage: node bin/measure_vm_snapshot_bytes.js
 *        [--from N] [--to N] [--limit N] [--db NAME] [--cached] [--json]
 *
 ********************************************************************/

'use strict';

const DEFAULTS = { from: null, to: null, limit: 50, db: null, cached: false, json: false };

function integerArg(flag, value, positive){
    if(value === undefined || !/^\d+$/.test(value))
        throw new Error(flag + ' needs ' + (positive ? 'a positive' : 'a non-negative') + ' integer');
    const number = Number(value);
    if(!Number.isSafeInteger(number) || (positive ? number <= 0 : number < 0))
        throw new Error(flag + ' needs ' + (positive ? 'a positive' : 'a non-negative') + ' integer');
    return number;
}

function parseArgs(argv){
    const opts = Object.assign({}, DEFAULTS);
    for(let i = 0; i < argv.length; i++){
        const arg = argv[i];
        if(arg === '--from') opts.from = integerArg(arg, argv[++i], false);
        else if(arg === '--to') opts.to = integerArg(arg, argv[++i], false);
        else if(arg === '--limit') opts.limit = integerArg(arg, argv[++i], true);
        else if(arg === '--db'){
            opts.db = argv[++i];
            if(!opts.db) throw new Error('--db needs a database name');
        }
        else if(arg === '--cached') opts.cached = true;
        else if(arg === '--json') opts.json = true;
        else throw new Error('unknown argument ' + arg);
    }
    return opts;
}

function vmBlocksQuery(opts){
    const where = [];
    const args = [];
    if(opts.from !== null){
        where.push('block_index >= ?');
        args.push(opts.from);
    }
    if(opts.to !== null){
        where.push('block_index <= ?');
        args.push(opts.to);
    }
    args.push(opts.limit);
    return {
        sql: `SELECT block_index, COUNT(*) AS executions
                FROM contract_executions
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               GROUP BY block_index
               ORDER BY block_index DESC
               LIMIT ?`,
        args,
    };
}

async function measure(db, opts, now = Date.now){
    const query = vmBlocksQuery(opts);
    const rows = await db.doQueryStrict(query.sql, query.args);
    const blocks = [];
    for(const row of (rows || [])){
        const blockIndex = Number(row.block_index);
        const started = now();
        const snapshot = await db.buildCrossChainDataForVM(blockIndex);
        const built = now();
        const buildMs = built - started;
        const serializeStarted = now();
        const serialized = JSON.stringify(snapshot);
        const serializeMs = now() - serializeStarted;
        const bytes = Buffer.byteLength(serialized);
        const executions = Number(row.executions);
        blocks.push({
            blockIndex,
            executions,
            bytes,
            buildMs,
            serializeMs,
            sentBeforeMs: serializeMs * executions,
            sentAfterMs: serializeMs,
            sentBefore: bytes * executions,
            sentAfter: bytes,
        });
    }
    const result = {
        blocks,
        scanned: blocks.length,
        maxBytes: blocks.reduce((max, block) => Math.max(max, block.bytes), 0),
        maxBuildMs: blocks.reduce((max, block) => Math.max(max, block.buildMs), 0),
        maxSerializeMs: blocks.reduce((max, block) => Math.max(max, block.serializeMs), 0),
        sentBeforeMs: blocks.reduce((sum, block) => sum + block.sentBeforeMs, 0),
        sentAfterMs: blocks.reduce((sum, block) => sum + block.sentAfterMs, 0),
        sentBeforeBytes: blocks.reduce((sum, block) => sum + block.sentBefore, 0),
        sentAfterBytes: blocks.reduce((sum, block) => sum + block.sentAfter, 0),
    };
    if(!opts.cached) return result;

    const originalBuilder = db.buildCrossChainDataForVM;
    const priorBlockIndex = db.blockIndex;
    const cacheBlocks = [];
    let builds = 0;
    db.buildCrossChainDataForVM = async function(...args){
        builds++;
        return originalBuilder.apply(this, args);
    };
    try {
        for(const block of blocks.slice().reverse()){
            db.blockIndex = block.blockIndex;
            db._vmSnapshotMemo = new Map();
            builds = 0;
            const started = now();
            await db.getCrossChainDataForVM(block.blockIndex);
            const ms = now() - started;
            cacheBlocks.push({ blockIndex: block.blockIndex, hit: builds === 0, ms });
        }
    } finally {
        db.buildCrossChainDataForVM = originalBuilder;
        db.blockIndex = priorBlockIndex;
        db._vmSnapshotMemo = null;
    }
    const hits = cacheBlocks.filter(block => block.hit);
    const misses = cacheBlocks.filter(block => !block.hit);
    result.cache = {
        hits: hits.length,
        misses: misses.length,
        maxHitMs: hits.reduce((max, block) => Math.max(max, block.ms), 0),
        maxMissMs: misses.reduce((max, block) => Math.max(max, block.ms), 0),
        blocks: cacheBlocks,
    };
    return result;
}

function render(result, json){
    if(json) return JSON.stringify(result, null, 2);
    const lines = result.blocks.map(block =>
        'block=' + block.blockIndex +
        ' executions=' + block.executions +
        ' bytes=' + block.bytes +
        ' build=' + block.buildMs + 'ms' +
        ' sent-before=' + block.sentBefore +
        ' sent-after=' + block.sentAfter +
        ' serialize=' + block.serializeMs + 'ms' +
        ' sent-before-ms=' + block.sentBeforeMs +
        ' sent-after-ms=' + block.sentAfterMs);
    lines.push('# blocks=' + result.scanned +
        ' max-bytes=' + result.maxBytes +
        ' max-build=' + result.maxBuildMs + 'ms' +
        ' sent-before=' + result.sentBeforeBytes +
        ' sent-after=' + result.sentAfterBytes +
        ' max-serialize=' + result.maxSerializeMs + 'ms' +
        ' sent-before-ms=' + result.sentBeforeMs +
        ' sent-after-ms=' + result.sentAfterMs);
    if(result.cache) lines.push('# cache blocks=' + result.cache.blocks.length +
        ' hits=' + result.cache.hits +
        ' misses=' + result.cache.misses +
        ' max-hit=' + result.cache.maxHitMs + 'ms' +
        ' max-miss=' + result.cache.maxMissMs + 'ms');
    return lines.join('\n');
}

async function openIndexerDb(opts){
    const Database = require('../src/db');
    const config = require('../src/config.js');
    const Utility = require('../src/utility.js');
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
        console.log(render(await measure(db, opts), opts.json));
    } finally {
        if(db.close) await db.close();
    }
    return 0;
}

if(require.main === module){
    main(process.argv.slice(2)).then(code => process.exit(code), err => {
        console.error('measure_vm_snapshot_bytes: ' + err.message);
        process.exit(2);
    });
}

module.exports = { parseArgs, vmBlocksQuery, measure, render };
