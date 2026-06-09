'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Unstake = require('../../../src/actions/unstake.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';
const PUBKEY = 'a'.repeat(64);
const BLOCK  = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    return createBaseData(Object.assign({ ACTION: 'UNSTAKE', COIN: 'BTC', BLOCK_INDEX: BLOCK, SOURCE }, overrides));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Unstake handler @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Unstake(actionsCtx);

        // Stubs not in default mock
        indexer.indexerDb.createUnstake                     = sinon.stub().resolves();
        indexer.indexerDb.getActiveStakeByPubkey            = sinon.stub().resolves(null);
        indexer.indexerDb.setStakeDeactivationByPubkey      = sinon.stub().resolves();
        indexer.indexerDb.createContractUnstake             = sinon.stub().resolves();
        indexer.indexerDb.getActiveContractStakeByPubkey    = sinon.stub().resolves(null);
        indexer.indexerDb.setContractStakeDeactivationByPubkey = sinon.stub().resolves();
        indexer.indexerDb.getContract                       = sinon.stub().resolves(null);
        indexer.indexerDb.getAddressId.resolves(42);
        indexer.indexerDb.isActionAllowed.resolves(true);

        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------------
    // FORMAT validation
    // -----------------------------------------------------------------------

    describe('FORMAT validation', function () {

        it('unknown format → invalid', async function () {
            const params = ['99', PUBKEY];
            const data   = makeData({ FORMAT: 99 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('null format → invalid', async function () {
            const params = ['', PUBKEY];
            const data   = makeData({ FORMAT: null });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('pre-existing error is preserved', async function () {
            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, 'invalid: upstream error');

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });

    // -----------------------------------------------------------------------
    // Chain restriction (v0 capability unstake — BTC only)
    // -----------------------------------------------------------------------

    describe('chain restriction', function () {

        it('DOGE chain with v0 → invalid (capability unstake is BTC-only)', async function () {
            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0, COIN: 'DOGE' });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('BTC only'));
        });

        it('LTC chain with v0 → invalid', async function () {
            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0, COIN: 'LTC' });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('BTC only'));
        });
    });

    // -----------------------------------------------------------------------
    // v0 — Capability unstake
    // -----------------------------------------------------------------------

    describe('v0 — capability unstake', function () {

        it('valid v0 unstake → STATUS valid, createUnstake called', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500.00000000' });

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createUnstake.calledOnce);
        });

        it('valid v0 unstake → setStakeDeactivationByPubkey called', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500.00000000' });

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.setStakeDeactivationByPubkey.calledOnce);
        });

        it('valid v0 unstake → mapper.createMappings called', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500.00000000' });

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

        it('valid v0 unstake → AMOUNT set to staked amount', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '750.00000000' });

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.AMOUNT, '750.00000000');
        });

        it('valid v0 unstake → COOLDOWN_END_BLOCK set correctly', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500' });

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            // COOLDOWN_BLOCKS = 1000 in regtest config
            assert.strictEqual(data.COOLDOWN_END_BLOCK, BLOCK + 1000);
        });

        it('no active stake → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null);

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('no active stake'));
        });

        it('stake owned by different source → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 99, amount: '500' });
            indexer.indexerDb.getAddressId.resolves(42); // caller is id=42, not 99

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('does not own this stake'));
        });

        it('source address id null → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500' });
            indexer.indexerDb.getAddressId.resolves(null);

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('does not own this stake'));
        });

        it('createUnstake called even on invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null); // invalid — no stake

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
            assert.ok(indexer.indexerDb.createUnstake.calledOnce);
        });

        it('setStakeDeactivationByPubkey NOT called on invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null);

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(!indexer.indexerDb.setStakeDeactivationByPubkey.called);
        });

        it('SOURCE sleeping → invalid', async function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500' });
            indexer.indexerDb.isActionAllowed.resolves(false);

            const params = ['0', PUBKEY];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('sleeping'));
        });
    });

    // -----------------------------------------------------------------------
    // SIGNING_PUBKEY validations
    // -----------------------------------------------------------------------

    describe('SIGNING_PUBKEY validations', function () {

        it('null pubkey → invalid', async function () {
            const params = ['0', ''];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('SIGNING_PUBKEY'));
        });

        it('too-short pubkey → invalid', async function () {
            const params = ['0', 'abcd'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('SIGNING_PUBKEY'));
        });

        it('non-hex pubkey → invalid', async function () {
            const params = ['0', 'z'.repeat(64)];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('SIGNING_PUBKEY'));
        });
    });

    // -----------------------------------------------------------------------
    // v1 — Contract-targeted unstake
    // -----------------------------------------------------------------------

    describe('v1 — contract-targeted unstake', function () {

        const CONTRACT_INDEX = '5';
        const TICK           = 'TEST';

        function makeContractInfo(overrides = {}) {
            return Object.assign({ source_id: 42, cooldown_blocks: 200 }, overrides);
        }

        beforeEach(function () {
            indexer.indexerDb.getContract.resolves(makeContractInfo());
            indexer.indexerDb.getActiveContractStakeByPubkey.resolves({ source_id: 42, amount: '100' });
        });

        it('valid v1 unstake → STATUS valid, createContractUnstake called', async function () {
            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createContractUnstake.calledOnce);
        });

        it('valid v1 unstake → setContractStakeDeactivationByPubkey called', async function () {
            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.setContractStakeDeactivationByPubkey.calledOnce);
        });

        it('valid v1 unstake → mapper.createMappings called', async function () {
            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

        it('v1 COOLDOWN_END_BLOCK = block + contract cooldown_blocks', async function () {
            indexer.indexerDb.getContract.resolves(makeContractInfo({ cooldown_blocks: 50 }));

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.COOLDOWN_END_BLOCK, BLOCK + 50);
        });

        it('contract not found → invalid', async function () {
            indexer.indexerDb.getContract.resolves(null);

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('unknown'));
        });

        it('contract has no cooldown_blocks → invalid (not stakeable)', async function () {
            indexer.indexerDb.getContract.resolves({ source_id: 42, cooldown_blocks: null });

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('not stakeable'));
        });

        it('no active contract stake for (target, pubkey, tick) → invalid', async function () {
            indexer.indexerDb.getActiveContractStakeByPubkey.resolves(null);

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('no active stake on contract'));
        });

        it('contract stake owned by different source → invalid', async function () {
            indexer.indexerDb.getActiveContractStakeByPubkey.resolves({ source_id: 99, amount: '100' });
            indexer.indexerDb.getAddressId.resolves(42);

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('does not own this stake'));
        });

        it('v1 TARGET_CONTRACT_INDEX missing → invalid', async function () {
            const params = ['1', PUBKEY, '', TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('TARGET_CONTRACT_INDEX'));
        });

        it('v1 TARGET_CONTRACT_INDEX = 0 → invalid', async function () {
            const params = ['1', PUBKEY, '0', TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('TARGET_CONTRACT_INDEX'));
        });

        it('v1 TICK missing → invalid', async function () {
            const params = ['1', PUBKEY, CONTRACT_INDEX, ''];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('TICK'));
        });

        it('v1 source sleeping → invalid', async function () {
            indexer.indexerDb.isActionAllowed.resolves(false);

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('sleeping'));
        });

        it('v1 AMOUNT set from aggregate amount', async function () {
            indexer.indexerDb.getActiveContractStakeByPubkey.resolves({ source_id: 42, amount: '333' });

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.AMOUNT, '333');
        });
    });
});
