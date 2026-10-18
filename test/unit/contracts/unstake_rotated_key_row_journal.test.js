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

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const gateRegistry = require('../../../src/consensus/gate_registry.js');
const rotationDb   = require('../../../src/db/contracts/delegation_rotation.js');
const { UNARMED }  = require('../../../src/protocol_changes/core.js');
const {
    PUBKEY,
    makeData,
    makeUnstakeContext,
} = require('../actions/stake/unstake.test/helpers/unstake_context.js');

const GATE = 'unstake_delegated_row_journal_activation.UNSTAKE_DELEGATED_ROW_JOURNAL_ACTIVATION';
const ENV  = 'XC_UNSTAKE_DELEGATED_ROW_JOURNAL_REGTEST_ACTIVATION';

function enableGate(){
    const stub = sinon.stub(gateRegistry, 'activeAt').callThrough();
    stub.withArgs(GATE).returns(true);
}

function freshUnstake(){
    const context = makeUnstakeContext();
    context.indexer.config.NETWORK = 'regtest';
    context.indexer.indexerDb.getContract.resolves({ source_id: 42, cooldown_blocks: 200 });
    context.indexer.indexerDb.getActiveContractStakeByPubkey.resolves({
        source_id: 42,
        signing_pubkey_id: 77,
        tick_id: 20,
        amount: '100.00000000',
    });
    context.indexer.indexerDb.getContractStakeRotationOrigin = sinon.stub().resolves({
        originalPubkeyId: 11,
        delegationActionIndex: 900,
    });
    context.indexer.indexerDb.createContractDelegationRotation = sinon.stub().resolves();
    return context;
}

afterEach(function () { sinon.restore(); });

describe('UNSTAKE delegated-row journal gate @regression @tier1', function () {
    it('ships unarmed on mainnet, armed on testnet at its v0.25.0 heights, and supports the regtest drill override', function () {
        const saved = process.env[ENV];
        try {
            delete process.env[ENV];
            assert.strictEqual(gateRegistry.get(GATE).mainnet, UNARMED);
            assert.strictEqual(gateRegistry.get(GATE).testnet, UNARMED);
            // The v0.25.0 cut arms BTC:testnet at 157053.
            assert.strictEqual(gateRegistry.get(GATE)['BTC:testnet'], 157053);
            assert.strictEqual(gateRegistry.activeAt(GATE, 'mainnet', 'BTC', 1e9, null), false);
            assert.strictEqual(gateRegistry.activeAt(GATE, 'testnet', 'BTC', 157052, null), false);
            assert.strictEqual(gateRegistry.activeAt(GATE, 'testnet', 'BTC', 157053, null), true);
            process.env[ENV] = '0';
            assert.strictEqual(gateRegistry.activeAt(GATE, 'regtest', 'BTC', 1, null), true);
        } finally {
            if(saved === undefined) delete process.env[ENV];
            else process.env[ENV] = saved;
        }
    });

    it('journals a full UNSTAKE cooldown row from its original key for later restoration', async function () {
        enableGate();
        const { indexer, handler } = freshUnstake();
        const data = makeData({ FORMAT: 1 });

        await handler.parse(['1', PUBKEY, '5', 'XCHAIN'], data, null);

        sinon.assert.calledOnceWithExactly(indexer.indexerDb.createContractDelegationRotation,
            'contract_unstakes', 900, data.ACTION_INDEX, 11, 77, data.BLOCK_INDEX);
    });

    it('journals both rows produced by a partial UNSTAKE under the delegated key', async function () {
        enableGate();
        const { indexer, handler } = freshUnstake();
        const data = makeData({ FORMAT: 1 });

        await handler.parse(['1', PUBKEY, '5', 'XCHAIN', '40'], data, null);

        assert.deepStrictEqual(indexer.indexerDb.createContractDelegationRotation.args, [
            ['contract_unstakes', 900, data.ACTION_INDEX, 11, 77, data.BLOCK_INDEX],
            ['contract_stakes', 900, data.ACTION_INDEX, 11, 77, data.BLOCK_INDEX],
        ]);
    });

    it('writes no synthetic rotation when the current slot has no rotation origin', async function () {
        enableGate();
        const { indexer, handler } = freshUnstake();
        indexer.indexerDb.getContractStakeRotationOrigin.resolves(null);

        await handler.parse(['1', PUBKEY, '5', 'XCHAIN'], makeData({ FORMAT: 1 }), null);

        sinon.assert.notCalled(indexer.indexerDb.createContractDelegationRotation);
    });
});

describe('Database.getContractStakeRotationOrigin() for UNSTAKE journaling @regression @tier1', function () {
    it('keeps the first key and the last delegation that installed the current key', async function () {
        const rows = [
            { stake_action_index: 100, delegation_action_index: 900,
              prev_signing_pubkey_id: 11, new_signing_pubkey_id: 77, block_index: 306 },
            { stake_action_index: 100, delegation_action_index: 900,
              prev_signing_pubkey_id: 77, new_signing_pubkey_id: 11, block_index: 400 },
            { stake_action_index: 101, delegation_action_index: 901,
              prev_signing_pubkey_id: 22, new_signing_pubkey_id: 77, block_index: 405 },
        ];
        const db = { doQuery: sinon.stub().resolves(rows) };

        assert.deepStrictEqual(await rotationDb.getContractStakeRotationOrigin.call(db, 5, 42, 20, 77), {
            originalPubkeyId: 11,
            delegationActionIndex: 901,
        });
        const [sql, args] = db.doQuery.firstCall.args;
        assert.deepStrictEqual(args, ['contract_stakes', 5, 42, 20, 77]);
        assert.match(sql, /ORDER BY r\.block_index ASC, r\.delegation_action_index ASC,\s*r\.stake_action_index ASC/);
        assert.doesNotMatch(sql, /ORDER BY[^;]*\br\.id\b/);
    });
});
