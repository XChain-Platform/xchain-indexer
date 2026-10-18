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

process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const { makeAnchorDb } = require('../../../helpers/sqlAnchorDb');
const { collectAnchorInvalid } = require('../../../../src/consensus/state_hash/archive_invalid_section');
const {
    archiveHeadPredicate,
    ARCHIVE_HEAD_VERSIONS_SQL,
} = require('../../../../src/consensus/state_hash/activation');

const NETWORKS = ['mainnet', 'testnet', 'regtest'];
const COINS = ['BTC', 'LTC', 'DOGE'];
const BLOCKS = [7, 900000];

describe('archive invalid collection on every configured network @regression', () => {
    it('selects the widened archive-head class for every coin, network and sampled block', async function(){
        const expectedPredicate = archiveHeadPredicate('p') +
            ' AND p.version ' + ARCHIVE_HEAD_VERSIONS_SQL;

        for(const network of NETWORKS){
            for(const coin of COINS){
                for(const blockIndex of BLOCKS){
                    const captured = [];
                    const db = makeAnchorDb(captured);
                    try {
                        const invalidId = db.status('invalid_archive');
                        const validId = db.status('valid');
                        db.anchor({
                            action_index: 100,
                            version: 1,
                            chain: 'BTC',
                            network,
                            block_index: 5000,
                            match_batch_seq: 7,
                            match_count: 3,
                            batch_crc32: 'deadbeef',
                            total_chunks: 2,
                            status_id: invalidId,
                            block_index_doge: blockIndex - 3,
                        });
                        db.anchor({
                            action_index: 301,
                            version: 2,
                            match_batch_seq: 7,
                            chunk_index: 1,
                            total_chunks: 2,
                            archive_b64: 'AAAA',
                            status_id: validId,
                            block_index: blockIndex,
                            block_index_doge: blockIndex,
                        });

                        const rows = await collectAnchorInvalid(db, blockIndex, network, coin);
                        assert.deepStrictEqual(rows, [
                            { action_index: 100, status: 'invalid_archive' },
                        ], `${coin}:${network} at ${blockIndex}`);

                        const sql = captured.find(query => query.indexOf('anchor_actions p') !== -1);
                        assert.ok(sql, `${coin}:${network} at ${blockIndex} must issue anchor SQL`);
                        assert.ok(sql.indexOf(expectedPredicate) !== -1,
                            `${coin}:${network} at ${blockIndex} must use the widened archive-head predicate`);
                        assert.strictEqual(sql.indexOf('p.version = 1'), -1,
                            `${coin}:${network} at ${blockIndex} must not use the legacy predicate`);
                    } finally {
                        db.close();
                    }
                }
            }
        }
    });
});
