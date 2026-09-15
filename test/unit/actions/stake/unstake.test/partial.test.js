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
// UNSTAKE with a trailing AMOUNT (PARTIAL_UNSTAKE_COLLECT), v0 and v1: the
// residual re-stake, full-balance equivalence, over-ask rejection, malformed
// amounts and the flag-day fallback to a full sweep.
// Part of the UNSTAKE suite; see ../unstake.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { PUBKEY, BLOCK, makeData, makeUnstakeContext } = require('./helpers/unstake_context.js');

let indexer, actionsCtx, handler;

// Each test starts from its own mock indexer and UNSTAKE handler.
function freshUnstake() {
    ({ indexer, actionsCtx, handler } = makeUnstakeContext());
}

const CONTRACT_INDEX = '5';
const TICK           = 'TEST';

// -----------------------------------------------------------------------
// partial unstake (trailing optional AMOUNT, PARTIAL_UNSTAKE_COLLECT)
// -----------------------------------------------------------------------

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v0: partial unstake', function () {
        function activationDelay() {
            const staking = indexer.config['STAKING'];
            return (staking && staking['ACTIVATION_DELAY_BLOCKS'])
                ? staking['ACTIVATION_DELAY_BLOCKS'] : indexer.config['ACTIVATION_DELAY_BLOCKS'];
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
    });
});

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v0: partial unstake', function () {
        beforeEach(function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500.00000000' });
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
    });
});

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v0: partial unstake', function () {
        function gateOff() {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) =>
                name === 'PARTIAL_UNSTAKE_COLLECT' ? false : true);
        }

        beforeEach(function () {
            indexer.indexerDb.getActiveStakeByPubkey.resolves({ source_id: 42, amount: '500.00000000' });
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
});

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v1: partial contract unstake', function () {
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
    });
});

describe('Unstake handler @regression @tier2', function () {
    beforeEach(freshUnstake);
    afterEach(() => sinon.restore());

    describe('v1: partial contract unstake', function () {
        beforeEach(function () {
            indexer.indexerDb.getContract.resolves({ source_id: 42, cooldown_blocks: 200 });
            indexer.indexerDb.getActiveContractStakeByPubkey.resolves({ source_id: 42, amount: '100.00000000' });
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
