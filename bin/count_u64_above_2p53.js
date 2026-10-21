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
 * XChain Indexer - BIGINT values above 2^53 counter
 *
 * Read-only. Lists every BIGINT column of the current schema from
 * information_schema.COLUMNS and, per column, counts the rows above
 * 9007199254740991 (Number.MAX_SAFE_INTEGER) and reads the column maximum as
 * CAST(MAX(col) AS CHAR) so it stays exact. A column is marked wire when its
 * upper-cased name is a key of the config INTEGER_FIELDS. One line is printed
 * per wire or non-zero column, then a summary line; --json prints one object
 * of the same facts. Issues SELECTs only.
 *
 * Reads connection settings from the indexer environment (INDEXER_DB_HOST/PORT/
 * NAME/USER/PASS, INDEXER_COIN, INDEXER_NETWORK). Exits 0 when no column holds
 * a value above 2^53, 1 when one does, 2 on a usage or database error.
 *
 * Usage:  node bin/count_u64_above_2p53.js [--db NAME] [--json]
 *
 ********************************************************************/

'use strict';

const LIMIT = '9007199254740991';

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

function bigintColumnsSql(){
    return `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
              FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE = 'bigint'
             ORDER BY TABLE_NAME, ORDINAL_POSITION`;
}

function quoteName(name){
    if(typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name))
        throw new Error('unsafe identifier ' + JSON.stringify(name));
    return '`' + name + '`';
}

function columnCountSql(table, column){
    const t = quoteName(table), c = quoteName(column);
    return `SELECT COALESCE(SUM(${c} > ${LIMIT}), 0) AS above, CAST(MAX(${c}) AS CHAR) AS max_value
              FROM ${t}`;
}

async function scan(db, integerFields){
    const wireKeys = integerFields || {};
    const cols = await db.doQueryStrict(bigintColumnsSql(), []);
    const columns = [];
    for(const col of (cols || [])){
        const table = col.table_name, column = col.column_name;
        const rows = await db.doQueryStrict(columnCountSql(table, column), []);
        const r = (rows && rows[0]) || {};
        columns.push({
            table, column,
            wire: Object.prototype.hasOwnProperty.call(wireKeys, String(column).toUpperCase()),
            count: Number(r.above || 0),
            max: r.max_value === null || r.max_value === undefined ? null : String(r.max_value)
        });
    }
    return {
        database: db.dbName || null,
        scanned: columns.length,
        wire: columns.filter(c => c.wire).length,
        above: columns.filter(c => c.count > 0).length,
        columns
    };
}

function render(result, json){
    if(json) return JSON.stringify(result, null, 2);
    const lines = result.columns.filter(c => c.wire || c.count > 0).map(c =>
        (c.count > 0 ? 'ABOVE ' : 'WIRE  ') + c.table + '.' + c.column +
        (c.wire ? ' wire' : '') + ' count=' + c.count + ' max=' + c.max);
    lines.push('# database=' + result.database + ' scanned=' + result.scanned +
        ' wire=' + result.wire + ' above=' + result.above);
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
        result = await scan(db, db.config['INTEGER_FIELDS']);
        console.log(render(result, opts.json));
    } finally {
        if(db.close) await db.close();
    }
    return result.above ? 1 : 0;
}

if(require.main === module){
    main(process.argv.slice(2)).then(code => process.exit(code), err => {
        console.error('count_u64_above_2p53: ' + err.message);
        process.exit(2);
    });
}

module.exports = { parseArgs, bigintColumnsSql, columnCountSql, scan, render };
