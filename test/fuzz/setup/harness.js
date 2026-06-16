/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Fuzz test harness — shared helpers for all fuzz suites
 *
 * Provides mock indexer setup, action context construction, and
 * a normalizeDataValues binding for property-based testing.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const NUM_RUNS = parseInt(process.env.FUZZ_RUNS || '1000');

/**
 * Build an actionsCtx object suitable for constructing any action handler.
 * Matches the shape expected by all handler constructors in src/actions/*.js.
 */
function makeFuzzActionsCtx(indexer) {
    return {
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
}

/**
 * Create a minimal object that can call Database.prototype.normalizeDataValues.
 * The real method reads this.config and this.util, so we bind those from a mock indexer.
 */
function bindNormalize() {
    const Database = require('../../../src/db.js');
    const indexer = createMockIndexer();
    const ctx = {
        config: indexer.config,
        util: indexer.util,
    };
    return Database.prototype.normalizeDataValues.bind(ctx);
}

module.exports = {
    NUM_RUNS,
    createMockIndexer,
    createBaseData,
    createTokenInfo,
    makeFuzzActionsCtx,
    bindNormalize,
};
