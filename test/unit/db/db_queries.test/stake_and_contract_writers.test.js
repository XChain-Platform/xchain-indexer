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
 **********************************************************************
 * test/unit/db/db_queries.test/stake_and_contract_writers.test.js
 *
 * The staking and contract row writers: stake, unstake, delegation, contract,
 * execution, deposit, withdrawal, state, emission, delete, contract stake and
 * reward claim.
 *
 * Part of the Database query suite (see ../db_queries.test.js): real method
 * logic against a stubbed doQuery, no live MariaDB required.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('./helpers/db_stub');

afterEach(function () {
    sinon.restore();
});

// ---------------------------------------------------------------------------
// createStake: INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createStake() @regression @tier1', function () {
    function makeStakeDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'getOrCreatePubkeyId').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeStakeDb([]);
        await db.createStake({ ACTION_INDEX: 300, STATUS: 'valid', SOURCE: 'addr1', SIGNING_PUBKEY: 'pubkey1', AMOUNT: '1000', BLOCK_INDEX: 100 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO stakes'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeStakeDb([{ action_index: 300 }]);
        await db.createStake({ ACTION_INDEX: 300, STATUS: 'valid', SOURCE: 'addr1', SIGNING_PUBKEY: 'pubkey1', AMOUNT: '1000', BLOCK_INDEX: 100 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE stakes'));
    });
});

// ---------------------------------------------------------------------------
// createUnstake: INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createUnstake() @regression @tier1', function () {
    function makeUnstakeDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'getOrCreatePubkeyId').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeUnstakeDb([]);
        await db.createUnstake({ ACTION_INDEX: 310, STATUS: 'valid', SOURCE: 'addr1', SIGNING_PUBKEY: 'pk', AMOUNT: '1000', BLOCK_INDEX: 110 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO unstakes'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeUnstakeDb([{ action_index: 310 }]);
        await db.createUnstake({ ACTION_INDEX: 310, STATUS: 'valid', SOURCE: 'addr1', SIGNING_PUBKEY: 'pk', AMOUNT: '1000', BLOCK_INDEX: 110 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE unstakes'));
    });
});

// ---------------------------------------------------------------------------
// createDelegation: INSERT and UPDATE; createRevokeDelegation delegates
// ---------------------------------------------------------------------------
describe('Database.createDelegation() @regression @tier1', function () {
    function makeDelegationDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'getOrCreatePubkeyId').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeDelegationDb([]);
        await db.createDelegation({ ACTION_INDEX: 320, STATUS: 'valid', SOURCE: 'addr1', SIGNING_PUBKEY: 'pk', BLOCK_INDEX: 120 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO delegations'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeDelegationDb([{ action_index: 320 }]);
        await db.createDelegation({ ACTION_INDEX: 320, STATUS: 'valid', SOURCE: 'addr1', SIGNING_PUBKEY: 'pk', BLOCK_INDEX: 120 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE delegations'));
    });

    it('createRevokeDelegation delegates to createDelegation', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'createDelegation').resolves();
        await db.createRevokeDelegation({ ACTION_INDEX: 330, STATUS: 'revoked', SOURCE: 'addr1', SIGNING_PUBKEY: 'pk', BLOCK_INDEX: 130 });
        assert.ok(stub.calledOnce);
    });
});

// ---------------------------------------------------------------------------
// createContract: INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createContract() @regression @tier1', function () {
    function makeContractDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'createAddress').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeContractDb([]);
        await db.createContract({ ACTION_INDEX: 400, STATUS: 'valid', SOURCE: 'addr1', CODE: 'function(){}', CODE_HASH: 'abc', BLOCK_INDEX: 200 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO contracts'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeContractDb([{ action_index: 400 }]);
        await db.createContract({ ACTION_INDEX: 400, STATUS: 'valid', SOURCE: 'addr1', CODE: 'function(){}', CODE_HASH: 'abc', BLOCK_INDEX: 200 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE contracts'));
    });
});

// ---------------------------------------------------------------------------
// createContractExecution: INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createContractExecution() @regression @tier1', function () {
    function makeExecDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeExecDb([]);
        await db.createContractExecution({ ACTION_INDEX: 410, STATUS: 'valid', CALLER: 'addr1',
                                            CONTRACT_INDEX: 400, METHOD_NAME: 'run', INPUT_PARAMS: '[]',
                                            GAS_USED: 100, GAS_LIMIT: 1000, BLOCK_INDEX: 210 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO contract_executions'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeExecDb([{ action_index: 410 }]);
        await db.createContractExecution({ ACTION_INDEX: 410, STATUS: 'valid', CALLER: 'addr1',
                                            CONTRACT_INDEX: 400, METHOD_NAME: 'run', INPUT_PARAMS: '[]',
                                            GAS_USED: 100, GAS_LIMIT: 1000, BLOCK_INDEX: 210 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE contract_executions'));
    });
});

// ---------------------------------------------------------------------------
// createDeposit: INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createDeposit() @regression @tier1', function () {
    function makeDepositDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'createTicker').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeDepositDb([]);
        await db.createDeposit({ ACTION_INDEX: 420, STATUS: 'valid', SOURCE: 'addr1', TICK: 'FOO', AMOUNT: '50', CONTRACT_ACTION_INDEX: 400, BLOCK_INDEX: 220 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO deposits'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeDepositDb([{ action_index: 420 }]);
        await db.createDeposit({ ACTION_INDEX: 420, STATUS: 'valid', SOURCE: 'addr1', TICK: 'FOO', AMOUNT: '50', CONTRACT_ACTION_INDEX: 400, BLOCK_INDEX: 220 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE deposits'));
    });
});

// ---------------------------------------------------------------------------
// createWithdrawal: INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createWithdrawal() @regression @tier1', function () {
    function makeWithdrawalDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'createTicker').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeWithdrawalDb([]);
        await db.createWithdrawal({ ACTION_INDEX: 430, STATUS: 'valid', SOURCE: 'addr1', TICK: 'FOO', AMOUNT: '20', CONTRACT_ACTION_INDEX: 400, BLOCK_INDEX: 230 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO withdrawals'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeWithdrawalDb([{ action_index: 430 }]);
        await db.createWithdrawal({ ACTION_INDEX: 430, STATUS: 'valid', SOURCE: 'addr1', TICK: 'FOO', AMOUNT: '20', CONTRACT_ACTION_INDEX: 400, BLOCK_INDEX: 230 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE withdrawals'));
    });
});

// ---------------------------------------------------------------------------
// createContractState
// ---------------------------------------------------------------------------
describe('Database.createContractState() @regression @tier1', function () {
    it('inserts a state row', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.createContractState({ CONTRACT_INDEX: 400, STATE_KEY: 'counter', STATE_VALUE: '1', BLOCK_INDEX: 100, ACTION_INDEX: 10 });
        assert.ok(String(dq.args[0][0]).includes('INSERT INTO contract_state'));
    });
});

// ---------------------------------------------------------------------------
// createContractEmission
// ---------------------------------------------------------------------------
describe('Database.createContractEmission() @regression @tier1', function () {
    it('inserts an emission row', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.createContractEmission({ EXECUTION_INDEX: 10, EMITTED_ACTION: 'SEND', ACTION_INDEX: 11, POSITION: 0 });
        assert.ok(String(dq.args[0][0]).includes('INSERT INTO contract_emissions'));
    });
});

// ---------------------------------------------------------------------------
// deleteContract
// ---------------------------------------------------------------------------
describe('Database.deleteContract() @regression @tier1', function () {
    it('runs DELETE on contracts table', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.deleteContract(400);
        assert.ok(String(dq.args[0][0]).includes('DELETE FROM contracts'));
    });
});

// ---------------------------------------------------------------------------
// createContractStake: INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createContractStake() @regression @tier1', function () {
    function makeCSDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'getOrCreatePubkeyId').resolves(3);
        sinon.stub(db, 'createTicker').resolves(4);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeCSDb([]);
        await db.createContractStake({ ACTION_INDEX: 600, STATUS: 'valid', SOURCE: 'addr1',
                                        SIGNING_PUBKEY: 'pk', TICK: 'FOO', TARGET_CONTRACT_INDEX: 400,
                                        AMOUNT: '100', BLOCK_INDEX: 400 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO contract_stakes'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeCSDb([{ action_index: 600 }]);
        await db.createContractStake({ ACTION_INDEX: 600, STATUS: 'valid', SOURCE: 'addr1',
                                        SIGNING_PUBKEY: 'pk', TICK: 'FOO', TARGET_CONTRACT_INDEX: 400,
                                        AMOUNT: '100', BLOCK_INDEX: 400 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE contract_stakes'));
    });
});

// ---------------------------------------------------------------------------
// createRewardClaim: INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createRewardClaim() @regression @tier1', function () {
    function makeRCDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeRCDb([]);
        await db.createRewardClaim({ ACTION_INDEX: 700, STATUS: 'valid', SOURCE: 'addr1', AMOUNT: '5', BLOCK_INDEX: 500 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO reward_claims'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeRCDb([{ action_index: 700 }]);
        await db.createRewardClaim({ ACTION_INDEX: 700, STATUS: 'valid', SOURCE: 'addr1', AMOUNT: '5', BLOCK_INDEX: 500 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE reward_claims'));
    });
});
