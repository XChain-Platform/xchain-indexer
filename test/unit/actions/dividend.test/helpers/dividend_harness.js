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
// The mock harness the whole Dividend suite runs on: a mock indexer, the
// actions context dividend.js is constructed with, and the SOURCE and holder
// addresses. The suite is dividend.test.js plus the files in dividend.test/;
// each file keeps its own indexer/actionsCtx/handler names and fills them
// through useDividendHarness, so the test bodies read the same in every file.

const sinon = require('sinon');
const { createMockIndexer } = require('../../../../fixtures/mocks');

const Dividend = require('../../../../../src/actions/dividend/index.js');

const SOURCE  = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const HOLDER1 = 'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz';
const HOLDER2 = 'mk7MdP3qzVkgyjaYNR2sUY8Ggn4DWxt2KS';

// One fresh harness, built the way every Dividend test starts.
function createDividendHarness() {
    const indexer = createMockIndexer();
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
    const handler = new Dividend(actionsCtx);
    indexer.util.resetLists();
    return { indexer, actionsCtx, handler };
}

// The suite's hooks, installed in the calling describe: a fresh harness before
// every test, handed to `bind`, and every sinon stub restored after it.
function useDividendHarness(bind) {
    beforeEach(function () {
        bind(createDividendHarness());
    });

    afterEach(function () {
        sinon.restore();
    });
}

module.exports = { SOURCE, HOLDER1, HOLDER2, createDividendHarness, useDividendHarness };
