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
 **********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');

function makeDb(rows) {
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', {
        config: getTestConfig(),
        util: new Utility()
    });
    const calls = [];
    db.doQuery = async (sql, args) => {
        calls.push({ sql, args });
        return rows;
    };
    return { db, calls };
}

describe('Database.getContractStakeRotationOrigin @regression @tier1', function () {
    it('returns null for an unrotated slot', async function () {
        const { db, calls } = makeDb([]);

        assert.strictEqual(await db.getContractStakeRotationOrigin(3, 11, 5, 9), null);
        assert.strictEqual(calls.length, 1);
    });

    it('returns the original key and delegation for a single rotation', async function () {
        const { db } = makeDb([
            { stake_action_index: '40', delegation_action_index: '50',
              prev_signing_pubkey_id: '7', new_signing_pubkey_id: '9', block_index: '100' }
        ]);

        assert.deepStrictEqual(await db.getContractStakeRotationOrigin(3, 11, 5, 9), {
            originalPubkeyId: 7,
            delegationActionIndex: 50
        });
    });

    it('keeps the first origin and the last matching delegation through later rotations', async function () {
        const { db } = makeDb([
            { stake_action_index: 40, delegation_action_index: 50,
              prev_signing_pubkey_id: 7, new_signing_pubkey_id: 9, block_index: 100 },
            { stake_action_index: 40, delegation_action_index: 50,
              prev_signing_pubkey_id: 9, new_signing_pubkey_id: 7, block_index: 120 },
            { stake_action_index: 40, delegation_action_index: 60,
              prev_signing_pubkey_id: 7, new_signing_pubkey_id: 9, block_index: 125 },
            { stake_action_index: 40, delegation_action_index: 80,
              prev_signing_pubkey_id: 9, new_signing_pubkey_id: 12, block_index: 130 }
        ]);

        assert.deepStrictEqual(await db.getContractStakeRotationOrigin(3, 11, 5, 9), {
            originalPubkeyId: 7,
            delegationActionIndex: 60
        });
        assert.deepStrictEqual(await db.getContractStakeRotationOrigin(3, 11, 5, 12), {
            originalPubkeyId: 7,
            delegationActionIndex: 80
        });
    });

    it('binds the slot and current key and reads the journal in replay order', async function () {
        const { db, calls } = makeDb([
            { stake_action_index: 40, delegation_action_index: 50,
              prev_signing_pubkey_id: 7, new_signing_pubkey_id: 8, block_index: 100 }
        ]);

        assert.deepStrictEqual(await db.getContractStakeRotationOrigin(3, 11, 5, 9), {
            originalPubkeyId: 7,
            delegationActionIndex: null
        });
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0].args, ['contract_stakes', 3, 11, 5, 9]);
        assert.match(calls[0].sql, /JOIN contract_stakes t ON t\.action_index = r\.stake_action_index/);
        assert.match(calls[0].sql, /t\.signing_pubkey_id=\?/);
        assert.match(calls[0].sql,
            /ORDER BY r\.block_index ASC, r\.delegation_action_index ASC, r\.stake_action_index ASC/);
        assert.doesNotMatch(calls[0].sql, /\b(?:status_id|deactivation_block|r\.id)\b/);
    });
});
