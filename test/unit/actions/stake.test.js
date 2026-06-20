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

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Stake = require('../../../src/actions/stake.js');

const SOURCE  = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
// Valid 64-char Ed25519 hex public key
const PUBKEY  = 'a'.repeat(64);
const BLOCK   = 100;

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

function makeData(overrides = {}) {
    return createBaseData(Object.assign({ ACTION: 'STAKE', COIN: 'BTC', BLOCK_INDEX: BLOCK, SOURCE }, overrides));
}

describe('Stake handler @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Stake(actionsCtx);

        // Stubs not in default mock
        indexer.indexerDb.createStake            = sinon.stub().resolves();
        indexer.indexerDb.getActiveStakeByPubkey = sinon.stub().resolves(null);
        indexer.indexerDb.getDelegationByPubkey  = sinon.stub().resolves(null);  // pubkey not delegated
        indexer.indexerDb.createContractStake    = sinon.stub().resolves();
        indexer.indexerDb.getContractStakeOwner  = sinon.stub().resolves(null);
        indexer.indexerDb.getContract            = sinon.stub().resolves(null);
        indexer.indexerDb.getStatusString        = sinon.stub().resolves('valid');

        const gasToken = createTokenInfo({ TICK: 'XCHAIN', TICK_ID: 1, DECIMALS: 8 });
        indexer.indexerDb.getTokenInfo.resolves(gasToken);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '10000.00000000' });
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressId.resolves(42);

        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

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

    describe('SIGNING_PUBKEY validations', function () {

        it('null SIGNING_PUBKEY → invalid', async function () {
            const params = ['1', '100.00000000', ''];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('SIGNING_PUBKEY'));
        });

        it('too-short pubkey → invalid', async function () {
            const params = ['1', '100.00000000', 'abcd1234']; // 8 chars, not 64
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('SIGNING_PUBKEY'));
        });

        it('non-hex pubkey → invalid', async function () {
            const params = ['1', '100.00000000', 'z'.repeat(64)];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('SIGNING_PUBKEY'));
        });

        it('valid 64-char hex pubkey → passes pubkey check', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null);
            const params = ['1', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    describe('SOURCE sleeping', function () {

        it('SOURCE sleeping → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(false);

            const params = ['1', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('sleeping'));
        });
    });

    describe('v2 : top-up existing capability stake', function () {

        it('valid v2 top-up → STATUS valid', async function () {
            // Active stake exists and is owned by SOURCE (source_id=42)
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500' });
            indexer.indexerDb.getAddressId.resolves(42);

            const params = ['2', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 2 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('v2 top-up : no active stake → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null);

            const params = ['2', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 2 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('no active stake to top up'));
        });

        it('v2 top-up : stake owned by different source → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 99, amount: '500' });
            indexer.indexerDb.getAddressId.resolves(42); // current SOURCE id=42, not 99

            const params = ['2', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 2 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('does not own this stake'));
        });

        it('v2 top-up : source address id null → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500' });
            indexer.indexerDb.getAddressId.resolves(null); // source not found

            const params = ['2', '100.00000000', PUBKEY];
            const data   = makeData({ FORMAT: 2 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('does not own this stake'));
        });
    });

    describe('v3 : contract-targeted stake', function () {

        const CONTRACT_INDEX = '5';
        const CONTRACT_TICK  = 'TEST';

        function makeContractToken() {
            return createTokenInfo({ TICK: CONTRACT_TICK, TICK_ID: 2, DECIMALS: 0 });
        }

        function makeContractInfo(overrides = {}) {
            return Object.assign({ source_id: 42, cooldown_blocks: 100 }, overrides);
        }

        beforeEach(function () {
            // Contract exists, is valid, and has cooldown_blocks set
            indexer.indexerDb.getContract.resolves(makeContractInfo());
            indexer.indexerDb.getStatusString.resolves('valid');
            indexer.indexerDb.getTokenInfo.resolves(makeContractToken());
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
