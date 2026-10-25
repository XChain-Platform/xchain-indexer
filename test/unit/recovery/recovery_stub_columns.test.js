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

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { memDb } = require('../../helpers/recovery_stubs.js');

describe('recovery stub checkpoint columns @regression @tier1', function(){
    it('maps state_checkpoints INSERT values by their named columns', async function(){
        let columns = [
            'validator_signatures', 'rules_digest', 'supersedes_from', 'snapshot_block',
            'checkpoint_seq', 'contract_hash', 'actions_hash', 'ledger_hash', 'block_hash',
            'block_index', 'network', 'chain', 'id', 'state_root', 'state_root_version',
            'block_merkle_root', 'block_merkle_version'
        ];
        let values = columns.map((column, index) => `${column}-${index}`);
        let expected = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
        let db = memDb([], []);

        await db.doQuery(
            `INSERT IGNORE INTO state_checkpoints (${columns.join(', ')})
             VALUES (${columns.map(() => '?').join(', ')})`,
            values);

        assert.deepStrictEqual(db.checkpoints, [expected]);
    });
});
