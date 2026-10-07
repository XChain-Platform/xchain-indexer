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
// A handler without a legacy credit path never writes a validator reward: the
// reward is derived on the BTC indexer, so even with the derive gate pinned off the
// settlement entry points leave the ledger untouched.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const arMod = require('../../../../../src/consensus/gates/anchor_reward_gate.js');
const settle = require('../../../../../src/actions/anchor/settle.js');
const observability = require('../../../../../src/observability/index.js');

const BUNDLE_SKIP_WARNING = '\t ANCHOR v0 : no legacy reward path applies; reward skipped';
const ARCHIVE_SKIP_WARNING = '\t ANCHOR v1 : no legacy reward path applies; reward skipped';

describe('ANCHOR DOGE-side reward branch removed @regression @tier3', function () {
    beforeEach(function () {
        sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(false);
        assert.strictEqual(arMod.isAnchorRewardDeriveActive(10, 'regtest'), false);
    });
    afterEach(function () { sinon.restore(); });

    it('the settlement entry points never touch the reward ledger with the derive gate off', async function () {
        let db = { createValidatorReward: sinon.stub().resolves(true), reconcileAnchorRewardWinner: sinon.stub().resolves() };
        let handler = { indexerDb: db, config: { NETWORK: 'regtest', COIN: 'DOGE' } };
        let data = { PUBLISHER: 'a'.repeat(64), SNAPSHOT_BLOCK: 10, BLOCK_INDEX: 20, ACTION_INDEX: 0, MATCH_BATCH_SEQ: 1, NETWORK: 'regtest' };
        let warn = sinon.stub(observability.getLogger(), 'warn');
        await settle.creditBundleReward(handler, data, true, { snapPubkeys: new Set([data.PUBLISHER]) });
        await settle.creditArchiveReward(handler, data, true, new Set([data.PUBLISHER]), 1);
        assert.ok(db.createValidatorReward.notCalled);
        assert.ok(db.reconcileAnchorRewardWinner.notCalled);
        assert.strictEqual(arMod.isAnchorRewardDeriveActive.callCount, 3);
        assert.deepStrictEqual(warn.args, [[BUNDLE_SKIP_WARNING], [ARCHIVE_SKIP_WARNING]]);
    });
});
