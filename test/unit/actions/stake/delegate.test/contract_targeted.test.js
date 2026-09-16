// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// DELEGATE contract-targeted formats: v1 rotate against an active contract stake
// (including the fully-active stake predicate) and v3 revoke of a contract
// delegation. Part of the Delegate suite; see ../delegate.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { VALID_PUBKEY, SOURCE, delegateData, useDelegateHarness } = require('./helpers/delegate_harness.js');

// The harness under test. useDelegateHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

function v1Data() { return delegateData({ FORMAT: 1 }); }

describe('Delegate (DELEGATE) @regression @tier2', function () {
    useDelegateHarness(bind);

    // ─── v1: Contract-targeted rotate ───────────────────────────────────

    describe('v1: contract-targeted rotate', function () {
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
    });
});

describe('Delegate (DELEGATE) @regression @tier2', function () {
    useDelegateHarness(bind);

    describe('v1: contract-targeted rotate', function () {
        beforeEach(function () {
            // doQuery for getAddressId-based contract_stake lookup returns one row (active stake)
            indexer.indexerDb.doQuery.resolves([{ 1: 1 }]);
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
});

describe('Delegate (DELEGATE) @regression @tier2', function () {
    useDelegateHarness(bind);

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
