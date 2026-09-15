// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The shared fixture of the FILE suites, file.test.js and the parts in
// file.test/: each suite rebuilds its handler through buildFile() before every
// test, so every same-title sibling block starts from the same state.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const sinon = require('sinon');
const { createMockIndexer } = require('../../../../../fixtures/mocks');

const File = require('../../../../../../src/actions/file.js');

/** A fresh mock indexer, its actions context and a FILE handler over it. */
function buildFile() {
    const indexer = createMockIndexer();
    const actionsCtx = {
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
    const handler = new File(actionsCtx);
    indexer.util.resetLists();
    return { indexer, actionsCtx, handler };
}

module.exports = { buildFile };
