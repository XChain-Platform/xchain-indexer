'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const sinon = require('sinon');

const { createBaseData, createMockIndexer } = require('../../fixtures/mocks.js');
const Anchor = require('../../../src/actions/anchor/index.js');
const ed25519 = require('../../../src/consensus/ed25519.js');
const swq = require('../../../src/consensus/stake_weighted_quorum.js');
const ar = require('../../../src/consensus/gates/anchor_reward_gate.js');
const { stubActiveAt } = require('../../helpers/gate_modules.js');
const ProtocolChanges = require('../../../src/protocol_changes.js');
const { v3Params } = require('../actions/anchor/anchor.test/helpers/anchor_v3_fixtures.js');

const FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';
const EMPTY_FOLD_GATE = 'anchor_empty_fold_reject_activation.ANCHOR_EMPTY_FOLD_REJECT_ACTIVATION';
const EMPTY_FOLD_WIRE = '3|NET|100|0|0|pub|1|pub|sig';
const PUBKEY = 'a'.repeat(64);
const SIGNATURE = 'b'.repeat(128);

function emptyFoldParams(){
    return EMPTY_FOLD_WIRE.replace('NET', 'regtest')
        .replaceAll('pub', PUBKEY).replace('sig', SIGNATURE).split('|');
}

function fixture(rejectEmptyFold){
    const indexer = createMockIndexer();
    indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'regtest' });
    indexer.indexerDb.createAnchorAction = sinon.stub().resolves();
    stubActiveAt(sinon, FOLD_GATE, true);
    const activeAt = stubActiveAt(sinon, EMPTY_FOLD_GATE, rejectEmptyFold);
    return { indexer, handler: new Anchor(indexer), activeAt };
}

function unsignedFixture(){
    const indexer = createMockIndexer();
    indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'regtest' });
    const db = indexer.indexerDb;
    db.getValidatorsByCapability = sinon.stub().resolves([{ pubkey: PUBKEY, amount: '1' }]);
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
    stubActiveAt(sinon, FOLD_GATE, true);
    stubActiveAt(sinon, EMPTY_FOLD_GATE, false);
    return { indexer, handler: new Anchor(indexer) };
}

describe('ANCHOR v3 empty fold rejection', function(){
    afterEach(function(){
        sinon.restore();
    });

    it('ships the reject gate inert on live networks and active on regtest', function(){
        assert.deepStrictEqual(ProtocolChanges.get(EMPTY_FOLD_GATE), {
            mainnet: 9999999999,
            'BTC:testnet': 9999999999,
            'LTC:testnet': 9999999999,
            'DOGE:testnet': 9999999999,
            testnet: 9999999999,
            regtest: 0,
        });
        assert.strictEqual(ProtocolChanges.activeAt(
            EMPTY_FOLD_GATE, 'testnet', 'DOGE', 9999999998, null), false);
        assert.strictEqual(ProtocolChanges.activeAt(
            EMPTY_FOLD_GATE, 'regtest', 'DOGE', 0, null), true);
    });

    it("preserves today's pre-gate behaviour by accepting the unsigned empty fold", async function(){
        const { indexer, handler } = unsignedFixture();
        const params = v3Params({ sections: [], archive: false });
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(indexer.indexerDb.createAnchorAction.callCount, 1);
    });

    it('preserves the historical empty-fold verdict below activation', async function(){
        const { indexer, handler } = fixture(false);
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });

        await handler.parse(emptyFoldParams(), data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(indexer.indexerDb.createAnchorAction.firstCall.args[0].STATUS, 'valid');
    });

    it('rejects an empty fold at activation using the ANCHOR mined height', async function(){
        const { indexer, handler, activeAt } = fixture(true);
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });

        await handler.parse(emptyFoldParams(), data, null);

        assert.strictEqual(data.STATUS, 'invalid: SECTION_COUNT (empty fold)');
        assert.ok(activeAt.calledWith(EMPTY_FOLD_GATE, 'regtest', 'DOGE', 100, null));
        assert.strictEqual(indexer.indexerDb.createAnchorAction.firstCall.args[0].STATUS,
            'invalid: SECTION_COUNT (empty fold)');
    });
});
