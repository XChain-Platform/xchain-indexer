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

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');
const Actions = require('../../../src/actions.js');
const Issue   = require('../../../src/actions/issue.js');
const Send    = require('../../../src/actions/send.js');

// Build the indexer-like object expected by Actions constructor
function makeIndexerForActions(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
    };
}

// Build the ctx object that individual action handlers (Issue, Send, etc.) receive.
// Individual handlers receive an "actions" object (the same shape as Actions instance).
function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

describe('Smoke: handler instantiation and basic action processing', function () {

    afterEach(function () {
        sinon.restore();
    });

    it('SM-10: Actions constructor instantiates all handlers', function () {
        const indexer = createMockIndexer();
        const indexerObj = makeIndexerForActions(indexer);
        const actionsInstance = new Actions(indexerObj);

        // Verify key handlers exist
        assert.ok(actionsInstance.actionIssue,      'Issue handler loaded');
        assert.ok(actionsInstance.actionSend,       'Send handler loaded');
        assert.ok(actionsInstance.actionMint,       'Mint handler loaded');
        assert.ok(actionsInstance.actionOrder,      'Order handler loaded');
        assert.ok(actionsInstance.actionDispenser,  'Dispenser handler loaded');
        assert.ok(actionsInstance.actionBatch,      'Batch handler loaded');
        assert.ok(actionsInstance.actionSleep,      'Sleep handler loaded');
        assert.ok(actionsInstance.actionSweep,      'Sweep handler loaded');
        assert.ok(actionsInstance.actionDestroy,    'Destroy handler loaded');
        assert.ok(actionsInstance.actionAirdrop,    'Airdrop handler loaded');
        assert.ok(actionsInstance.actionUnknown,    'Unknown handler loaded');
    });

    it('SM-11: Basic ISSUE processes validly', async function () {
        const indexer = createMockIndexer();
        const ctx     = makeActionsCtx(indexer);
        const handler = new Issue(ctx);

        // New token (no existing tokenInfo)
        indexer.indexerDb.getTokenInfo.resolves(null);
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.isDistributed.resolves(false);
        indexer.indexerDb.getAddressBalances.resolves({});
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTokenSupply.resolves('0');
        // getTickerId must resolve for createFeesObject (util.createFeesObject calls indexerDb.getTickerId)
        indexer.indexerDb.getTickerId.resolves(1);

        // ISSUE format 0: full params (25 fields after VERSION)
        const params = ['0', 'SMOKETEST', '1000', '100', '0', 'Smoke test token', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 100 });

        await handler.parse(params, data, false);

        assert.strictEqual(data.STATUS, 'valid');
        assert.ok(indexer.indexerDb.createIssue.calledOnce, 'createIssue should be called once');
    });

    it('SM-12: Basic SEND processes validly', async function () {
        const indexer = createMockIndexer();
        const ctx     = makeActionsCtx(indexer);
        const handler = new Send(ctx);

        const token = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
        indexer.indexerDb.getTokenInfo.resolves(token);

        // Sender has enough balance (TICK_ID=1 → '1000')
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });

        // SEND format 0: VERSION|TICK|AMOUNT|DESTINATION|MEMO
        const params = ['0', 'TEST', '100', 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs', ''];
        const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100 });

        await handler.parse(params, data, false);

        assert.strictEqual(data.STATUS, 'valid');
        assert.ok(indexer.indexerDb.createSend.calledOnce, 'createSend should be called once');
    });

});
