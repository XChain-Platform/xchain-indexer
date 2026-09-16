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
// The mock AIRDROP handler the AIRDROP suite shares (airdrop.test.js plus the
// files in airdrop.test/). Every block's beforeEach calls freshAirdrop; the
// per-behaviour fixtures stay in the file that uses them.

const sinon = require('sinon');
const { createMockIndexer } = require('../../../../../fixtures/mocks');
const Airdrop = require('../../../../../../src/actions/airdrop/index.js');

// A fresh mock indexer, action context and AIRDROP handler, rebuilt before
// every case.
function freshAirdrop() {
    let indexer, actionsCtx, handler;
    indexer = createMockIndexer();
    actionsCtx = {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction:   sinon.stub().resolves(),
    };
    handler = new Airdrop(actionsCtx);
    // Reset utility lists before each test
    indexer.util.resetLists();
    return { indexer, actionsCtx, handler };
}

module.exports = { freshAirdrop };
