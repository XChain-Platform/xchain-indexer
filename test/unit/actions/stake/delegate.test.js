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
// DELEGATE action handler, v0 capability rotate: the SIGNING_PUBKEY and stake
// checks, collisions, sleeping sources and the activation delay. The v2 revoke
// and the v1/v3 contract-targeted blocks live beside this file in delegate.test/.
// Every block in every file opens the same 'Delegate (DELEGATE) @regression
// @tier2' describe, so each full test title is the one the suite always had;
// delegate.test/helpers/delegate_harness.js holds the stubs, data builder and
// mock harness they all run on.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { VALID_PUBKEY, SOURCE, delegateData, useDelegateHarness } = require('./delegate.test/helpers/delegate_harness.js');

// The harness under test. useDelegateHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

describe('Delegate (DELEGATE) @regression @tier2', function () {
    useDelegateHarness(bind);

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
    });
});

describe('Delegate (DELEGATE) @regression @tier2', function () {
    useDelegateHarness(bind);

    describe('v0: capability rotate', function () {
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
});
