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

const assert = require('assert');
const { makeAnchorDb } = require('../../../helpers/sqlAnchorDb');
const stateHash = require('../../../../src/consensus/state_hash');

function makeDb(captured){
    return {
        getStatusId: async () => null,
        doQuery: async sql => {
            captured.push(sql);
            return [];
        },
    };
}

async function anchorInvalidSql(gateHeight){
    const captured = [];
    const activation = stateHash.ARCHIVE_INVALID_STATE_HASH_ACTIVATION;
    const previous = activation.regtest;
    activation.regtest = gateHeight;
    try {
        await stateHash.buildStateHashData(makeDb(captured), 7, {
            activationDelay: null,
            gasTick: null,
            network: 'regtest',
            coin: 'BTC',
        });
    } finally {
        activation.regtest = previous;
    }
    return captured.find(sql => sql.includes('anchor_actions p'));
}

describe('anchor fold row predicates', function(){
    it('builds archive-head and checkpoint-section predicates for any alias', function(){
        assert.strictEqual(
            stateHash.archiveHeadPredicate('p'),
            'p.match_batch_seq IS NOT NULL AND p.version <> 2'
        );
        assert.strictEqual(
            stateHash.archiveHeadPredicate('archive_row'),
            'archive_row.match_batch_seq IS NOT NULL AND archive_row.version <> 2'
        );
        assert.strictEqual(
            stateHash.checkpointSectionPredicate('c'),
            'c.chain IS NOT NULL'
        );
    });

    it('uses the archive-head predicate only in the activated class-6 branch', async function(){
        const activeSql = await anchorInvalidSql(0);
        assert.ok(activeSql.includes('WHERE ' + stateHash.archiveHeadPredicate('p')));
        assert.ok(activeSql.includes('p.version ' + stateHash.ARCHIVE_HEAD_VERSIONS_SQL));
        assert.ok(!activeSql.includes(' OR p.version <> 2'));
        assert.ok(activeSql.includes('c.version = 2'));
        assert.ok(!activeSql.includes('WHERE p.version IN'));

        const legacySql = await anchorInvalidSql(8);
        assert.ok(legacySql.includes('WHERE p.version = 1'));
        assert.ok(!legacySql.includes('p.match_batch_seq IS NOT NULL'));
    });

    it('limits activated class-6 rows to the configured archive-head versions', async function(){
        const db = makeAnchorDb();
        const invalidId = db.status('invalid_archive');
        const validId = db.status('valid');
        db.anchor({
            action_index: 99,
            version: 1,
            match_batch_seq: 6,
            status_id: invalidId,
            block_index_doge: 6,
        });
        db.anchor({
            action_index: 100,
            version: 3,
            match_batch_seq: 7,
            status_id: invalidId,
            block_index_doge: 6,
        });
        db.anchor({
            action_index: 101,
            version: 2,
            match_batch_seq: 6,
            status_id: validId,
            block_index_doge: 7,
        });
        db.anchor({
            action_index: 102,
            version: 2,
            match_batch_seq: 7,
            status_id: validId,
            block_index_doge: 7,
        });

        try {
            const data = await stateHash.buildStateHashData(db, 7, {
                activationDelay: null,
                gasTick: null,
                network: 'regtest',
                coin: 'BTC',
            });
            assert.deepStrictEqual(data.anchor_invalid, [
                { action_index: 99, status: 'invalid_archive' },
            ]);
        } finally {
            db.close();
        }
    });
});
