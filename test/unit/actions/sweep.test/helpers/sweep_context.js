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
// The addresses and per-test context the SWEEP suite shares (sweep.test.js
// plus the files in sweep.test/). makeSweepContext builds a fresh mock indexer
// and handler; each block calls it from its own beforeEach.

const sinon = require('sinon');
const { createMockIndexer } = require('../../../../fixtures/mocks');

const Sweep = require('../../../../../src/actions/sweep/index.js');

const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DESTINATION = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

/** A fresh mock indexer and SWEEP handler, as every sweep test starts from. */
function makeSweepContext() {
    const indexer = createMockIndexer();

    // getAddressEscrows is not in the default mock; add it here
    indexer.indexerDb.getAddressEscrows = sinon.stub().resolves([]);

    const actionsCtx = {
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
    const handler = new Sweep(actionsCtx);
    indexer.util.resetLists();
    return { indexer, actionsCtx, handler };
}

module.exports = { SOURCE, DESTINATION, makeSweepContext };
