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
 * test/unit/actions/vote_invariants.test/helpers/vote_fixtures.js
 *
 * The mock VOTE handler and the poll row the invariant suite shares
 * (vote_invariants.test.js plus the files in vote_invariants.test/). Every
 * block's beforeEach calls freshVote; the per-behaviour stubs stay in the file
 * that uses them.
 */

const sinon = require('sinon');

const { createMockIndexer } = require('../../../../fixtures/mocks');
const Vote = require('../../../../../src/actions/vote/index.js');

// A fresh mock indexer, action context and VOTE handler, rebuilt before every
// case, with the savepoint and poll-write stubs every block relies on.
function freshVote() {
    const indexer = createMockIndexer();
    const gas     = indexer.config['GAS'];
    const donate1 = indexer.config['ADDRESS']['DONATE1'];

    const executeStub = { parse: sinon.stub().resolves() };
    const actionsCtx = {
        config:        indexer.config,
        util:          indexer.util,
        mapper:        indexer.mapper,
        decoderDb:     indexer.decoderDb,
        indexerDb:     indexer.indexerDb,
        actionExecute: executeStub,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
    };
    const handler = new Vote(actionsCtx);
    indexer.util.resetLists();
    indexer.indexerDb.createSavepoint      = sinon.stub().resolves('sp1');
    indexer.indexerDb.releaseSavepoint     = sinon.stub().resolves();
    indexer.indexerDb.rollbackToSavepoint  = sinon.stub().resolves();
    indexer.indexerDb.setPollCallbackIndex = sinon.stub().resolves();
    indexer.indexerDb.getAddressById       = sinon.stub().resolves('creatorAddr');
    indexer.indexerDb.setPollDepositResolved = sinon.stub().resolves();

    return { indexer, actionsCtx, handler, executeStub, gas, donate1 };
}

// The poll row the handler reads: a deposit of 100 held beside a gas_escrow of 20.
function poll(overrides = {}) {
    return {
        action_index: 100, deposit_amount: '100', gas_escrow: '20',
        deposit_resolved: null, deposit_address_id: 7,
        callback_contract_index: null, callback_on: 'pass', callback_method: null,
        ...overrides,
    };
}

module.exports = { freshVote, poll };
