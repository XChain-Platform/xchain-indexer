/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Persistence for replay witness event tests. Witness events stay in
 * memory; block reads run as real SQL against tables built from the
 * indexer's own DDL (src/sql) and the decoder's own DDL, so a column one
 * side lacks fails here exactly as it does on a live indexer.
 *
 *********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');

const { mysqlDdlToSqlite } = require('../../../../../helpers/sqlAnchorDb.js');
const blockMethods = require('../../../../../../src/db/blocks/index.js');

const INDEXER_SQL = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'src', 'sql');
const DECODER_SQL = process.env.XCHAIN_DECODER_SQL_PATH ||
    path.resolve(__dirname, '..', '..', '..', '..', '..', '..', '..', 'xchain-decoder', 'src', 'sql');
const INDEXER_TABLES = ['index_transactions.sql', 'blocks.sql', 'state_tree_roots.sql'];
const DECODER_TABLES = ['index_transactions.sql', 'blocks.sql'];

const INSERT_EVENT =
    'INSERT INTO events (time, code, data, witness_hash) VALUES (NOW(), ?, ?, ?)';
const SELECT_LATEST_EVENT =
    'SELECT id, data, witness_hash FROM events WHERE code = ? ORDER BY id DESC LIMIT 1';
const SELECT_EVENT_ROWS =
    'SELECT data FROM events WHERE code = ? AND witness_hash = ? AND id < ? ' +
    'ORDER BY id DESC LIMIT ?';
const BLOCKS_READ = /\bFROM\s+blocks\s+b\b/;

// SQLite takes the table bodies as they are; MariaDB's inline UNIQUE KEY and its
// prefix-length indexes are not part of what the witness read depends on.
function sqliteDdl(file){
    return mysqlDdlToSqlite(fs.readFileSync(file, 'utf8'))
        .replace(/,\s*UNIQUE\s+KEY\s+\w+\s*\([^)]*\)/gi, '')
        .replace(/^\s*CREATE\s+(UNIQUE\s+)?INDEX[^;]*;\s*$/gim, '');
}

function schemaDatabase(dir, tables){
    const { DatabaseSync } = require('node:sqlite');
    const sqlite = new DatabaseSync(':memory:');
    for(const table of tables){
        const file = path.join(dir, table);
        if(!fs.existsSync(file))
            throw new Error('Schema file not found: ' + file +
                '. Set XCHAIN_DECODER_SQL_PATH to the xchain-decoder src/sql directory.');
        sqlite.exec(sqliteDdl(file));
    }
    return sqlite;
}

function plainRows(rows){
    return rows.map(row => Object.assign({}, row));
}

// Interns a hash the way createTransaction does and hands back its id.
function internHash(sqlite, hash){
    sqlite.prepare('INSERT OR IGNORE INTO index_transactions (hash) VALUES (?)').run(hash);
    return sqlite.prepare('SELECT id FROM index_transactions WHERE hash = ?').get(hash).id;
}

function optionalHashId(sqlite, hash){
    return hash === undefined || hash === null ? null : internHash(sqlite, hash);
}

// Seeds one block on both sides: the chain hash in the decoder, the node's own
// digests (and its state root, when given) in the indexer.
function seedBlock(indexerSqlite, decoderSqlite, row){
    if(row.block_hash !== undefined && row.block_hash !== null){
        decoderSqlite.prepare(
            'INSERT INTO blocks (block_index, block_time, block_hash_id) VALUES (?, ?, ?)')
            .run(row.block_index, 1000 + row.block_index, internHash(decoderSqlite, row.block_hash));
    }
    indexerSqlite.prepare(
        'INSERT INTO blocks (block_index, block_time, ledger_hash_id, actions_hash_id, ' +
        'contract_hash_id) VALUES (?, ?, ?, ?, ?)').run(
        row.block_index, 1000 + row.block_index,
        optionalHashId(indexerSqlite, row.ledger_hash),
        optionalHashId(indexerSqlite, row.actions_hash),
        optionalHashId(indexerSqlite, row.contract_hash));
    if(row.state_root !== undefined && row.state_root !== null){
        indexerSqlite.prepare(
            'INSERT INTO state_tree_roots (chain, network, block_index, balances_root, ' +
            'stakes_root, state_root, block_merkle_root) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            'BTC', 'regtest', row.block_index, 'b'.repeat(64), 'c'.repeat(64),
            row.state_root, 'd'.repeat(64));
    }
}

// The decoder handle the witness read takes: the real getDecoderBlockHashRow (the
// statement getblockhashes reports) over the decoder tables, with its own query log
// so indexer-side read counts stay what the code under test issues there.
function makeDecoderDb(decoderSqlite){
    const queries = [];
    const decoderDb = {
        queries,
        async doQuery(sql, params = []){
            queries.push({ sql, params });
            return plainRows(decoderSqlite.prepare(sql).all(...params));
        },
        getDecoderBlockHashRow: blockMethods.getDecoderBlockHashRow,
        apiView(){ return decoderDb; },
    };
    return decoderDb;
}

function makeWitnessEventsDb({ blocks = [] } = {}){
    const queries = [];
    const events = [];
    let nextEventId = 1;
    const indexerSqlite = schemaDatabase(INDEXER_SQL, INDEXER_TABLES);
    const decoderSqlite = schemaDatabase(DECODER_SQL, DECODER_TABLES);
    for(const row of blocks) seedBlock(indexerSqlite, decoderSqlite, row);

    async function doQueryStrict(sql, params){
        queries.push({ sql, params });

        if(sql === INSERT_EVENT){
            const event = {
                id: nextEventId++,
                code: params[0],
                data: params[1],
                witness_hash: params[2],
            };
            events.push(event);
            return { insertId: event.id, affectedRows: 1 };
        }

        if(sql === SELECT_LATEST_EVENT){
            const rows = events.filter(event => event.code === params[0]);
            return rows.length === 0 ? [] : [rows[rows.length - 1]];
        }

        if(sql === SELECT_EVENT_ROWS){
            return events.filter(event => event.code === params[0] &&
                event.witness_hash === params[1] && event.id < params[2])
                .sort((left, right) => right.id - left.id)
                .slice(0, params[3])
                .map(event => ({ data: event.data }));
        }

        if(BLOCKS_READ.test(sql))
            return plainRows(indexerSqlite.prepare(sql).all(...params));

        throw new Error('unsupported witness events query');
    }

    // Rewrites a committed block's own digests in place, as a replay that produced
    // different state at that height leaves them; the chain hash is untouched.
    function rewriteBlockDigests(height, fields){
        for(const field of ['ledger_hash', 'actions_hash', 'contract_hash']){
            if(!(field in fields)) continue;
            indexerSqlite.prepare('UPDATE blocks SET ' + field + '_id = ? WHERE block_index = ?')
                .run(optionalHashId(indexerSqlite, fields[field]), height);
        }
    }

    return {
        doQueryStrict,
        queries,
        events,
        rewriteBlockDigests,
        decoderDb: makeDecoderDb(decoderSqlite),
        indexerSqlite,
        decoderSqlite,
    };
}

module.exports = { makeWitnessEventsDb, DECODER_SQL, INDEXER_SQL, sqliteDdl };
