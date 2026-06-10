// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
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
        db.getActiveDelegation      = sinon.stub().resolves({ delegation_index: 1 });
        db.createDelegation         = sinon.stub().resolves();
        db.createRevokeDelegation   = sinon.stub().resolves();
        db.setDelegationDeactivation = sinon.stub().resolves();
        db.createContractDelegation = sinon.stub().resolves();
        db.getPubkeyId              = sinon.stub().resolves(null);   // pubkey unknown → no collision
        db.getStatusId              = sinon.stub().resolves(1);
        db.doQuery                  = sinon.stub().resolves([]);     // contract stake lookup — empty by default
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

    // ─── v0 — Capability rotate ───────────────────────────────────────────

    describe('v0 — capability rotate', function () {

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

    // ─── v2 — Capability revoke ────────────────────────────────────────

    describe('v2 — capability revoke', function () {

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

        it('rejects when no active delegation for that pubkey', async function () {
            indexer.indexerDb.getActiveDelegation.resolves(null);
            const data = delegateData({ FORMAT: 2 });
            await handler.parse(['2', VALID_PUBKEY], data, null);
            assert.ok(String(data['STATUS']).includes('no active delegation'));
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

    // ─── v1 — Contract-targeted rotate ───────────────────────────────────

    describe('v1 — contract-targeted rotate', function () {

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
            // doQuery returns empty — no matching contract_stakes row
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

    });

    // ─── v3 — Contract-targeted revoke ───────────────────────────────────

    describe('v3 — contract-targeted revoke', function () {

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
