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
// Stake handler: the v3 contract-targeted stake, from the contract, token and
// index checks through ownership, balance, the guard fee and ACTIVATION_BLOCK.
// Part of the Stake suite; see ../stake.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createTokenInfo } = require('../../../fixtures/mocks');

const { PUBKEY, BLOCK, makeData, useStakeHarness } = require('./helpers/stake_harness.js');

// Each test gets a fresh harness from useStakeHarness; bind() hands it to the
// names the test bodies use.
let indexer, actionsCtx, handler;
const bind = (h) => { ({ indexer, actionsCtx, handler } = h); };

const CONTRACT_INDEX = '5';
const CONTRACT_TICK  = 'TEST';

function makeContractToken() {
    return createTokenInfo({ TICK: CONTRACT_TICK, TICK_ID: 2, DECIMALS: 0 });
}

function makeContractInfo(overrides = {}) {
    return Object.assign({ source_id: 42, cooldown_blocks: 100 }, overrides);
}

// -----------------------------------------------------------------------
// v3 : Contract-targeted stake
// -----------------------------------------------------------------------
describe('Stake handler @regression @tier2', function () {
    useStakeHarness(bind);

    describe('v3 : contract-targeted stake', function () {
        beforeEach(function () {
            // Contract exists, is valid, and has cooldown_blocks set
            indexer.indexerDb.getContract.resolves(makeContractInfo());
            indexer.indexerDb.getStatusString.resolves('valid');
            // Token for the stake
            indexer.indexerDb.getTokenInfo.resolves(makeContractToken());
            // Sufficient balance
            indexer.indexerDb.getAddressBalances.resolves({ 2: '1000' });
            // No existing stake for this (target, pubkey, tick)
            indexer.indexerDb.getContractStakeOwner.resolves(null);
        });

        it('valid v3 contract stake → STATUS valid, createContractStake called', async function () {
            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createContractStake.calledOnce);
        });

        it('STAKE-1: rejects a leading-zero TARGET_CONTRACT_INDEX at/after the flag-day', async function () {
            const params = ['3', '100', PUBKEY, '005', CONTRACT_TICK];   // non-canonical index, flag on by default
            const data   = makeData({ FORMAT: 3 });
            await handler.parse(params, data, null);
            assert.ok(String(data.STATUS).includes('TARGET_CONTRACT_INDEX (format)'));
        });

        it('STAKE-1: accepts a leading-zero index below the flag-day (legacy /^[0-9]+$/)', async function () {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().resolves(false);
            const params = ['3', '100', PUBKEY, '005', CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });
            await handler.parse(params, data, null);
            assert.strictEqual(data.STATUS, 'valid');   // '005' -> contract 5, valid pre-flag-day
        });

        it('STAKE-2: rejects when staking GAS and AMOUNT+guardFee exceeds the GAS balance', async function () {
            const GAS = actionsCtx.config['GAS'];
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: GAS, TICK_ID: 1, DECIMALS: 8 }));
            indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });        // exactly AMOUNT, no room for the fee
            indexer.util.maybeRunControllerGuard = sinon.stub().resolves({ guardFee: '5' });
            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, GAS];
            const data   = makeData({ FORMAT: 3 });
            await handler.parse(params, data, null);
            assert.ok(String(data.STATUS).includes('STAKE + guard fee'));
        });
    });
});

describe('Stake handler @regression @tier2', function () {
    useStakeHarness(bind);

    describe('v3 : contract-targeted stake', function () {
        beforeEach(function () {
            // Contract exists, is valid, and has cooldown_blocks set
            indexer.indexerDb.getContract.resolves(makeContractInfo());
            indexer.indexerDb.getStatusString.resolves('valid');
            // Token for the stake
            indexer.indexerDb.getTokenInfo.resolves(makeContractToken());
            // Sufficient balance
            indexer.indexerDb.getAddressBalances.resolves({ 2: '1000' });
            // No existing stake for this (target, pubkey, tick)
            indexer.indexerDb.getContractStakeOwner.resolves(null);
        });

        it('STAKE-2: allows the combined debit when the GAS balance covers AMOUNT+guardFee', async function () {
            const GAS = actionsCtx.config['GAS'];
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: GAS, TICK_ID: 1, DECIMALS: 8 }));
            indexer.indexerDb.getAddressBalances.resolves({ 1: '105' });        // covers 100 + 5
            indexer.util.maybeRunControllerGuard = sinon.stub().resolves({ guardFee: '5' });
            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, GAS];
            const data   = makeData({ FORMAT: 3 });
            await handler.parse(params, data, null);
            assert.strictEqual(data.STATUS, 'valid');
        });

        it('v3 → mapper.createMappings called', async function () {
            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

        it('v3 → updateBalances called', async function () {
            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
        });

        it('v3 contract not found → invalid', async function () {
            indexer.indexerDb.getContract.resolves(null);

            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('unknown'));
        });
    });
});

describe('Stake handler @regression @tier2', function () {
    useStakeHarness(bind);

    describe('v3 : contract-targeted stake', function () {
        beforeEach(function () {
            // Contract exists, is valid, and has cooldown_blocks set
            indexer.indexerDb.getContract.resolves(makeContractInfo());
            indexer.indexerDb.getStatusString.resolves('valid');
            // Token for the stake
            indexer.indexerDb.getTokenInfo.resolves(makeContractToken());
            // Sufficient balance
            indexer.indexerDb.getAddressBalances.resolves({ 2: '1000' });
            // No existing stake for this (target, pubkey, tick)
            indexer.indexerDb.getContractStakeOwner.resolves(null);
        });

        it('v3 contract status not valid → invalid', async function () {
            indexer.indexerDb.getStatusString.resolves('invalid');

            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('contract not active'));
        });

        it('v3 contract has no cooldown_blocks → invalid (not stakeable)', async function () {
            indexer.indexerDb.getContract.resolves({ source_id: 42, cooldown_blocks: null });

            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('not stakeable'));
        });

        it('v3 TICK not found → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);

            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('TICK'));
        });

        it('v3 amount missing → invalid', async function () {
            const params = ['3', '', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('AMOUNT'));
        });
    });
});

describe('Stake handler @regression @tier2', function () {
    useStakeHarness(bind);

    describe('v3 : contract-targeted stake', function () {
        beforeEach(function () {
            // Contract exists, is valid, and has cooldown_blocks set
            indexer.indexerDb.getContract.resolves(makeContractInfo());
            indexer.indexerDb.getStatusString.resolves('valid');
            // Token for the stake
            indexer.indexerDb.getTokenInfo.resolves(makeContractToken());
            // Sufficient balance
            indexer.indexerDb.getAddressBalances.resolves({ 2: '1000' });
            // No existing stake for this (target, pubkey, tick)
            indexer.indexerDb.getContractStakeOwner.resolves(null);
        });

        it('v3 TARGET_CONTRACT_INDEX missing → invalid', async function () {
            const params = ['3', '100', PUBKEY, '', CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('TARGET_CONTRACT_INDEX'));
        });

        it('v3 TARGET_CONTRACT_INDEX = 0 → invalid', async function () {
            const params = ['3', '100', PUBKEY, '0', CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('TARGET_CONTRACT_INDEX'));
        });

        it('v3 TICK missing → invalid', async function () {
            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, ''];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('TICK'));
        });

        it('v3 pubkey already staked by different source → invalid', async function () {
            indexer.indexerDb.getContractStakeOwner.resolves(99); // owned by address_id=99
            indexer.indexerDb.getAddressId.resolves(42);           // source is address_id=42

            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('already staked'));
        });
    });
});

describe('Stake handler @regression @tier2', function () {
    useStakeHarness(bind);

    describe('v3 : contract-targeted stake', function () {
        beforeEach(function () {
            // Contract exists, is valid, and has cooldown_blocks set
            indexer.indexerDb.getContract.resolves(makeContractInfo());
            indexer.indexerDb.getStatusString.resolves('valid');
            // Token for the stake
            indexer.indexerDb.getTokenInfo.resolves(makeContractToken());
            // Sufficient balance
            indexer.indexerDb.getAddressBalances.resolves({ 2: '1000' });
            // No existing stake for this (target, pubkey, tick)
            indexer.indexerDb.getContractStakeOwner.resolves(null);
        });

        it('v3 same source top-up → valid (owner matches)', async function () {
            indexer.indexerDb.getContractStakeOwner.resolves(42); // already staked by same source
            indexer.indexerDb.getAddressId.resolves(42);

            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('v3 insufficient balance → invalid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 2: '5' }); // only 5, want 100

            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('insufficient funds'));
        });

        it('v3 amount exceeds token decimals → invalid', async function () {
            // Token with 0 decimals : fractional amount is invalid
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: CONTRACT_TICK, TICK_ID: 2, DECIMALS: 0 }));
            indexer.indexerDb.getAddressBalances.resolves({ 2: '1000' });

            const params = ['3', '100.1', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('exceeds token decimals'));
        });
    });
});

describe('Stake handler @regression @tier2', function () {
    useStakeHarness(bind);

    describe('v3 : contract-targeted stake', function () {
        beforeEach(function () {
            // Contract exists, is valid, and has cooldown_blocks set
            indexer.indexerDb.getContract.resolves(makeContractInfo());
            indexer.indexerDb.getStatusString.resolves('valid');
            // Token for the stake
            indexer.indexerDb.getTokenInfo.resolves(makeContractToken());
            // Sufficient balance
            indexer.indexerDb.getAddressBalances.resolves({ 2: '1000' });
            // No existing stake for this (target, pubkey, tick)
            indexer.indexerDb.getContractStakeOwner.resolves(null);
        });

        it('v3 source sleeping → invalid', async function () {
            indexer.indexerDb.isActionAllowed.resolves(false);

            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('sleeping'));
        });

        it('v3 ACTIVATION_BLOCK set correctly', async function () {
            const params = ['3', '100', PUBKEY, CONTRACT_INDEX, CONTRACT_TICK];
            const data   = makeData({ FORMAT: 3 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.ACTIVATION_BLOCK, BLOCK + 6); // ACTIVATION_DELAY_BLOCKS=6
        });
    });
});
