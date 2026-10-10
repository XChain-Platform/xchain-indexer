// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const { createBaseData, createMockIndexer } = require('../../fixtures/mocks.js');
const Anchor = require('../../../src/actions/anchor/index.js');
const gateRegistry = require('../../../src/consensus/gate_registry');
const ed25519 = require('../../../src/consensus/ed25519.js');
const swq = require('../../../src/consensus/stake_weighted_quorum.js');
const ar = require('../../../src/consensus/gates/anchor_reward_gate.js');
const { v3Params } = require('../actions/anchor/anchor.test/helpers/anchor_v3_fixtures.js');

const FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';
const PUBKEY_A = 'a'.repeat(64);

function fixture(){
    let indexer = createMockIndexer();
    indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'regtest' });
    let db = indexer.indexerDb;
    db.getValidatorsByCapability = sinon.stub().resolves([{ pubkey: PUBKEY_A, amount: '1' }]);
    db.getMaxAnchorCheckpointSeq = sinon.stub().resolves(null);
    db.getArchiveReplayWatermarks = sinon.stub().resolves({ batchSeq: null, checkpointSeq: null });
    db.createAnchorAction = sinon.stub().resolves();
    db.getAnchorV1ByBatchSeq = sinon.stub().resolves(null);
    db.getAnchorChunks = sinon.stub().resolves([]);
    db.createValidatorReward = sinon.stub().resolves(true);
    db.reconcileAnchorRewardWinner = sinon.stub().resolves(1);
    sinon.stub(ed25519, 'verify').returns(false);
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    sinon.stub(ar, 'isAnchorRewardDeriveActive').returns(false);
    sinon.stub(gateRegistry, 'activeAt').callThrough()
        .withArgs(FOLD_GATE).returns(true);
    return { indexer, handler: new Anchor(indexer) };
}

describe('ANCHOR v3 empty fold rejection', function(){
    afterEach(function(){
        sinon.restore();
    });

    it("preserves today's pre-gate behaviour by accepting the unsigned empty fold", async function(){
        const { indexer, handler } = fixture();
        const params = v3Params({ sections: [], archive: false });
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(indexer.indexerDb.createAnchorAction.callCount, 1);
    });
});
