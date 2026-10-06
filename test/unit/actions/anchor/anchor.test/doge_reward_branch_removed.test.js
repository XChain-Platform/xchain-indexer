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
// The DOGE side of ANCHOR never writes a validator reward: the reward is
// derived on the BTC indexer, so even with the derive gate pinned off the
// settlement entry points leave the ledger untouched.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { v0Params, THREE_CHAINS, armAnchor, disarmAnchor } = require('./helpers/anchor_fixtures.js');
const arMod = require('../../../../../src/consensus/gates/anchor_reward_gate.js');
const settle = require('../../../../../src/actions/anchor/settle.js');

describe('ANCHOR DOGE-side reward branch removed @regression @tier3', function () {
    let ctx;
    beforeEach(function () {
        ctx = armAnchor();
        assert.strictEqual(arMod.isAnchorRewardDeriveActive(10, 'regtest'), false);
    });
    afterEach(function () { disarmAnchor(ctx); });

    it('a valid v0 bundle writes no validator reward with the derive gate off', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await ctx.handler.parse(v0Params({ sections: THREE_CHAINS }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(ctx.indexer.indexerDb.createValidatorReward.notCalled);
        assert.ok(ctx.indexer.indexerDb.reconcileAnchorRewardWinner.notCalled);
    });

    it('the settlement entry points never touch the reward ledger with the derive gate off', async function () {
        let db = { createValidatorReward: sinon.stub().resolves(true), reconcileAnchorRewardWinner: sinon.stub().resolves() };
        let handler = { indexerDb: db, config: { NETWORK: 'regtest', COIN: 'DOGE' } };
        let data = { PUBLISHER: 'a'.repeat(64), SNAPSHOT_BLOCK: 10, BLOCK_INDEX: 20, ACTION_INDEX: 0, MATCH_BATCH_SEQ: 1, NETWORK: 'regtest' };
        await settle.creditBundleReward(handler, data, true, { snapPubkeys: new Set([data.PUBLISHER]) });
        await settle.creditArchiveReward(handler, data, true, new Set([data.PUBLISHER]), 1);
        assert.ok(db.createValidatorReward.notCalled);
        assert.ok(db.reconcileAnchorRewardWinner.notCalled);
    });
});
