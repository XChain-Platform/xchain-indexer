// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Collect = require('../../../src/actions/collect.js');

describe('Collect (COLLECT) @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

    function addCollectDbStubs(db) {
        db.getActiveStakeBySource  = sinon.stub().resolves({ stake_index: 1 });
        db.getUnclaimedRewardTotal = sinon.stub().resolves('100');
        db.createRewardClaim       = sinon.stub().resolves();
        // Reward pool is paid by debit, not minting: the guard reads the gas-tick id and the
        // pool's balance. Default to a well-funded pool so the happy path stays valid.
        db.getTokenInfo            = sinon.stub().resolves({ TICK_ID: 1 });
        db.getAddressBalances      = sinon.stub().resolves({ 1: '1000000' });
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        addCollectDbStubs(indexer.indexerDb);
        indexer.indexerDb.isActionAllowed.resolves(true);

        actionsCtx = {
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
        };
        handler = new Collect(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    function collectData(overrides = {}) {
        return createBaseData({ ACTION: 'COLLECT', FORMAT: 0, COIN: 'BTC', SOURCE, ...overrides });
    }

    it('valid collect → STATUS valid, reward recorded as AMOUNT', async function () {
        const data = collectData();
        await handler.parse(['0'], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(data['AMOUNT'], '100');
        assert.ok(indexer.indexerDb.createRewardClaim.calledOnce);
    });

    it('rejects an unknown VERSION', async function () {
        const data = collectData({ FORMAT: 5 });
        await handler.parse(['5'], data, null);
        assert.ok(String(data['STATUS']).includes('VERSION'));
    });

    it('rejects a non-BTC chain (COLLECT is BTC-only)', async function () {
        const data = collectData({ COIN: 'LTC' });
        await handler.parse(['0'], data, null);
        assert.ok(String(data['STATUS']).includes('BTC only'));
    });

    it('rejects when SOURCE has no active stake', async function () {
        indexer.indexerDb.getActiveStakeBySource.resolves(null);
        const data = collectData();
        await handler.parse(['0'], data, null);
        assert.ok(String(data['STATUS']).includes('no active stake'));
    });

    it('rejects when SOURCE is sleeping', async function () {
        indexer.indexerDb.isActionAllowed.resolves(false);
        const data = collectData();
        await handler.parse(['0'], data, null);
        assert.ok(String(data['STATUS']).includes('sleeping'));
    });

    it('rejects when there are no unclaimed rewards', async function () {
        indexer.indexerDb.getUnclaimedRewardTotal.resolves('0');
        const data = collectData();
        await handler.parse(['0'], data, null);
        assert.ok(String(data['STATUS']).includes('no unclaimed rewards'));
    });

    it('scopes the unclaimed-reward sum to the COLLECT\'s own block (replay determinism)', async function () {
        const data = collectData();
        await handler.parse(['0'], data, null);
        const call = indexer.indexerDb.getUnclaimedRewardTotal.getCall(0);
        // Without the block scope, rewards bulk-restored by ANCHOR recovery
        // would become visible to EARLIER COLLECTs than they were live,
        // flipping historical invalid claims to valid on reindex (CONSENSUS).
        assert.strictEqual(call.args[1], data['BLOCK_INDEX']);
    });

    it('records a reward_claims row even on an invalid collect', async function () {
        const data = collectData({ COIN: 'LTC' });
        await handler.parse(['0'], data, null);
        assert.ok(indexer.indexerDb.createRewardClaim.calledOnce);
    });

    it('valid collect debits the reward pool and credits the validator (no mint)', async function () {
        const data = collectData();
        await handler.parse(['0'], data, null);
        assert.strictEqual(data['STATUS'], 'valid');

        const gas        = indexer.config['GAS'];
        const rewardPool = indexer.config['ADDRESS']['REWARD'];

        // Pool is debited for the reward amount...
        assert.ok(indexer.indexerDb.createDebit.calledOnce, 'expected exactly one debit');
        const [, debitTick, debitAmt, debitAddr] = indexer.indexerDb.createDebit.firstCall.args;
        assert.strictEqual(debitTick, gas);
        assert.strictEqual(debitAmt, '100');
        assert.strictEqual(debitAddr, rewardPool);

        // ...and the validator is credited the same amount (net supply change = 0)
        assert.ok(indexer.indexerDb.createCredit.calledOnce, 'expected exactly one credit');
        const [, creditTick, creditAmt, creditAddr] = indexer.indexerDb.createCredit.firstCall.args;
        assert.strictEqual(creditTick, gas);
        assert.strictEqual(creditAmt, '100');
        assert.strictEqual(creditAddr, SOURCE);
    });

    it('rejects when the reward pool cannot cover the claim, leaving it unclaimed', async function () {
        // Pool holds less than the 100 owed
        indexer.indexerDb.getAddressBalances.resolves({ 1: '50' });
        const data = collectData();
        await handler.parse(['0'], data, null);

        assert.ok(String(data['STATUS']).includes('insufficient reward pool'));
        // Claim row is still recorded (with the invalid status) so it stays auditable...
        assert.ok(indexer.indexerDb.createRewardClaim.calledOnce);
        // ...but nothing moves on the ledger, so the reward remains claimable later.
        assert.ok(indexer.indexerDb.createDebit.notCalled);
        assert.ok(indexer.indexerDb.createCredit.notCalled);
    });

    it('lets the validator retry successfully after the pool is topped up', async function () {
        // First COLLECT: pool underfunded → rejected
        indexer.indexerDb.getAddressBalances = sinon.stub();
        indexer.indexerDb.getAddressBalances.onFirstCall().resolves({ 1: '50' });
        indexer.indexerDb.getAddressBalances.onSecondCall().resolves({ 1: '1000000' });

        const first = collectData();
        await handler.parse(['0'], first, null);
        assert.ok(String(first['STATUS']).includes('insufficient reward pool'));

        // After a top-up, the same unclaimed reward can be collected
        const second = collectData();
        await handler.parse(['0'], second, null);
        assert.strictEqual(second['STATUS'], 'valid');
        assert.strictEqual(second['AMOUNT'], '100');
    });

    // -----------------------------------------------------------------------
    // partial claim (trailing optional AMOUNT, PARTIAL_UNSTAKE_COLLECT)
    // -----------------------------------------------------------------------

    describe('partial claim', function () {

        function setGate(enabled) {
            actionsCtx.protocolChanges = {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().callsFake(async (name) =>
                    name === 'PARTIAL_UNSTAKE_COLLECT' ? enabled : true),
            };
        }

        beforeEach(function () {
            setGate(true);
        });

        it('partial amount → valid, claims only the canonical partial', async function () {
            const data = collectData();
            await handler.parse(['0', '40'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['AMOUNT'], '40.00000000');
            assert.strictEqual(indexer.indexerDb.createDebit.firstCall.args[2], '40.00000000');
            assert.strictEqual(indexer.indexerDb.createCredit.firstCall.args[2], '40.00000000');
        });

        it('remainder stays pending: partial claim then full claim of the rest', async function () {
            const first = collectData();
            await handler.parse(['0', '40'], first, null);
            assert.strictEqual(first['STATUS'], 'valid');

            // The mock returns the shrunken unclaimed total the real query would produce
            indexer.indexerDb.getUnclaimedRewardTotal.resolves('60.00000000');
            const second = collectData();
            await handler.parse(['0'], second, null);
            assert.strictEqual(second['STATUS'], 'valid');
            assert.strictEqual(second['AMOUNT'], '60.00000000');
        });

        it('AMOUNT equal to the full unclaimed total is state-identical to the absent form', async function () {
            const data = collectData();
            // byte-different wire form ('100.0' vs the mock's '100')
            await handler.parse(['0', '100.0'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['AMOUNT'], '100');   // the absent-form value, untouched
        });

        it('over-ask REJECTS (never clamps) and nothing moves', async function () {
            const data = collectData();
            await handler.parse(['0', '100.00000001'], data, null);

            assert.ok(String(data['STATUS']).includes('exceeds unclaimed rewards'));
            assert.ok(indexer.indexerDb.createDebit.notCalled);
            assert.ok(indexer.indexerDb.createCredit.notCalled);
        });

        it('zero and malformed amounts → invalid', async function () {
            for (const bad of ['0', '', 'abc', '1.123456789']) {
                const data = collectData();
                await handler.parse(['0', bad], data, null);
                assert.ok(String(data['STATUS']).includes('AMOUNT') || String(data['STATUS']).includes('greater than 0'),
                    `expected reject for "${bad}", got ${data['STATUS']}`);
            }
        });

        it('partial claim still respects the reward-pool coverage check', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '30' });
            const data = collectData();
            await handler.parse(['0', '40'], data, null);
            assert.ok(String(data['STATUS']).includes('insufficient reward pool'));
        });

        it('below the flag-day a present AMOUNT is IGNORED (legacy full claim)', async function () {
            setGate(false);
            const data = collectData();
            await handler.parse(['0', '40'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['AMOUNT'], '100');
        });

        it('below the flag-day even a MALFORMED trailing field is ignored', async function () {
            setGate(false);
            const data = collectData();
            await handler.parse(['0', 'garbage'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['AMOUNT'], '100');
        });
    });
});
