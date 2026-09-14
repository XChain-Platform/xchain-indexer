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
// The constants, row builders and per-test context the UNSTAKE suite shares
// (unstake.test.js plus the files in unstake.test/). makeUnstakeContext builds
// a fresh mock indexer, actions context and handler with the stake stubs the
// default mock lacks; each block calls it from its own beforeEach.

const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../../../fixtures/mocks');

const Unstake = require('../../../../../src/actions/unstake.js');

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

/** A fresh mock indexer, actions context and UNSTAKE handler, as every unstake test starts from. */
function makeUnstakeContext() {
    const indexer    = createMockIndexer();
    const actionsCtx = makeActionsCtx(indexer);
    const handler    = new Unstake(actionsCtx);

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
    return { indexer, actionsCtx, handler };
}

module.exports = { SOURCE, PUBKEY, BLOCK, makeActionsCtx, makeData, makeUnstakeContext };
