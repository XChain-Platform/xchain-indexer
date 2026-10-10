'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createTokenInfo } = require('../../../../fixtures/mocks');
const { getTestConfig }   = require('../../../../fixtures/config');
const Utility             = require('../../../../../src/utility');
const Database            = require('../../../../../src/db');
const { PUBKEY, makeData, useStakeHarness } = require('../stake.test/helpers/stake_harness.js');

const VALID          = 1;
const CONTRACT_INDEX = '5';
const CONTRACT_TICK  = 'TEST';
const PARAMS         = ['3', '100', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];

let indexer, actionsCtx, handler;
const bind = (h) => { ({ indexer, actionsCtx, handler } = h); };

function contractToken() {
    return createTokenInfo({ TICK: CONTRACT_TICK, TICK_ID: 2, DECIMALS: 0 });
}

describe('Stake v3 delegated signing key claim @regression @tier2', function () {
    useStakeHarness(bind);

    beforeEach(function () {
        indexer.indexerDb.getStatusId = sinon.stub().resolves(VALID);
        indexer.indexerDb.getPubkeyId = sinon.stub().resolves(77);
        indexer.indexerDb.isSigningPubkeyUsedByContractDelegation = sinon.stub().resolves(true);
        indexer.indexerDb.getContract.resolves({ source_id: 42, cooldown_blocks: 100 });
        indexer.indexerDb.getStatusString.resolves('valid');
        indexer.indexerDb.getTokenInfo.resolves(contractToken());
        indexer.indexerDb.getAddressBalances.resolves({ 2: '1000' });
    });

    it('rejects a new stake claim when the key is reserved by a contract delegation', async function () {
        indexer.indexerDb.getContractStakeOwner.resolves(null);
        const data = makeData({ FORMAT: 3 });

        await handler.parse(PARAMS, data, null);

        assert.strictEqual(data.STATUS, 'invalid: SIGNING_PUBKEY (already in use by contract delegation)');
        assert.ok(actionsCtx.protocolChanges.isEnabled.calledWith('STAKE_DELEGATED_SIGNING_KEY', data.BLOCK_INDEX));
        assert.ok(indexer.indexerDb.isSigningPubkeyUsedByContractDelegation.calledWith(77, VALID, data.BLOCK_INDEX));
    });

    it('rejects a same-source top-up through the delegated key', async function () {
        indexer.indexerDb.getContractStakeOwner.resolves(42);
        indexer.indexerDb.getAddressId.resolves(42);
        const data = makeData({ FORMAT: 3 });

        await handler.parse(PARAMS, data, null);

        assert.strictEqual(data.STATUS, 'invalid: SIGNING_PUBKEY (already in use by contract delegation)');
    });

    it('keeps the direct stake collision verdict ahead of the delegated-key verdict', async function () {
        indexer.indexerDb.getContractStakeOwner.resolves(99);
        const data = makeData({ FORMAT: 3 });

        await handler.parse(PARAMS, data, null);

        assert.strictEqual(data.STATUS, 'invalid: SIGNING_PUBKEY (already staked to this contract by another source)');
        assert.ok(indexer.indexerDb.isSigningPubkeyUsedByContractDelegation.notCalled);
    });
});

function makeDb(gateEnabled) {
    const config = getTestConfig();
    const util = new Utility();
    sinon.stub(util, 'logError');
    const protocolChanges = { isEnabled: sinon.stub().resolves(gateEnabled) };
    const parent = { config, util, actions: { protocolChanges } };
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', parent);
    db.pool = { getConnection: sinon.stub().resolves({
        query: sinon.stub().resolves([]),
        release: sinon.stub().resolves()
    }) };
    sinon.stub(db, 'getStatusId').callsFake(async (status) => status === 'valid' ? VALID : 2);
    return { db, protocolChanges };
}

function wireRotation(db, state) {
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        calls.push({ sql: String(sql), args });
        if (/^\s*UPDATE contract_(?:un)?stakes SET signing_pubkey_id/i.test(sql)) return [];
        if (/^\s*INSERT INTO contract_delegation_rotations/i.test(sql)) return [];
        if (/FROM contract_delegations d\b/i.test(sql)) return state.governing || [];
        if (/SELECT 1 FROM \(/i.test(sql)) return state.claims || [];
        if (/FROM contract_delegation_rotations r\b/i.test(sql)) return [];
        if (/FROM contract_stakes\b[\s\S]*target_contract_index=\?\s*AND source_id/i.test(sql))
            return state.stakeRows || [];
        if (/FROM contract_unstakes\b[\s\S]*target_contract_index=\?\s*AND source_id/i.test(sql))
            return state.unstakeRows || [];
        return [];
    });
    return calls;
}

const GOVERNING = [{
    action_index: 900,
    source_id: 5,
    signing_pubkey_id: 77,
    target_contract_index: 42,
    tick_id: 20
}];

describe('Delegated signing key materialization slot @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('does not rotate a governed stake when another slot holds the delegated key', async function () {
        const { db, protocolChanges } = makeDb(true);
        const calls = wireRotation(db, {
            governing: GOVERNING,
            claims: [{ 1: 1 }],
            stakeRows: [{ action_index: 100, signing_pubkey_id: 11 }]
        });

        const applied = await db.materializeContractDelegations(306);

        assert.deepStrictEqual(applied, []);
        assert.ok(protocolChanges.isEnabled.calledWith('STAKE_DELEGATED_SIGNING_KEY', 306));
        assert.strictEqual(calls.filter(c => /UPDATE contract_stakes SET signing_pubkey_id/i.test(c.sql)).length, 0);
    });

    it('rotates when the merged claim query finds no key holder outside the governed slot', async function () {
        const { db } = makeDb(false);
        const calls = wireRotation(db, {
            governing: GOVERNING,
            claims: [],
            stakeRows: [{ action_index: 100, signing_pubkey_id: 11 }]
        });

        const applied = await db.materializeContractDelegations(306, true);

        assert.strictEqual(applied.length, 1);
        const claim = calls.find(c => /SELECT 1 FROM \(/i.test(c.sql));
        assert.ok(claim);
        assert.ok(/FROM contract_stakes[\s\S]*UNION ALL[\s\S]*FROM contract_delegations/.test(claim.sql));
        assert.ok(/WHERE NOT \(target_contract_index=\? AND source_id=\? AND tick_id=\?\)/.test(claim.sql));
        assert.deepStrictEqual(claim.args, [77, VALID, 77, VALID, 306, 42, 5, 20]);
        assert.deepStrictEqual(calls.filter(c => /UPDATE contract_stakes SET signing_pubkey_id/i.test(c.sql))
            .map(c => c.args), [[77, 100]]);
    });
});

describe('Contract delegation signing key claim query @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('reserves pending and live delegations but releases a key at its deactivation block', async function () {
        const { db } = makeDb(true);
        sinon.stub(db, 'doQuery').resolves([]);

        const used = await db.isSigningPubkeyUsedByContractDelegation(77, VALID, 306);

        assert.strictEqual(used, false);
        const [sql, args] = db.doQuery.firstCall.args;
        assert.ok(/deactivation_block IS NULL OR deactivation_block > \?/.test(sql));
        assert.ok(!/\bactivation_block/.test(sql));
        assert.deepStrictEqual(args, [77, VALID, 306]);
    });
});
