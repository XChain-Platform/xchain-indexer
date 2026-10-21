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
 * XChain Indexer - credit/debit sum comparator
 *
 * Read-only. For every (address, tick) with credits or debits, computes the net
 * two ways and reports each key where they disagree:
 *   - the JS fold: every credits and debits row streamed out and summed with
 *     the indexer's bcadd at 18 dp, net taken with bcsub;
 *   - the SQL sum: SUM(CAST(amount AS DECIMAL(60,18))) ... GROUP BY, the shape
 *     getNetBalance and getNonzeroNetBalances derive the balances leaf from.
 * Both nets are rendered through bcstr so the comparison is on the value, not
 * on trailing zeros. Issues SELECTs only.
 *
 * Reads connection settings from the indexer environment (INDEXER_DB_HOST/PORT/
 * NAME/USER/PASS, INDEXER_COIN, INDEXER_NETWORK). Exits 1 when any key differs.
 *
 * Usage:  node bin/compare_credit_debit_sum.js [--db NAME] [--json]
 *
 ********************************************************************/

'use strict';

const SCALE = 18;

const DEFAULTS = { db: null, json: false };

function parseArgs(argv){
    const opts = Object.assign({}, DEFAULTS);
    for(let i = 0; i < argv.length; i++){
        const a = argv[i];
        if(a === '--db'){
            opts.db = argv[++i];
            if(!opts.db) throw new Error('--db needs a database name');
        }
        else if(a === '--json') opts.json = true;
        else throw new Error('unknown argument ' + a);
    }
    return opts;
}

const keyOf = (address, tick) => address + '\t' + tick;

// Every row of one side, in a stable order so a rerun folds identically.
async function readRows(db, table){
    return db.doQueryStrict(
        `SELECT a.address AS address, t.tick AS tick, x.amount AS amount
           FROM ${table} x
           INNER JOIN index_addresses a ON a.id=x.address_id
           INNER JOIN index_tickers   t ON t.id=x.tick_id
          ORDER BY x.address_id, x.tick_id`, []);
}

// The JS fold: Map of key -> { address, tick, credit, debit } as bcstr strings.
async function foldInJs(db, util){
    const keys = new Map();
    const add = (rows, side) => {
        for(const r of (rows || [])){
            const k = keyOf(r.address, r.tick);
            let e = keys.get(k);
            if(!e){
                e = { address: r.address, tick: r.tick, credit: '0', debit: '0' };
                keys.set(k, e);
            }
            e[side] = util.bcstr(util.bcadd(e[side], r.amount, SCALE));
        }
    };
    add(await readRows(db, 'credits'), 'credit');
    add(await readRows(db, 'debits'),  'debit');
    for(const e of keys.values())
        e.net = util.bcstr(util.bcsub(e.credit, e.debit, SCALE));
    return keys;
}

// The SQL sum: per side GROUP BY, then net per key from the two server-side sums.
async function sumInSql(db, util){
    const sums = new Map();
    for(const [table, side] of [['credits', 'credit'], ['debits', 'debit']]){
        const rows = await db.doQueryStrict(
            `SELECT a.address AS address, t.tick AS tick,
                    CAST(SUM(CAST(x.amount AS DECIMAL(60,18))) AS CHAR) AS total
               FROM ${table} x
               INNER JOIN index_addresses a ON a.id=x.address_id
               INNER JOIN index_tickers   t ON t.id=x.tick_id
              GROUP BY x.address_id, x.tick_id, a.address, t.tick`, []);
        for(const r of (rows || [])){
            const k = keyOf(r.address, r.tick);
            let e = sums.get(k);
            if(!e){
                e = { address: r.address, tick: r.tick, credit: '0', debit: '0' };
                sums.set(k, e);
            }
            e[side] = util.bcstr(r.total);
        }
    }
    for(const e of sums.values())
        e.net = util.bcstr(util.bcsub(e.credit, e.debit, SCALE));
    return sums;
}

// A key present on only one side is a difference too, reported against '0'.
function diffMaps(js, sql){
    const diffs = [];
    const keys = Array.from(new Set([...js.keys(), ...sql.keys()])).sort();
    for(const k of keys){
        const j = js.get(k), s = sql.get(k);
        const row = {
            address: (j || s).address, tick: (j || s).tick,
            jsCredit: j ? j.credit : '0', sqlCredit: s ? s.credit : '0',
            jsDebit:  j ? j.debit  : '0', sqlDebit:  s ? s.debit  : '0',
            jsNet:    j ? j.net    : '0', sqlNet:    s ? s.net    : '0'
        };
        if(row.jsCredit !== row.sqlCredit || row.jsDebit !== row.sqlDebit || row.jsNet !== row.sqlNet)
            diffs.push(row);
    }
    return diffs;
}

async function compare(db, util){
    const js  = await foldInJs(db, util);
    const sql = await sumInSql(db, util);
    const diffs = diffMaps(js, sql);
    return { keys: new Set([...js.keys(), ...sql.keys()]).size, differences: diffs.length, diffs };
}

function render(result, json){
    if(json) return JSON.stringify(result, null, 2);
    const lines = result.diffs.map(d =>
        'DIFF ' + d.tick + '  ' + d.address +
        '  credit js=' + d.jsCredit + ' sql=' + d.sqlCredit +
        '  debit js=' + d.jsDebit + ' sql=' + d.sqlDebit +
        '  net js=' + d.jsNet + ' sql=' + d.sqlNet);
    lines.push('# keys=' + result.keys + ' differences=' + result.differences);
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
    let result;
    try {
        result = await compare(db, db.util);
        console.log(render(result, opts.json));
    } finally {
        if(db.close) await db.close();
    }
    return result.differences ? 1 : 0;
}

if(require.main === module){
    main(process.argv.slice(2)).then(code => process.exit(code), err => {
        console.error('compare_credit_debit_sum: ' + err.message);
        process.exit(2);
    });
}

module.exports = { parseArgs, foldInJs, sumInSql, diffMaps, compare, render };
