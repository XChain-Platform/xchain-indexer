/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const listShare = require('../../../bin/recovery/list_share.js');
const canonical = require('../../../src/consensus/list_share_settle/canonical.js');

function rowWith(overrides){
    let row = Object.assign({
        id: 7,
        snapshot_block: 100,
        network: 'regtest',
        home_chain: 'DOGE',
        home_list_index: 5,
        list_type: 2,
        seq: 1,
        kind: 'full',
        origin_block: 90,
        members_hash: 'a'.repeat(64),
        added: JSON.stringify(['addr-a', 'addr-b']),
        removed: '[]',
        admit_block_btc: 104,
        admit_block_ltc: null,
        finalizing_view: 0,
        validator_signatures: '[]',
        status: 'finalized'
    }, overrides || {});
    if(!overrides || !Object.prototype.hasOwnProperty.call(overrides, 'snapshot_id')){
        row.snapshot_id = canonical.deriveListSnapshotId(
            row.network, row.home_chain, row.home_list_index, row.seq, row.snapshot_block);
    }
    return row;
}

function rejects(row){
    assert.throws(() => listShare.validateListSnapshot(row, 'regtest'), error => {
        let id = row && row.snapshot_id;
        return error instanceof Error &&
            error.message.startsWith('list snapshot ' + String(id || '').substring(0, 16));
    });
}

function registerShapeValidationTests(){
    it('accepts valid full and delta rows', function () {
        let full = rowWith();
        let delta = rowWith({
            id: 8,
            snapshot_block: 110,
            seq: 2,
            kind: 'delta',
            added: JSON.stringify(['addr-c']),
            removed: JSON.stringify(['addr-a']),
            admit_block_btc: undefined,
            admit_block_ltc: 114,
            admit_block_doge: null,
            finalizing_view: 2
        });

        assert.doesNotThrow(() => listShare.validateListSnapshot(full, 'regtest'));
        assert.doesNotThrow(() => listShare.validateListSnapshot(delta, 'regtest'));
    });

    it('rejects malformed shape, hashes, integer fields, and archive binding', function () {
        rejects(null);
        rejects([]);
        rejects(new Date());
        rejects(rowWith({ snapshot_id: 'A'.repeat(64) }));
        rejects(rowWith({ members_hash: 'f'.repeat(63) }));
        for(let key of ['id', 'snapshot_block', 'home_list_index', 'list_type', 'seq',
                        'origin_block', 'finalizing_view']){
            rejects(rowWith({ [key]: -1 }));
            rejects(rowWith({ [key]: 1.5 }));
            rejects(rowWith({ [key]: Number.MAX_SAFE_INTEGER + 1 }));
        }
        rejects(rowWith({ network: 'testnet' }));
        rejects(rowWith({ status: 'retracted' }));
    });
}

function registerFieldValidationTests(){
    it('rejects invalid list identity and version fields', function () {
        rejects(rowWith({ home_chain: 'ETH' }));
        rejects(rowWith({ list_type: 3 }));
        rejects(rowWith({ seq: 0 }));
        rejects(rowWith({ kind: 'delta' }));
        rejects(rowWith({ seq: 2, kind: 'full' }));
        rejects(rowWith({ snapshot_id: 'b'.repeat(64) }));
    });

    it('rejects malformed admission, signature, and membership fields', function () {
        for(let key of ['admit_block_btc', 'admit_block_ltc', 'admit_block_doge']){
            rejects(rowWith({ [key]: -1 }));
            rejects(rowWith({ [key]: '104' }));
        }
        rejects(rowWith({ validator_signatures: [] }));
        rejects(rowWith({ added: ['addr-a'] }));
        rejects(rowWith({ removed: [] }));
        rejects(rowWith({ added: '{' }));
        rejects(rowWith({ removed: '{}' }));
        rejects(rowWith({ added: 'null' }));
        rejects(rowWith({ added: JSON.stringify(['addr-b', 'addr-a']) }));
        rejects(rowWith({ removed: JSON.stringify(['addr-z']) }));
    });
}

function registerSnapshotWriteTests(){
    it('does not write when the snapshot id already exists', async function () {
        let row = rowWith();
        let queries = [];
        let db = {
            doQuery: async (sql, args) => {
                queries.push({ sql, args });
                return [{ snapshot_id: row.snapshot_id }];
            }
        };

        await listShare.writeListSnapshot(db, row);
        assert.strictEqual(queries.length, 1);
        assert.match(queries[0].sql, /WHERE snapshot_id = \?/);
        assert.deepStrictEqual(queries[0].args, [row.snapshot_id]);
    });

    it('rejects a different snapshot id at the same list sequence', async function () {
        let row = rowWith();
        let queries = [];
        let db = {
            doQuery: async (sql, args) => {
                queries.push({ sql, args });
                if(args.length === 4) return [{ snapshot_id: 'b'.repeat(64) }];
                return [];
            }
        };

        await assert.rejects(listShare.writeListSnapshot(db, row),
            /collides with an existing list sequence/);
        assert.strictEqual(queries.length, 2);
        assert.deepStrictEqual(queries[1].args, ['regtest', 'DOGE', 5, 1]);
    });

    it('inserts a fresh snapshot with the 19 mirror columns', async function () {
        let row = rowWith();
        let queries = [];
        let db = {
            doQuery: async (sql, args) => {
                queries.push({ sql, args });
                return [];
            }
        };

        await listShare.writeListSnapshot(db, row);
        assert.strictEqual(queries.length, 3);
        assert.match(queries[2].sql, /INSERT IGNORE INTO list_snapshots/);
        assert.strictEqual(queries[2].args.length, 19);
        assert.deepStrictEqual(queries[2].args, [
            7, row.snapshot_id, 100, 'regtest', 'DOGE', 5, 2, 1, 'full', 90,
            'a'.repeat(64), JSON.stringify(['addr-a', 'addr-b']), '[]', 104,
            null, null, 0, '[]', 'finalized'
        ]);
    });
}

function registerArchiveWriteTests(){
    it('counts archive rows and treats an absent list_snapshots key as empty', async function () {
        let inserts = [];
        let db = {
            doQuery: async (sql, args) => {
                if(/INSERT IGNORE INTO list_snapshots/.test(sql)) inserts.push(args);
                return [];
            }
        };
        let report = {};

        await listShare.writeArchive(db, {}, report);
        assert.strictEqual(report.lists, 0);
        assert.strictEqual(inserts.length, 0);
        await listShare.writeArchive(db, { list_snapshots: [rowWith()] }, report);
        assert.strictEqual(report.lists, 1);
        assert.strictEqual(inserts.length, 1);
    });
}

function registerListSnapshotArchiveRowTests(){
    registerShapeValidationTests();
    registerFieldValidationTests();
    registerSnapshotWriteTests();
    registerArchiveWriteTests();
}

describe('list snapshot archive rows @regression @tier1', registerListSnapshotArchiveRowTests);
