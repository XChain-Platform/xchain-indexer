// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Collect = require('../../../src/actions/collect.js');

describe('Collect (COLLECT) @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    const SOURCE = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';

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
});
