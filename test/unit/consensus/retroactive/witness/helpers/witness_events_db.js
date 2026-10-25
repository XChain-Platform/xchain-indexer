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
 * In-memory persistence for replay witness event tests.
 *
 *********************************************************************/

'use strict';

const INSERT_EVENT =
    'INSERT INTO events (time, code, data, witness_hash) VALUES (NOW(), ?, ?, ?)';
const SELECT_LATEST_EVENT =
    'SELECT id, data, witness_hash FROM events WHERE code = ? ORDER BY id DESC LIMIT 1';
const SELECT_EVENT_ROWS =
    'SELECT data FROM events WHERE code = ? AND witness_hash = ? AND id < ? ' +
    'ORDER BY id DESC LIMIT ?';
const SELECT_BLOCKS =
    'SELECT b.block_index, t.hash AS block_hash, t1.hash AS ledger_hash, ' +
    't2.hash AS actions_hash, t3.hash AS contract_hash, str.state_root FROM blocks b ' +
    'JOIN index_transactions t ON t.id = b.block_hash_id ' +
    'LEFT JOIN index_transactions t1 ON (t1.id = b.ledger_hash_id) ' +
    'LEFT JOIN index_transactions t2 ON (t2.id = b.actions_hash_id) ' +
    'LEFT JOIN index_transactions t3 ON (t3.id = b.contract_hash_id) ' +
    'LEFT JOIN state_tree_roots str ON (str.block_index = b.block_index) ' +
    'WHERE b.block_index BETWEEN ? AND ? ORDER BY b.block_index ASC, b.id ASC';

function makeWitnessEventsDb({ blocks = [] } = {}){
    const queries = [];
    const events = [];
    let nextEventId = 1;

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

        if(sql === SELECT_BLOCKS){
            return blocks.filter(row => row.block_index >= params[0] &&
                row.block_index <= params[1])
                .slice()
                .sort((left, right) => left.block_index - right.block_index);
        }

        throw new Error('unsupported witness events query');
    }

    return { doQueryStrict, queries, events };
}

module.exports = { makeWitnessEventsDb };
