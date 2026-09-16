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
// The constants, fixtures and mock harness the whole Stake suite runs on. The
// suite is stake.test.js plus the files in stake.test/; each file keeps its own
// names for the indexer, actions context and handler and fills them through
// useStakeHarness, so the test bodies read exactly as they did when the suite
// was one file.

const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../../fixtures/mocks');

const Stake = require('../../../../../../src/actions/stake/index.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE  = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
// Valid 64-char Ed25519 hex public key
const PUBKEY  = 'a'.repeat(64);
const BLOCK   = 100;

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
    return createBaseData(Object.assign({ ACTION: 'STAKE', COIN: 'BTC', BLOCK_INDEX: BLOCK, SOURCE }, overrides));
}

// The suite's hooks, installed in the calling describe: a fresh mock indexer,
// actions context and handler before every test, with the stake reads the
// default mock lacks stubbed, a funded XCHAIN balance and an open SOURCE,
// handed to `bind`; every sinon stub restored after it.
function useStakeHarness(bind) {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Stake(actionsCtx);

        // Stubs not in default mock
        indexer.indexerDb.createStake            = sinon.stub().resolves();
        indexer.indexerDb.getActiveStakeByPubkey = sinon.stub().resolves(null);
        indexer.indexerDb.getDelegationByPubkey  = sinon.stub().resolves(null);  // pubkey not delegated
        indexer.indexerDb.createContractStake    = sinon.stub().resolves();
        indexer.indexerDb.getContractStakeOwner  = sinon.stub().resolves(null);
        indexer.indexerDb.getContract            = sinon.stub().resolves(null);
        indexer.indexerDb.getStatusString        = sinon.stub().resolves('valid');

        // Sufficient XCHAIN balance for staking
        const gasToken = createTokenInfo({ TICK: 'XCHAIN', TICK_ID: 1, DECIMALS: 8 });
        indexer.indexerDb.getTokenInfo.resolves(gasToken);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '10000.00000000' });
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressId.resolves(42);

        indexer.util.resetLists();
        bind({ indexer, actionsCtx, handler });
    });

    afterEach(function () {
        sinon.restore();
    });
}

module.exports = { SOURCE, PUBKEY, BLOCK, makeActionsCtx, makeData, useStakeHarness };
