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

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Unstake = require('../../../src/actions/unstake.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
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
        indexer.indexerDb.createStake                       = sinon.stub().resolves();
        indexer.indexerDb.createContractStake               = sinon.stub().resolves();
        indexer.indexerDb.getTokenInfo                      = sinon.stub().resolves({ TICK_ID: 1, DECIMALS: 8 });

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
    // Chain restriction (v0 capability unstake, BTC only)
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
    // v0 : Capability unstake
    // -----------------------------------------------------------------------

    describe('v0 : capability unstake', function () {

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
            indexer.indexerDb.getActiveStakeByPubkey.resolves(null); // invalid : no stake

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
    // v1 : Contract-targeted unstake
    // -----------------------------------------------------------------------

    describe('v1 : contract-targeted unstake', function () {

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

        // Pkg6 / 048fdea9 + ce6a484f (gated UNSTAKE_CONTRACT_COOLDOWN_STRICT): error-path rows
        // must not carry the phantom BLOCK_INDEX+1000 cooldown from the legacy global fallback.
        it('error-path (unknown target) COOLDOWN_END_BLOCK is 0, not BLOCK+1000, once strict', async function () {
            indexer.indexerDb.getContract.resolves(null);

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('unknown'));
            assert.strictEqual(data.COOLDOWN_END_BLOCK, 0);
        });

        it('error-path COOLDOWN_END_BLOCK stays BLOCK+1000 below the flag-day (replay fidelity)', async function () {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) =>
                name === 'UNSTAKE_CONTRACT_COOLDOWN_STRICT' ? false : true);
            indexer.indexerDb.getContract.resolves(null);

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('unknown'));
            assert.strictEqual(data.COOLDOWN_END_BLOCK, BLOCK + 1000);
        });

        it('rejects a non-integer contract cooldown once strict (latent cross-file trap closed)', async function () {
            indexer.indexerDb.getContract.resolves(makeContractInfo({ cooldown_blocks: 50.5 }));

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('contract cooldown invalid'));
            assert.strictEqual(data.COOLDOWN_END_BLOCK, 0);
        });

        it('valid-path COOLDOWN_END_BLOCK is unchanged by the strict gate', async function () {
            indexer.indexerDb.getContract.resolves(makeContractInfo({ cooldown_blocks: 200 }));

            const params = ['1', PUBKEY, CONTRACT_INDEX, TICK];
            const data   = makeData({ FORMAT: 1 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.strictEqual(data.COOLDOWN_END_BLOCK, BLOCK + 200);
        });
    });

    // -----------------------------------------------------------------------
    // partial unstake (trailing optional AMOUNT, PARTIAL_UNSTAKE_COLLECT)
    // -----------------------------------------------------------------------

    describe('v0: partial unstake', function () {

        function activationDelay() {
            const staking = indexer.config['STAKING'];
            return (staking && staking['ACTIVATION_DELAY_BLOCKS'])
                ? staking['ACTIVATION_DELAY_BLOCKS'] : indexer.config['ACTIVATION_DELAY_BLOCKS'];
        }

        function gateOff() {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) =>
                name === 'PARTIAL_UNSTAKE_COLLECT' ? false : true);
        }

        beforeEach(function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500.00000000' });
        });

        it('partial amount → valid, unstakes AMOUNT is the canonical partial', async function () {
            const data = makeData({ FORMAT: 0 });
            await handler.parse(['0', PUBKEY, '200'], data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.strictEqual(data.AMOUNT, '200.00000000');
            assert.ok(indexer.indexerDb.setStakeDeactivationByPubkey.calledOnce);
        });

        it('partial amount → residual re-staked, activating when the swept rows deactivate', async function () {
            const data = makeData({ FORMAT: 0 });
            await handler.parse(['0', PUBKEY, '200'], data, null);

            assert.ok(indexer.indexerDb.createStake.calledOnce);
            const row = indexer.indexerDb.createStake.firstCall.args[0];
            assert.strictEqual(row.AMOUNT, '300.00000000');
            assert.strictEqual(row.STATUS, 'valid');
            assert.strictEqual(row.VERSION, 2);
            assert.strictEqual(row.SIGNING_PUBKEY, PUBKEY);
            assert.strictEqual(row.ACTION_INDEX, data.ACTION_INDEX);
            assert.strictEqual(row.ACTIVATION_BLOCK, BLOCK + activationDelay());
        });

        it('AMOUNT equal to the full balance is state-identical to the absent form', async function () {
            const data = makeData({ FORMAT: 0 });
            // byte-different wire form ('500' vs the canonical '500.00000000')
            await handler.parse(['0', PUBKEY, '500'], data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.strictEqual(data.AMOUNT, '500.00000000');   // the absent-form value
            assert.ok(!indexer.indexerDb.createStake.called);  // no residual row
        });

        it('over-ask REJECTS (never clamps), nothing deactivates', async function () {
            const data = makeData({ FORMAT: 0 });
            await handler.parse(['0', PUBKEY, '500.00000001'], data, null);

            assert.ok(data.STATUS.includes('exceeds active stake'));
            assert.ok(!indexer.indexerDb.setStakeDeactivationByPubkey.called);
            assert.ok(!indexer.indexerDb.createStake.called);
        });

        it('zero amount → invalid', async function () {
            const data = makeData({ FORMAT: 0 });
            await handler.parse(['0', PUBKEY, '0'], data, null);
            assert.ok(data.STATUS.includes('greater than 0'));
        });

        it('malformed amounts → invalid (explicit-but-empty, non-numeric, >8dp)', async function () {
            for (const bad of ['', 'abc', '1.123456789', '-5', '1e3']) {
                indexer.indexerDb.createUnstake.resetHistory();
                const data = makeData({ FORMAT: 0 });
                await handler.parse(['0', PUBKEY, bad], data, null);
                assert.ok(data.STATUS.includes('AMOUNT'), `expected AMOUNT reject for "${bad}", got ${data.STATUS}`);
            }
        });

        it('below the flag-day a present AMOUNT is IGNORED (legacy full sweep)', async function () {
            gateOff();
            const data = makeData({ FORMAT: 0 });
            await handler.parse(['0', PUBKEY, '200'], data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.strictEqual(data.AMOUNT, '500.00000000');   // full sweep
            assert.ok(!indexer.indexerDb.createStake.called);
        });

        it('below the flag-day even a MALFORMED trailing field is ignored', async function () {
            gateOff();
            const data = makeData({ FORMAT: 0 });
            await handler.parse(['0', PUBKEY, 'garbage'], data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.strictEqual(data.AMOUNT, '500.00000000');
        });
    });

    describe('v1: partial contract unstake', function () {

        const CONTRACT_INDEX = '5';
        const TICK           = 'TEST';

        function activationDelay() {
            const staking = indexer.config['STAKING'];
            return (staking && staking['ACTIVATION_DELAY_BLOCKS'])
                ? staking['ACTIVATION_DELAY_BLOCKS'] : indexer.config['ACTIVATION_DELAY_BLOCKS'];
        }

        beforeEach(function () {
            indexer.indexerDb.getContract.resolves({ source_id: 42, cooldown_blocks: 200 });
            indexer.indexerDb.getActiveContractStakeByPubkey.resolves({ source_id: 42, amount: '100.00000000' });
        });

        it('partial amount → valid, residual re-staked to the same (target, pubkey, tick)', async function () {
            const data = makeData({ FORMAT: 1 });
            await handler.parse(['1', PUBKEY, CONTRACT_INDEX, TICK, '40'], data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.strictEqual(data.AMOUNT, '40.00000000');
            assert.ok(indexer.indexerDb.createContractStake.calledOnce);
            const row = indexer.indexerDb.createContractStake.firstCall.args[0];
            assert.strictEqual(row.AMOUNT, '60.00000000');
            assert.strictEqual(row.TARGET_CONTRACT_INDEX, CONTRACT_INDEX);
            assert.strictEqual(row.TICK, TICK);
            assert.strictEqual(row.VERSION, 3);
            assert.strictEqual(row.ACTIVATION_BLOCK, BLOCK + activationDelay());
        });

        it('amount precision is bounded by the token\'s own decimals', async function () {
            indexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1, DECIMALS: 2 });
            const data = makeData({ FORMAT: 1 });
            await handler.parse(['1', PUBKEY, CONTRACT_INDEX, TICK, '40.123'], data, null);
            assert.ok(data.STATUS.includes('exceeds token decimals'));
        });

        it('over-ask REJECTS and nothing deactivates', async function () {
            const data = makeData({ FORMAT: 1 });
            await handler.parse(['1', PUBKEY, CONTRACT_INDEX, TICK, '100.5'], data, null);

            assert.ok(data.STATUS.includes('exceeds active stake'));
            assert.ok(!indexer.indexerDb.setContractStakeDeactivationByPubkey.called);
            assert.ok(!indexer.indexerDb.createContractStake.called);
        });

        it('AMOUNT equal to the full balance is state-identical to the absent form', async function () {
            const data = makeData({ FORMAT: 1 });
            await handler.parse(['1', PUBKEY, CONTRACT_INDEX, TICK, '100'], data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.strictEqual(data.AMOUNT, '100.00000000');
            assert.ok(!indexer.indexerDb.createContractStake.called);
        });

        it('below the flag-day a present AMOUNT is IGNORED (legacy full sweep)', async function () {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) =>
                name === 'PARTIAL_UNSTAKE_COLLECT' ? false : true);
            const data = makeData({ FORMAT: 1 });
            await handler.parse(['1', PUBKEY, CONTRACT_INDEX, TICK, '40'], data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.strictEqual(data.AMOUNT, '100.00000000');
            assert.ok(!indexer.indexerDb.createContractStake.called);
        });
    });
});
