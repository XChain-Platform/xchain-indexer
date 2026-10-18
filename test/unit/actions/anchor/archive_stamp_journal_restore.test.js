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
 ********************************************************************/
'use strict';

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');

const anchors = require('../../../../src/db/anchors/index.js');
const batchHeads = require('../../../../src/db/rollback/batch_heads.js');
const { mysqlDdlToSqlite } = require('../../../helpers/sqlAnchorDb.js');

const SQL_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql');

function makeDb(){
    const { DatabaseSync } = require('node:sqlite');
    const sqlite = new DatabaseSync(':memory:');
    for(const file of ['index_statuses.sql', 'anchor_actions.sql']){
        sqlite.exec(mysqlDdlToSqlite(fs.readFileSync(path.join(SQL_DIR, file), 'utf8')));
    }

    const api = {
        config: { NETWORK: 'regtest' },
        async createStatus(name){
            sqlite.prepare('INSERT OR IGNORE INTO index_statuses (status) VALUES (?)').run(name);
            return sqlite.prepare('SELECT id FROM index_statuses WHERE status = ?').get(name).id;
        },
        async doQuery(sql, args){
            if(!/^UPDATE anchor_actions p/.test(sql)){
                sqlite.prepare(sql.replace(/\bIF\(/g, 'IIF(')).run(...args);
                return [];
            }

            assert.match(sql,
                /SET p\.status_id = COALESCE\(p\.pre_archive_status_id, us\.id\),\s*p\.pre_archive_status_id = NULL/);
            let select = sql.replace(
                'UPDATE anchor_actions p', 'SELECT p.action_index FROM anchor_actions p');
            select = select.replace(/\bSET\b[\s\S]*?(?=\bWHERE\b)/i, '');
            const targets = sqlite.prepare(select).all(...args);
            const unverified = sqlite.prepare(
                "SELECT id FROM index_statuses WHERE status = 'unverified'").get().id;
            for(const target of targets){
                sqlite.prepare(
                    'UPDATE anchor_actions SET status_id = COALESCE(pre_archive_status_id, ?), ' +
                    'pre_archive_status_id = NULL WHERE action_index = ?'
                ).run(unverified, target.action_index);
            }
            return [];
        },
        async seed(priorStatus){
            const prior = await api.createStatus(priorStatus);
            const valid = await api.createStatus('valid');
            sqlite.prepare(
                'INSERT INTO anchor_actions ' +
                '(action_index, version, match_batch_seq, status_id, block_index_doge) ' +
                'VALUES (100, 1, 7, ?, 10)'
            ).run(prior);
            sqlite.prepare(
                'INSERT INTO anchor_actions ' +
                '(action_index, version, match_batch_seq, chunk_index, status_id, block_index_doge) ' +
                'VALUES (300, 2, 7, 1, ?, 30)'
            ).run(valid);
        },
        head(){
            return Object.assign({}, sqlite.prepare(
                'SELECT s.status, a.pre_archive_status_id FROM anchor_actions a ' +
                'JOIN index_statuses s ON s.id = a.status_id WHERE a.action_index = 100'
            ).get());
        },
        statusId(name){
            return sqlite.prepare('SELECT id FROM index_statuses WHERE status = ?').get(name).id;
        },
        close(){ sqlite.close(); },
    };
    return api;
}

describe('archive stamp journal rollback restore @regression @tier1', function () {
    for(const priorStatus of ['valid', 'unverified']){
        it('restores a gated ' + priorStatus + ' head and clears its journal', async function () {
            const db = makeDb();
            try {
                await db.seed(priorStatus);
                await anchors.setAnchorArchiveStatus.call(db, 100, 'invalid_archive', true);
                assert.deepStrictEqual(db.head(), {
                    status: 'invalid_archive',
                    pre_archive_status_id: db.statusId(priorStatus),
                });

                await anchors.setAnchorArchiveStatus.call(db, 100, 'invalid_archive', true);
                assert.strictEqual(db.head().pre_archive_status_id, db.statusId(priorStatus));

                await batchHeads.resetOrphanedArchiveHeads(db, db.config, 100, 250);
                assert.deepStrictEqual(db.head(), {
                    status: priorStatus,
                    pre_archive_status_id: null,
                });
            } finally {
                db.close();
            }
        });
    }

    it('keeps the journal null below the gate and falls back to unverified', async function () {
        const db = makeDb();
        try {
            await db.seed('valid');
            await anchors.setAnchorArchiveStatus.call(db, 100, 'invalid_archive', false);
            assert.deepStrictEqual(db.head(), {
                status: 'invalid_archive',
                pre_archive_status_id: null,
            });

            await batchHeads.resetOrphanedArchiveHeads(db, db.config, 100, 250);
            assert.deepStrictEqual(db.head(), {
                status: 'unverified',
                pre_archive_status_id: null,
            });
        } finally {
            db.close();
        }
    });
});
