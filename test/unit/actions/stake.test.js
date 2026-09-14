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
//
// Stake handler: FORMAT, the BTC-only chain restriction, v1 capability stake
// creation and AMOUNT validation. The signing key, sleeping and v2 top-up
// cases and the v3 contract-targeted stake live beside it in stake.test/, each
// opening the same 'Stake handler @regression @tier2' describe so every full
// test title is unchanged; stake.test/helpers/stake_harness.js holds the
// constants and the mock harness they share.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { PUBKEY, BLOCK, makeData, useStakeHarness } = require('./stake.test/helpers/stake_harness.js');

// Each test gets a fresh harness from useStakeHarness; bind() hands it to the
// names the test bodies use.
let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

// -----------------------------------------------------------------------
// FORMAT validation
// -----------------------------------------------------------------------
describe('Stake handler @regression @tier2', function () {
    useStakeHarness(bind);

    describe('FORMAT validation', function () {

        it('unknown format → invalid', async function () {
            const params = ['99', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 99 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('null format → invalid', async function () {
            const params = ['', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: null });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('pre-existing error is preserved', async function () {
            const params = ['1', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, 'invalid: pre-existing');

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

// -----------------------------------------------------------------------
// Chain restriction
// -----------------------------------------------------------------------
describe('Stake handler @regression @tier2', function () {
    useStakeHarness(bind);

    describe('chain restriction', function () {

        it('DOGE chain → invalid (capability stake is BTC-only)', async function () {
            const params = ['1', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 1, COIN: 'DOGE' });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('BTC only'));
        });

        it('LTC chain → invalid', async function () {
            const params = ['1', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 1, COIN: 'LTC' });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('BTC only'));
        });
    });
});

// -----------------------------------------------------------------------
// v1: Create new capability stake
// -----------------------------------------------------------------------
describe('Stake handler @regression @tier2', function () {
    useStakeHarness(bind);

    describe('v1: create new capability stake', function () {
        it('valid v1 stake → STATUS valid, createStake called', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null); // no existing stake
            const params = ['1', '500.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createStake.calledOnce);
        });

        it('valid v1 stake → updateBalances called', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null);
            const params = ['1', '500.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
        });

        it('valid v1 stake → mapper.createMappings called', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null);
            const params = ['1', '500.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

        it('v1 stake → ACTIVATION_BLOCK = BLOCK_INDEX + activation_delay', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null);
            const params = ['1', '500.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            // STAKING.ACTIVATION_DELAY_BLOCKS = 6 in regtest config
            assert.strictEqual(data.ACTIVATION_BLOCK, BLOCK + 6);
        });

        it('pubkey already has active stake → invalid for v1', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '100' });

            const params = ['1', '500.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('already in use'));
        });
    });
});

describe('Stake handler @regression @tier2', function () {
    useStakeHarness(bind);

    describe('v1: create new capability stake', function () {
        it('pubkey held by an active delegation → invalid for v1 (mirrors the DELEGATE collision rule)', async function () {
            indexer.indexerDb.getDelegationByPubkey.resolves({ action_index: 7 });

            const params = ['1', '500.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('already delegated'));
            // Height-gated: a revoked delegation frees the pubkey
            const call = indexer.indexerDb.getDelegationByPubkey.getCall(0);
            assert.strictEqual(call.args[1], data['BLOCK_INDEX']);
        });

        it('createStake is always called even on invalid', async function () {
            // pubkey already in use
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 99, amount: '100' });

            const params = ['1', '500.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
            assert.ok(indexer.indexerDb.createStake.calledOnce);
        });
    });
});

// -----------------------------------------------------------------------
// AMOUNT validations
// -----------------------------------------------------------------------
describe('Stake handler @regression @tier2', function () {
    useStakeHarness(bind);

    describe('AMOUNT validations', function () {

        it('null AMOUNT → invalid', async function () {
            const params = ['1', '', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('AMOUNT'));
        });

        it('zero AMOUNT → invalid', async function () {
            const params = ['1', '0', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('AMOUNT'));
        });

        it('negative AMOUNT → invalid', async function () {
            const params = ['1', '-1', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('AMOUNT'));
        });

        it('non-numeric AMOUNT → invalid', async function () {
            const params = ['1', 'abc', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('AMOUNT'));
        });

        it('insufficient balance → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '10.00000000' }); // only 10

            const params = ['1', '500.00000000', PUBKEY]; // want 500
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('insufficient funds'));
        });
    });
});
