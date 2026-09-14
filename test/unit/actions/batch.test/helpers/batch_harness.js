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
// The mock harness the whole Batch suite runs on: a mock indexer, the actions
// context batch.js is constructed with, and a funded SOURCE. The suite is
// batch.test.js plus the files in batch.test/; each file keeps its own
// indexer/actionsCtx/handler names and fills them through useBatchHarness, so
// the test bodies read exactly as they did when the suite was one file.

const sinon = require('sinon');
const { createMockIndexer } = require('../../../../fixtures/mocks');

const Batch = require('../../../../../src/actions/batch.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

// One fresh harness, built the way every Batch test starts.
function createBatchHarness() {
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
        // Mirror the alias table actions/index.js defines; batch.js reads it via
        // this.actions.actionAliases for flag-day sub-action normalization.
        actionAliases:   { TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' },
    };
    const handler = new Batch(actionsCtx);
    // The spam collapse's aggregate gas pre-check reads the SOURCE's gas balance, and the bare mock
    // returns {} (a source holding nothing), which would make every ISSUE batch below a
    // no-gas batch. Model the ordinary case - a funded source - so the assertions in this
    // file keep testing what they were written to test; the spam-collapse block funds per test.
    // Keyed by the mock getTickerId's fixed id 1.
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
    indexer.util.resetLists();
    return { indexer, actionsCtx, handler };
}

// The suite's hooks, installed in the calling describe: a fresh harness before
// every test, handed to `bind`, and every sinon stub restored after it.
function useBatchHarness(bind) {
    beforeEach(function () {
        bind(createBatchHarness());
    });

    afterEach(function () {
        sinon.restore();
    });
}

module.exports = { SOURCE, createBatchHarness, useBatchHarness };
