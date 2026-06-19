// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Delegate = require('../../../src/actions/delegate.js');

const VALID_PUBKEY  = 'a'.repeat(64);   // 64 lowercase hex chars (Ed25519)
const VALID_PUBKEY2 = 'b'.repeat(64);

describe('Delegate (DELEGATE) @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

    function addDelegateStubs(db) {
        db.getActiveStakeBySource   = sinon.stub().resolves({ stake_index: 1 });
        db.getActiveStakeByPubkey   = sinon.stub().resolves(null);  // pubkey not in use
        db.getDelegationByPubkey    = sinon.stub().resolves(null);  // pubkey not delegated
        db.getActiveDelegation      = sinon.stub().resolves({ delegation_index: 1 });
        db.getActiveStakeBySourceAndPubkey = sinon.stub().resolves(null);  // v2 stake-key mode: no own-stake match
        db.getStakeKeyRevocation    = sinon.stub().resolves(null);  // no prior stake-key revocation
        db.createDelegation         = sinon.stub().resolves();
        db.createRevokeDelegation   = sinon.stub().resolves();
        db.createStakeKeyRevocation = sinon.stub().resolves();
        db.setDelegationDeactivation = sinon.stub().resolves();
        db.createContractDelegation = sinon.stub().resolves();
        db.getPubkeyId              = sinon.stub().resolves(null);   // pubkey unknown → no collision
        db.getStatusId              = sinon.stub().resolves(1);
        db.doQuery                  = sinon.stub().resolves([]);     // contract stake lookup, empty by default
    }

    function delegateData(overrides = {}) {
        return createBaseData({ ACTION: 'DELEGATE', FORMAT: 0, COIN: 'BTC', SOURCE, ...overrides });
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        addDelegateStubs(indexer.indexerDb);
        indexer.indexerDb.isActionAllowed.resolves(true);

        actionsCtx = {
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
        };
        handler = new Delegate(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── v0: Capability rotate ───────────────────────────────────────────

    describe('v0: capability rotate', function () {

        it('valid delegation → STATUS valid and createDelegation called', async function () {
            const data = delegateData({ FORMAT: 0 });
            await handler.parse(['0', VALID_PUBKEY], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createDelegation.calledOnce);
        });

        it('rejects an unknown VERSION', async function () {
            const data = delegateData({ FORMAT: 9 });
            await handler.parse(['9', VALID_PUBKEY], data, null);
            assert.ok(String(data['STATUS']).includes('VERSION'));
        });

        it('rejects on non-BTC chain', async function () {
            const data = delegateData({ FORMAT: 0, COIN: 'LTC' });
            await handler.parse(['0', VALID_PUBKEY], data, null);
            assert.ok(String(data['STATUS']).includes('BTC only'));
        });

        it('rejects when SIGNING_PUBKEY is missing', async function () {
            const data = delegateData({ FORMAT: 0 });
            await handler.parse(['0', ''], data, null);
            assert.ok(String(data['STATUS']).includes('SIGNING_PUBKEY'));
        });

        it('rejects when SIGNING_PUBKEY is wrong length', async function () {
            const data = delegateData({ FORMAT: 0 });
            await handler.parse(['0', 'abcd'], data, null);  // too short
            assert.ok(String(data['STATUS']).includes('SIGNING_PUBKEY'));
        });

        it('rejects when SIGNING_PUBKEY contains non-hex chars', async function () {
            const data = delegateData({ FORMAT: 0 });
            await handler.parse(['0', 'z'.repeat(64)], data, null);
            assert.ok(String(data['STATUS']).includes('SIGNING_PUBKEY'));
        });

        it('rejects when SOURCE has no active stake', async function () {
            indexer.indexerDb.getActiveStakeBySource.resolves(null);
            const data = delegateData({ FORMAT: 0 });
            await handler.parse(['0', VALID_PUBKEY], data, null);
            assert.ok(String(data['STATUS']).includes('no active stake'));
        });

        it('rejects when SIGNING_PUBKEY is already in use', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ stake_index: 5 });
            const data = delegateData({ FORMAT: 0 });
            await handler.parse(['0', VALID_PUBKEY], data, null);
            assert.ok(String(data['STATUS']).includes('already in use'));
        });

        it('rejects when SIGNING_PUBKEY is held by an active delegation (F9)', async function () {
            indexer.indexerDb.getDelegationByPubkey.resolves({ delegation_index: 7 });
            const data = delegateData({ FORMAT: 0 });
            await handler.parse(['0', VALID_PUBKEY], data, null);
            assert.ok(String(data['STATUS']).includes('already delegated'));
            assert.ok(indexer.indexerDb.createDelegation.calledOnce); // row recorded with invalid status
        });

        it('delegation collision check is height-gated so revoked delegations free the pubkey (F9)', async function () {
            const data = delegateData({ FORMAT: 0 });
            await handler.parse(['0', VALID_PUBKEY], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            // The helper must receive the action's BLOCK_INDEX; the SQL frees
            // pubkeys whose delegation deactivated at or before this height.
            const call = indexer.indexerDb.getDelegationByPubkey.getCall(0);
            assert.strictEqual(call.args[0], VALID_PUBKEY);
            assert.strictEqual(call.args[1], data['BLOCK_INDEX']);
        });

        it('rejects when SOURCE is sleeping', async function () {
            indexer.indexerDb.isActionAllowed.resolves(false);
            const data = delegateData({ FORMAT: 0 });
            await handler.parse(['0', VALID_PUBKEY], data, null);
            assert.ok(String(data['STATUS']).includes('sleeping'));
        });

        it('sets ACTIVATION_BLOCK based on current block + delay', async function () {
            const data = delegateData({ FORMAT: 0, BLOCK_INDEX: 1000 });
            await handler.parse(['0', VALID_PUBKEY], data, null);
            const delay = indexer.config['STAKING'] && indexer.config['STAKING']['ACTIVATION_DELAY_BLOCKS']
                ? indexer.config['STAKING']['ACTIVATION_DELAY_BLOCKS']
                : indexer.config['ACTIVATION_DELAY_BLOCKS'];
            assert.strictEqual(data['ACTIVATION_BLOCK'], 1000 + delay);
        });

        it('calls updateBalances and updateTokens after parse', async function () {
            const data = delegateData({ FORMAT: 0 });
            await handler.parse(['0', VALID_PUBKEY], data, null);
            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
            assert.ok(indexer.indexerDb.updateTokens.calledOnce);
        });

        it('calls mapper.createMappings after parse', async function () {
            const data = delegateData({ FORMAT: 0 });
            await handler.parse(['0', VALID_PUBKEY], data, null);
            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

    });

    // ─── v2: Capability revoke ────────────────────────────────────────

    describe('v2: capability revoke', function () {

        it('valid revoke → STATUS valid and createRevokeDelegation called', async function () {
            const data = delegateData({ FORMAT: 2 });
            await handler.parse(['2', VALID_PUBKEY], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createRevokeDelegation.calledOnce);
        });

        it('rejects on non-BTC chain', async function () {
            const data = delegateData({ FORMAT: 2, COIN: 'DOGE' });
            await handler.parse(['2', VALID_PUBKEY], data, null);
            assert.ok(String(data['STATUS']).includes('BTC only'));
        });

        it('rejects missing SIGNING_PUBKEY', async function () {
            const data = delegateData({ FORMAT: 2 });
            await handler.parse(['2', ''], data, null);
            assert.ok(String(data['STATUS']).includes('SIGNING_PUBKEY'));
        });

        it('rejects when no active delegation AND no own stake key matches', async function () {
            indexer.indexerDb.getActiveDelegation.resolves(null);
            const data = delegateData({ FORMAT: 2 });
            await handler.parse(['2', VALID_PUBKEY], data, null);
            assert.ok(String(data['STATUS']).includes('no active delegation or stake key'));
        });

        it('stake-key mode: revoking the source\'s own stake signing key → valid, recorded in stake_key_revocations only', async function () {
            indexer.indexerDb.getActiveDelegation.resolves(null);
            indexer.indexerDb.getActiveStakeBySourceAndPubkey.resolves({ action_index: 50 });
            const data = delegateData({ FORMAT: 2, BLOCK_INDEX: 1000 });
            await handler.parse(['2', VALID_PUBKEY], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createStakeKeyRevocation.calledOnce);
            // Must NOT touch the delegations table; a delegations record here
            // would read as an active delegation and re-add the revoked key.
            assert.ok(indexer.indexerDb.createRevokeDelegation.notCalled);
            assert.ok(indexer.indexerDb.setDelegationDeactivation.notCalled);
            const delay = indexer.config['STAKING'] && indexer.config['STAKING']['ACTIVATION_DELAY_BLOCKS']
                ? indexer.config['STAKING']['ACTIVATION_DELAY_BLOCKS']
                : indexer.config['ACTIVATION_DELAY_BLOCKS'];
            assert.strictEqual(data['DEACTIVATION_BLOCK'], 1000 + delay);
        });

        it('stake-key mode: prior revocation check is scoped to the stake row\'s action_index (re-stake clears it)', async function () {
            indexer.indexerDb.getActiveDelegation.resolves(null);
            indexer.indexerDb.getActiveStakeBySourceAndPubkey.resolves({ action_index: 50 });
            const data = delegateData({ FORMAT: 2 });
            await handler.parse(['2', VALID_PUBKEY], data, null);
            const call = indexer.indexerDb.getStakeKeyRevocation.getCall(0);
            assert.strictEqual(call.args[0], SOURCE);
            assert.strictEqual(call.args[1], VALID_PUBKEY);
            assert.strictEqual(call.args[2], 50);
        });

        it('stake-key mode: rejects a second revocation of the same stake key', async function () {
            indexer.indexerDb.getActiveDelegation.resolves(null);
            indexer.indexerDb.getActiveStakeBySourceAndPubkey.resolves({ action_index: 50 });
            indexer.indexerDb.getStakeKeyRevocation.resolves({ action_index: 60 });
            const data = delegateData({ FORMAT: 2 });
            await handler.parse(['2', VALID_PUBKEY], data, null);
            assert.ok(String(data['STATUS']).includes('already revoked'));
            assert.ok(indexer.indexerDb.createStakeKeyRevocation.notCalled);
        });

        it('delegation-row revoke still wins when both a delegation and a stake key exist', async function () {
            // getActiveDelegation resolves a row (default stub); the stake-key
            // branch must not be consulted at all.
            const data = delegateData({ FORMAT: 2 });
            await handler.parse(['2', VALID_PUBKEY], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createRevokeDelegation.calledOnce);
            assert.ok(indexer.indexerDb.getActiveStakeBySourceAndPubkey.notCalled);
            assert.ok(indexer.indexerDb.createStakeKeyRevocation.notCalled);
        });

        it('calls setDelegationDeactivation on valid revoke', async function () {
            const data = delegateData({ FORMAT: 2 });
            await handler.parse(['2', VALID_PUBKEY], data, null);
            assert.ok(indexer.indexerDb.setDelegationDeactivation.calledOnce);
        });

        it('rejects when SOURCE is sleeping', async function () {
            indexer.indexerDb.isActionAllowed.resolves(false);
            const data = delegateData({ FORMAT: 2 });
            await handler.parse(['2', VALID_PUBKEY], data, null);
            assert.ok(String(data['STATUS']).includes('sleeping'));
        });

    });

    // ─── v1: Contract-targeted rotate ───────────────────────────────────

    describe('v1: contract-targeted rotate', function () {

        function v1Data() { return delegateData({ FORMAT: 1 }); }

        beforeEach(function () {
            // doQuery for getAddressId-based contract_stake lookup returns one row (active stake)
            indexer.indexerDb.doQuery.resolves([{ 1: 1 }]);
        });

        it('rejects missing SIGNING_PUBKEY', async function () {
            const data = v1Data();
            await handler.parse(['1', '', '5', 'TEST'], data, null);
            assert.ok(String(data['STATUS']).includes('SIGNING_PUBKEY'));
        });

        it('rejects bad pubkey format', async function () {
            const data = v1Data();
            await handler.parse(['1', 'bad', '5', 'TEST'], data, null);
            assert.ok(String(data['STATUS']).includes('SIGNING_PUBKEY'));
        });

        it('rejects missing TARGET_CONTRACT_INDEX', async function () {
            const data = v1Data();
            await handler.parse(['1', VALID_PUBKEY, '', 'TEST'], data, null);
            assert.ok(String(data['STATUS']).includes('TARGET_CONTRACT_INDEX'));
        });

        it('rejects invalid TARGET_CONTRACT_INDEX (non-numeric)', async function () {
            const data = v1Data();
            await handler.parse(['1', VALID_PUBKEY, 'abc', 'TEST'], data, null);
            assert.ok(String(data['STATUS']).includes('TARGET_CONTRACT_INDEX'));
        });

        it('rejects zero TARGET_CONTRACT_INDEX', async function () {
            const data = v1Data();
            await handler.parse(['1', VALID_PUBKEY, '0', 'TEST'], data, null);
            assert.ok(String(data['STATUS']).includes('TARGET_CONTRACT_INDEX'));
        });

        it('rejects missing TICK', async function () {
            const data = v1Data();
            await handler.parse(['1', VALID_PUBKEY, '5', ''], data, null);
            assert.ok(String(data['STATUS']).includes('TICK'));
        });

        it('rejects when SOURCE has no active contract stake', async function () {
            // doQuery returns empty (no matching contract_stakes row)
            indexer.indexerDb.doQuery.resolves([]);
            indexer.indexerDb.getAddressId.resolves(1);
            const data = v1Data();
            await handler.parse(['1', VALID_PUBKEY, '5', 'TEST'], data, null);
            assert.ok(String(data['STATUS']).includes('no active contract stake'));
        });

        it('valid contract rotate → createContractDelegation called', async function () {
            // getAddressId returns a valid id; doQuery returns a matching stake row
            indexer.indexerDb.getAddressId.resolves(1);
            indexer.indexerDb.getTickerId.resolves(2);
            indexer.indexerDb.doQuery.resolves([{ 1: 1 }]);

            const data = v1Data();
            await handler.parse(['1', VALID_PUBKEY, '5', 'TEST'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createContractDelegation.calledOnce);
        });

        it('stake-existence check requires a fully-active stake, not a mid-unstake slot', async function () {
            // Consensus predicate guard: a rotate must match only a contract_stakes row with
            // deactivation_block IS NULL. A row whose UNSTAKE set a future deactivation_block is
            // mid-cooldown (tokens leaving), and accepting a rotate there binds a signer that
            // outlives its stake. Lock the SQL so the active-window (deactivation_block > ?) form
            // cannot be reintroduced. The mock suite can't run the WHERE clause, so assert the text.
            indexer.indexerDb.getAddressId.resolves(1);
            indexer.indexerDb.getTickerId.resolves(2);
            indexer.indexerDb.doQuery.resolves([{ 1: 1 }]);

            const data = v1Data();
            await handler.parse(['1', VALID_PUBKEY, '5', 'TEST'], data, null);

            const stakeQ = indexer.indexerDb.doQuery.getCalls()
                .map(c => String(c.args[0]))
                .find(sql => /FROM contract_stakes/.test(sql) && /target_contract_index/.test(sql));
            assert.ok(stakeQ, 'contract_stakes existence query was issued');
            assert.ok(/deactivation_block IS NULL/.test(stakeQ),
                'rotate must require a fully-active stake (deactivation_block IS NULL)');
            assert.ok(!/deactivation_block\s*>/.test(stakeQ),
                'rotate must NOT accept a mid-unstake slot via the active-window (deactivation_block > ?) form');
        });

    });

    // ─── v3: Contract-targeted revoke ───────────────────────────────────

    describe('v3: contract-targeted revoke', function () {

        function v3Data() { return delegateData({ FORMAT: 3 }); }

        beforeEach(function () {
            // doQuery returns a matching contract_delegations row
            indexer.indexerDb.doQuery.resolves([{ 1: 1 }]);
            indexer.indexerDb.getAddressId.resolves(10);
            indexer.indexerDb.getTickerId.resolves(2);
            indexer.indexerDb.getPubkeyId.resolves(3);
        });

        it('rejects missing SIGNING_PUBKEY', async function () {
            const data = v3Data();
            await handler.parse(['3', '', '5', 'TEST'], data, null);
            assert.ok(String(data['STATUS']).includes('SIGNING_PUBKEY'));
        });

        it('rejects missing TARGET_CONTRACT_INDEX', async function () {
            const data = v3Data();
            await handler.parse(['3', VALID_PUBKEY, '', 'TEST'], data, null);
            assert.ok(String(data['STATUS']).includes('TARGET_CONTRACT_INDEX'));
        });

        it('rejects missing TICK', async function () {
            const data = v3Data();
            await handler.parse(['3', VALID_PUBKEY, '5', ''], data, null);
            assert.ok(String(data['STATUS']).includes('TICK'));
        });

        it('rejects when no active contract delegation found', async function () {
            indexer.indexerDb.doQuery.resolves([]);
            const data = v3Data();
            await handler.parse(['3', VALID_PUBKEY, '5', 'TEST'], data, null);
            assert.ok(String(data['STATUS']).includes('no active contract delegation'));
        });

        it('valid contract revoke → sets deactivation_block via UPDATE query', async function () {
            indexer.indexerDb.doQuery
                .onFirstCall().resolves([{ 1: 1 }])  // delegation lookup
                .onSecondCall().resolves([]);          // UPDATE (no return expected)

            const data = v3Data();
            await handler.parse(['3', VALID_PUBKEY, '5', 'TEST'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            // doQuery called at least twice: delegation existence + UPDATE deactivation_block
            assert.ok(indexer.indexerDb.doQuery.callCount >= 2);
        });

    });
});
