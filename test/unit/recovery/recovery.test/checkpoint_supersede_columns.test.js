'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Exercises archived checkpoint supersede validation and restore fidelity.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { verifyArchive, writeArchive } = require('../../../../bin/recovery/checkpoint_price.js');

const hex = (character, length) => character.repeat(length || 64);
const base = {
    id: 1,
    chain: 'BTC',
    network: 'regtest',
    block_index: 100,
    block_hash: hex('a'),
    ledger_hash: hex('b'),
    actions_hash: hex('c'),
    contract_hash: hex('d'),
    checkpoint_seq: 7,
    snapshot_block: 100,
    state_root: null,
    state_root_version: null,
    block_merkle_root: null,
    block_merkle_version: null,
    validator_signatures: '[]'
};
const superseding = Object.assign({}, base, { supersedes_from: 90, rules_digest: hex('e') });
const context = {
    network: 'regtest',
    setFor: () => [],
    parseSigs: () => [],
    checkpointCanonical: () => 'checkpoint',
    quorumVerified: () => true
};

function database(existing){
    let calls = [];
    return {
        calls,
        doQuery: async (sql, params) => {
            calls.push([sql, params]);
            return /^\s*SELECT/i.test(sql) ? existing : {};
        }
    };
}

function report(){
    return { checkpoints: 0, prices: 0, tombstones: 0 };
}

function insertColumns(sql){
    return /state_checkpoints\s*\(([^)]*)\)/.exec(sql)[1].split(',').map(column => column.trim());
}

describe('recovery checkpoint supersede archive columns @regression @tier1', function(){
    it('has verifyArchive accept absent, explicit-null, and valid supersede fields', function(){
        for(let row of [base, Object.assign({}, base, {
            supersedes_from: null,
            rules_digest: null
        }), superseding]){
            assert.doesNotThrow(() => verifyArchive({ state_checkpoints: [row] }, context));
        }
    });

    it('has verifyArchive reject malformed supersede field pairs', function(){
        let invalid = [
            { supersedes_from: 90 },
            { rules_digest: hex('e') },
            { supersedes_from: -1, rules_digest: hex('e') },
            { supersedes_from: 1.5, rules_digest: hex('e') },
            { supersedes_from: 90, rules_digest: hex('e', 63) },
            { supersedes_from: 90, rules_digest: hex('E') }
        ];
        for(let fields of invalid){
            assert.throws(
                () => verifyArchive({ state_checkpoints: [Object.assign({}, base, fields)] }, context),
                /malformed supersede fields/
            );
        }
    });

    it('has writeArchive insert both supersede columns in column order and null absent fields', async function(){
        for(let [row, expectedFrom, expectedDigest] of [
            [superseding, 90, hex('e')],
            [base, null, null]
        ]){
            let db = database([]);
            await writeArchive(db, { state_checkpoints: [row] }, report());
            let select = db.calls.find(call => /^\s*SELECT/i.test(call[0]));
            let insert = db.calls.find(call => call[0].includes('INSERT IGNORE INTO state_checkpoints'));
            assert.ok(select[0].includes('supersedes_from'));
            assert.ok(select[0].includes('rules_digest'));
            let columns = insertColumns(insert[0]);
            assert.strictEqual(columns.length, insert[1].length);
            assert.strictEqual(insert[1][columns.indexOf('supersedes_from')], expectedFrom);
            assert.strictEqual(insert[1][columns.indexOf('rules_digest')], expectedDigest);
        }
    });

    it('has writeArchive refuse a rules_digest collision and skip an identical stored row', async function(){
        let conflicting = database([Object.assign({}, superseding, { rules_digest: hex('f') })]);
        await assert.rejects(
            writeArchive(conflicting, { state_checkpoints: [superseding] }, report()),
            /collides with an existing checkpoint sequence/
        );

        let identical = database([Object.assign({}, superseding)]);
        await writeArchive(identical, { state_checkpoints: [superseding] }, report());
        assert.ok(!identical.calls.some(call => call[0].includes('INSERT')));
    });
});
