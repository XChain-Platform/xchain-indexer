/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db/stakes/db_contract_delegation_held_key_gate_off.test.js
 *
 * Pins the STAKE_DELEGATED_SIGNING_KEY gate-off branch for DELEGATE v1 rotation.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');

const VALID = 1;

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    sinon.stub(db, 'getStatusId').callsFake(async (s) => (s === 'valid' ? VALID : (s === 'pending' ? 2 : null)));
    return db;
}

function wire(db, state) {
    const writes = [];
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        writes.push({ sql, args });
        if (/^\s*UPDATE contract_(?:un)?stakes SET signing_pubkey_id/i.test(sql)) return [];
        if (/^\s*INSERT INTO contract_delegation_rotations/i.test(sql)) return [];
        if (/FROM contract_delegations d\b/i.test(sql)) return state.governing || [];
        if (/FROM contract_delegation_rotations r\b/i.test(sql))
            return (args && args[0] === 'contract_unstakes')
                ? (state.unstakeRotations || [])
                : (state.rotations || []);
        if (/FROM contract_stakes[\s\S]*WHERE signing_pubkey_id=\?/i.test(sql))
            return state.pubkeyHeldByStake || [];
        if (/FROM contract_delegations[\s\S]*WHERE signing_pubkey_id=\?/i.test(sql))
            return state.pubkeyHeldByDelegation || [];
        if (/FROM contract_stakes\b[\s\S]*target_contract_index=\?\s*AND source_id/i.test(sql))
            return state.stakeRows || [];
        if (/FROM contract_unstakes\b[\s\S]*target_contract_index=\?\s*AND source_id/i.test(sql))
            return state.unstakeRows || [];
        return [];
    });
    return writes;
}

const rewrites = (writes) => writes.filter(w => /UPDATE contract_stakes SET signing_pubkey_id/i.test(w.sql));
const unstakeRewrites = (writes) => writes.filter(w => /UPDATE contract_unstakes SET signing_pubkey_id/i.test(w.sql));
const journals = (writes) => writes.filter(w => /INSERT INTO contract_delegation_rotations/i.test(w.sql));

const governing = [{
    action_index: 900,
    source_id: 5,
    signing_pubkey_id: 77,
    target_contract_index: 42,
    tick_id: 20
}];

afterEach(function () { sinon.restore(); });

describe('Database.materializeContractDelegations() held delegated key gate off @regression @tier1', function () {
    it('rotates a stake when another source contract stake already holds the delegated key', async function () {
        const db = makeDb();
        const writes = wire(db, {
            governing,
            stakeRows: [{ action_index: 100, signing_pubkey_id: 11 }],
            pubkeyHeldByStake: [{ 1: 1 }]
        });

        const applied = await db.materializeContractDelegations(306);

        assert.strictEqual(applied.length, 1);
        assert.deepStrictEqual(rewrites(writes).map(w => w.args), [[77, 100]]);
        assert.deepStrictEqual(journals(writes).map(w => w.args), [
            ['contract_stakes', 900, 100, 11, 77, 306]
        ]);
    });

    it('rotates a stake when another live delegation already holds the delegated key', async function () {
        const db = makeDb();
        const writes = wire(db, {
            governing,
            stakeRows: [{ action_index: 100, signing_pubkey_id: 11 }],
            pubkeyHeldByDelegation: [{ 1: 1 }]
        });

        const applied = await db.materializeContractDelegations(306);

        assert.strictEqual(applied.length, 1);
        assert.deepStrictEqual(rewrites(writes).map(w => w.args), [[77, 100]]);
        assert.deepStrictEqual(journals(writes).map(w => w.args), [
            ['contract_stakes', 900, 100, 11, 77, 306]
        ]);
    });

    it('rotates a cooldown row when another source contract stake already holds the delegated key', async function () {
        const db = makeDb();
        const writes = wire(db, {
            governing,
            stakeRows: [],
            unstakeRows: [{ action_index: 200, signing_pubkey_id: 11 }],
            pubkeyHeldByStake: [{ 1: 1 }]
        });

        const applied = await db.materializeContractDelegations(306);

        assert.strictEqual(applied.length, 1);
        assert.deepStrictEqual(unstakeRewrites(writes).map(w => w.args), [[77, 200]]);
    });
});
