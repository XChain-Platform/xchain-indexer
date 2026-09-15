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
// The mock harness the whole Delegate suite runs on: the signing pubkeys, the
// staked SOURCE, the delegation DB stubs and the DELEGATE data builder. The suite
// is delegate.test.js plus the files in delegate.test/; each file keeps its own
// indexer/actionsCtx/handler names and fills them through useDelegateHarness, so
// the test bodies read exactly as they did when the suite was one file.

const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../../../fixtures/mocks');

const Delegate = require('../../../../../src/actions/delegate/index.js');

const VALID_PUBKEY  = 'a'.repeat(64);   // 64 lowercase hex chars (Ed25519)
const VALID_PUBKEY2 = 'b'.repeat(64);

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

function addDelegateStubs(db) {
    db.getActiveStakeBySource   = sinon.stub().resolves({ stake_index: 1 });
    db.getActiveStakeByPubkey   = sinon.stub().resolves(null);  // pubkey not in use
    db.getDelegationByPubkey    = sinon.stub().resolves(null);  // pubkey not delegated
    db.getActiveDelegation      = sinon.stub().resolves({ delegation_index: 1 });
    db.getActiveStakeBySourceAndPubkey = sinon.stub().resolves(null);  // v2 stake-key mode: no own-stake match
    db.getStakeKeyRevocation    = sinon.stub().resolves(null);  // no prior stake-key revocation
    db.createDelegation         = sinon.stub().resolves();
    db.createRevokeDelegation   = sinon.stub().resolves();
    db.createStakeKeyRevocation = sinon.stub().resolves();
    db.setDelegationDeactivation = sinon.stub().resolves();
    db.createContractDelegation = sinon.stub().resolves();
    db.getPubkeyId              = sinon.stub().resolves(null);   // pubkey unknown → no collision
    db.getStatusId              = sinon.stub().resolves(1);
    db.doQuery                  = sinon.stub().resolves([]);     // contract stake lookup, empty by default
    // The five contract-scope checks are the real db mixin methods over that stubbed
    // doQuery, not stubs of their own, so the SQL assertions below still read the text
    // the shipped methods issue and the call counts still count real statements.
    const delegationsMixin = require('../../../../../src/db/delegations');
    for(const m of ['hasActiveContractStakeForDelegation', 'isSigningPubkeyUsedByContractStake',
                    'isSigningPubkeyUsedByContractDelegation', 'hasActiveContractDelegation',
                    'deactivateContractDelegation'])
        db[m] = delegationsMixin[m].bind(db);
}

function delegateData(overrides = {}) {
    return createBaseData({ ACTION: 'DELEGATE', FORMAT: 0, COIN: 'BTC', SOURCE, ...overrides });
}

// One fresh harness, built the way every Delegate test starts.
function createDelegateHarness() {
    const indexer = createMockIndexer();
    addDelegateStubs(indexer.indexerDb);
    indexer.indexerDb.isActionAllowed.resolves(true);

    const actionsCtx = {
        config:    indexer.config,
        util:      indexer.util,
        mapper:    indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
    };
    const handler = new Delegate(actionsCtx);
    indexer.util.resetLists();
    return { indexer, actionsCtx, handler };
}

// Mocha hooks for one describe block: a fresh harness before every test, handed
// to bind so the calling file can fill its own names, and sinon restored after.
function useDelegateHarness(bind) {
    beforeEach(function () {
        bind(createDelegateHarness());
    });

    afterEach(function () {
        sinon.restore();
    });
}

module.exports = {
    VALID_PUBKEY, VALID_PUBKEY2, SOURCE,
    addDelegateStubs, delegateData, createDelegateHarness, useDelegateHarness,
};
