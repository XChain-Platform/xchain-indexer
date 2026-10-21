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
 * XChain Indexer - archive heads by author
 *
 * Read-only. Lists archive heads held by one author at every status and
 * summarizes refused sequences and later valid or unverified heads. Issues
 * SELECTs only.
 *
 * Reads connection settings from the indexer environment (INDEXER_DB_HOST/PORT/
 * NAME/USER/PASS, INDEXER_COIN, INDEXER_NETWORK). Exits 0 on success and 2 on
 * a usage or database error.
 *
 * Usage:  node bin/archive_heads_by_author.js --author ADDRESS
 *         [--from-seq N] [--limit N] [--db NAME] [--json]
 *
 ********************************************************************/

'use strict';

const { ARCHIVE_REISSUE_RETRY_REASON } =
    require('../src/actions/anchor/archive/archive_reissue.js');

const DEFAULTS = { author: null, fromSeq: null, limit: 50, db: null, json: false };

function valueAfter(argv, index, flag){
    const value = argv[index + 1];
    if(value === undefined || String(value).startsWith('--'))
        throw new Error(flag + ' needs a value');
    return value;
}

function integerArg(value, flag, allowZero){
    if(String(value).trim() === '')
        throw new Error(flag + (allowZero ? ' needs a non-negative integer' : ' needs a positive integer'));
    const number = Number(value);
    if(!Number.isInteger(number) || (allowZero ? number < 0 : number <= 0))
        throw new Error(flag + (allowZero ? ' needs a non-negative integer' : ' needs a positive integer'));
    return number;
}

function parseArgs(argv){
    const opts = Object.assign({}, DEFAULTS);
    for(let i = 0; i < argv.length; i++){
        const arg = argv[i];
        if(arg === '--author') opts.author = valueAfter(argv, i++, arg);
        else if(arg === '--from-seq') opts.fromSeq = integerArg(valueAfter(argv, i++, arg), arg, true);
        else if(arg === '--limit') opts.limit = integerArg(valueAfter(argv, i++, arg), arg, false);
        else if(arg === '--db') opts.db = valueAfter(argv, i++, arg);
        else if(arg === '--json') opts.json = true;
        else throw new Error('unknown argument ' + arg);
    }
    if(!opts.author) throw new Error('--author is required');
    return opts;
}

function archiveHeadsQuery(opts){
    const fromSeq = opts.fromSeq === null || opts.fromSeq === undefined
        ? ''
        : '\n               AND a.match_batch_seq >= ?';
    const args = [String(opts.author)];
    if(fromSeq) args.push(Number(opts.fromSeq));
    args.push(Number(opts.limit));
    return {
        sql: `SELECT a.action_index, a.version, a.match_batch_seq,
                    a.batch_crc32, a.match_count, a.block_index_doge, s.status
               FROM anchor_actions a
               JOIN index_statuses s    ON s.id = a.status_id
               JOIN actions act         ON act.action_index = a.action_index
               JOIN index_addresses adr ON adr.id = act.source_id
              WHERE a.version <> 2
                AND a.match_batch_seq IS NOT NULL
                AND adr.address = ?${fromSeq}
              ORDER BY a.match_batch_seq, a.action_index
              LIMIT ?`,
        args
    };
}

function summarize(rows){
    const heads = rows || [];
    const seqs = new Set();
    const refusedSeqs = new Set();
    let refused = 0;
    let maxValidSeq = null;
    for(const row of heads){
        const seq = Number(row.match_batch_seq);
        seqs.add(seq);
        if(row.status === ARCHIVE_REISSUE_RETRY_REASON){
            refused += 1;
            refusedSeqs.add(seq);
        }
        if((row.status === 'valid' || row.status === 'unverified') &&
           (maxValidSeq === null || seq > maxValidSeq))
            maxValidSeq = seq;
    }
    const refusedList = Array.from(refusedSeqs).sort((a, b) => a - b);
    return {
        count: heads.length,
        seqs: seqs.size,
        refused,
        refusedSeqs: refusedList,
        maxValidSeq,
        redrawnAbove: refusedList.length > 0 && maxValidSeq !== null &&
            maxValidSeq > refusedList[refusedList.length - 1]
    };
}

async function readHeads(db, opts){
    const query = archiveHeadsQuery(opts);
    const rows = await db.doQueryStrict(query.sql, query.args);
    return { author: opts.author, rows: rows || [], summary: summarize(rows) };
}

function render(result, json){
    if(json) return JSON.stringify(result, null, 2);
    const lines = result.rows.map(row =>
        'seq=' + Number(row.match_batch_seq) +
        ' action-index=' + row.action_index +
        ' version=' + row.version +
        ' crc32=' + row.batch_crc32 +
        ' matches=' + row.match_count +
        ' block=' + row.block_index_doge +
        ' status=' + row.status);
    const summary = result.summary;
    lines.push('# heads=' + summary.count +
        ' seqs=' + summary.seqs +
        ' refused=' + summary.refused +
        ' max-valid-seq=' + summary.maxValidSeq +
        ' redrawn-above=' + (summary.redrawnAbove ? 'yes' : 'no'));
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
        console.log(render(await readHeads(db, opts), opts.json));
    } finally {
        if(db.close) await db.close();
    }
    return 0;
}

if(require.main === module){
    main(process.argv.slice(2)).then(code => process.exit(code), err => {
        console.error('archive_heads_by_author: ' + err.message);
        process.exit(2);
    });
}

module.exports = { parseArgs, archiveHeadsQuery, summarize, readHeads, render };
