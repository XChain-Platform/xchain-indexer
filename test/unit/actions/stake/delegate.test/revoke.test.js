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
// DELEGATE v2 capability revoke: the delegation-row revoke with and without the
// no-reinsert flag, stake-key mode revocations, and the rejection paths. Part of
// the Delegate suite; see ../delegate.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { VALID_PUBKEY, SOURCE, delegateData, useDelegateHarness } = require('./helpers/delegate_harness.js');

// The harness under test. useDelegateHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, handler;
const bind = (h) => { ({ indexer, actionsCtx, handler } = h); };

describe('Delegate (DELEGATE) @regression @tier2', function () {
    useDelegateHarness(bind);

    // ─── v2: Capability revoke ────────────────────────────────────────

    describe('v2: capability revoke', function () {
        it('valid revoke → STATUS valid, deactivates the parent with no spurious insert (DEL-1, flag on)', async function () {
            const data = delegateData({ FORMAT: 2 });
            await handler.parse(['2', VALID_PUBKEY], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            // DELEGATE_REVOKE_NO_REINSERT (active by default in the mock): the revoke mirrors
            // the v3 path - deactivate the parent only, do NOT insert a fresh delegations row.
            assert.ok(indexer.indexerDb.setDelegationDeactivation.calledOnce);
            assert.ok(indexer.indexerDb.createRevokeDelegation.notCalled);
        });

        it('legacy path (flag off) still inserts a revoke row then caps it', async function () {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().resolves(false);
            const data = delegateData({ FORMAT: 2 });
            await handler.parse(['2', VALID_PUBKEY], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createRevokeDelegation.calledOnce);
            assert.ok(indexer.indexerDb.setDelegationDeactivation.calledOnce);
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
    });
});

describe('Delegate (DELEGATE) @regression @tier2', function () {
    useDelegateHarness(bind);

    describe('v2: capability revoke', function () {
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
    });
});

describe('Delegate (DELEGATE) @regression @tier2', function () {
    useDelegateHarness(bind);

    describe('v2: capability revoke', function () {
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
            assert.ok(indexer.indexerDb.setDelegationDeactivation.calledOnce);   // delegation branch (not stake-key)
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
});
