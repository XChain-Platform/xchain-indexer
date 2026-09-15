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

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const Issue = require('../../../../src/actions/issue/index.js');
const Mint  = require('../../../../src/actions/mint/index.js');

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

// Issue format 0 param builder
// Fields: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|
//         TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|
//         LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|
//         ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|
//         LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
function makeIssueParams(overrides = {}) {
    const defaults = {
        VERSION: '0', TICK: 'NEWTOKEN', MAX_SUPPLY: '1000', MAX_MINT: '100',
        DECIMALS: '0', DESCRIPTION: 'Test', MINT_SUPPLY: '', TRANSFER: '',
        TRANSFER_SUPPLY: '', LOCK_MAX_SUPPLY: '', LOCK_MAX_MINT: '',
        LOCK_DESCRIPTION: '', LOCK_SLEEP: '', LOCK_CALLBACK: '',
        CALLBACK_BLOCK: '', CALLBACK_TICK: '', CALLBACK_AMOUNT: '',
        ALLOW_LIST: '', BLOCK_LIST: '', MINT_ADDRESS_MAX: '',
        MINT_START_BLOCK: '', MINT_STOP_BLOCK: '', LOCK_MINT: '',
        LOCK_MINT_SUPPLY: '', MEMO: '',
    };
    const m = Object.assign({}, defaults, overrides);
    return [m.VERSION, m.TICK, m.MAX_SUPPLY, m.MAX_MINT, m.DECIMALS,
        m.DESCRIPTION, m.MINT_SUPPLY, m.TRANSFER, m.TRANSFER_SUPPLY,
        m.LOCK_MAX_SUPPLY, m.LOCK_MAX_MINT, m.LOCK_DESCRIPTION,
        m.LOCK_SLEEP, m.LOCK_CALLBACK, m.CALLBACK_BLOCK, m.CALLBACK_TICK,
        m.CALLBACK_AMOUNT, m.ALLOW_LIST, m.BLOCK_LIST, m.MINT_ADDRESS_MAX,
        m.MINT_START_BLOCK, m.MINT_STOP_BLOCK, m.LOCK_MINT, m.LOCK_MINT_SUPPLY,
        m.MEMO];
}

const SOURCE    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const OTHER     = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';
const LOW_BLOCK = 100; // below fee activation (862633)

let indexer, actionsCtx, issueHandler;

function setupStateMachine() {
    indexer      = createMockIndexer();
    actionsCtx   = makeActionsCtx(indexer);
    issueHandler = new Issue(actionsCtx);
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.isDistributed.resolves(false);
    indexer.indexerDb.getAddressBalances.resolves({});
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getTokenSupply.resolves('0');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Token state machine boundary tests @regression @tier2', function () {
    beforeEach(function () {
        setupStateMachine();
    });
    afterEach(function () { sinon.restore(); });

    // -------------------------------------------------------------------------
    // Issue reserved tick 'BTC' from non-GAS address → invalid
    // -------------------------------------------------------------------------

    describe('TOK-01: Issue reserved tick from non-GAS address', function () {

        it("ISSUE TICK='BTC' from non-GAS address → invalid (reserved)", async function () {
            // RESERVED_TICKS rejection is a mainnet rule; issue.js exempts regtest.
            indexer.config.NETWORK = 'mainnet';
            indexer.indexerDb.getTokenInfo.resolves(null);

            const params = makeIssueParams({ TICK: 'BTC' });
            const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, BLOCK_INDEX: LOW_BLOCK });

            await issueHandler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'), `Expected invalid, got: ${data.STATUS}`);
        });
    });
});

// -------------------------------------------------------------------------
// Issue 'XCHAIN' from GAS address → valid
// -------------------------------------------------------------------------

describe('Token state machine boundary tests @regression @tier2', function () {
    beforeEach(setupStateMachine);
    afterEach(function () { sinon.restore(); });

    describe('TOK-02: Issue GAS token from GAS address', function () {

        it("ISSUE TICK='XCHAIN' from GAS address → valid", async function () {
            const GAS_ADDR = indexer.config['ADDRESS']['GAS'];

            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.getAddressBalances.resolves({});

            const params = makeIssueParams({ TICK: 'XCHAIN' });
            const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE: GAS_ADDR, BLOCK_INDEX: LOW_BLOCK });

            await issueHandler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid', `Expected valid, got: ${data.STATUS}`);
        });
    });
});

// -------------------------------------------------------------------------
// Set LOCK_MINT then attempt MINT → MINT rejected
// -------------------------------------------------------------------------

describe('Token state machine boundary tests @regression @tier2', function () {
    beforeEach(setupStateMachine);
    afterEach(function () { sinon.restore(); });

    describe('TOK-03: LOCK_MINT=1 blocks subsequent MINT', function () {

        it('MINT against token with LOCK_MINT=1 → invalid (LOCK_MINT)', async function () {
            const mintHandler = new Mint(actionsCtx);

            // Token exists and has LOCK_MINT set
            const token = createTokenInfo({
                TICK:       'TEST',
                TICK_ID:    1,
                DECIMALS:   0,
                MAX_SUPPLY: '1000',
                MAX_MINT:   '100',
                SUPPLY:     '0',
                LOCK_MINT:  1,
                BLOCK_INDEX: LOW_BLOCK - 1,
            });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.getActionCreditDebitAmount.resolves('0');
            indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);

            // Format 0: VERSION|TICK|AMOUNT|DESTINATION|MEMO
            const params = ['0', 'TEST', '50', '', ''];
            const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, SOURCE, BLOCK_INDEX: LOW_BLOCK });

            await mintHandler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'), `Expected invalid, got: ${data.STATUS}`);
        });
    });
});

// -------------------------------------------------------------------------
// Attempt to unset LOCK_MINT (1 → 0) → invalid
// -------------------------------------------------------------------------

describe('Token state machine boundary tests @regression @tier2', function () {
    beforeEach(setupStateMachine);
    afterEach(function () { sinon.restore(); });

    describe('TOK-04: Cannot unset LOCK_MINT once enabled', function () {

        it("ISSUE format 3 with LOCK_MINT='0' on already-locked token → invalid (locked)", async function () {
            // Token is already locked (LOCK_MINT=1)
            const token = createTokenInfo({
                TICK:      'TEST',
                TICK_ID:   1,
                LOCK_MINT: 1,
                OWNER:     SOURCE,
                SUPPLY:    '0',
            });
            indexer.indexerDb.getTokenInfo.resolves(token);

            // Format 3: VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|
            //           LOCK_SLEEP|LOCK_CALLBACK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
            const params = ['3', 'TEST', '', '', '', '', '', '0', '', ''];
            const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 3, SOURCE, BLOCK_INDEX: LOW_BLOCK });

            await issueHandler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'), `Expected invalid, got: ${data.STATUS}`);
        });
    });
});

// -------------------------------------------------------------------------
// Change DECIMALS after supply > 0 → invalid
// -------------------------------------------------------------------------

describe('Token state machine boundary tests @regression @tier2', function () {
    beforeEach(setupStateMachine);
    afterEach(function () { sinon.restore(); });

    describe('TOK-05: DECIMALS are immutable after supply is issued', function () {

        it('ISSUE with DECIMALS=8 on token with DECIMALS=0 and SUPPLY=500 → invalid (locked)', async function () {
            const token = createTokenInfo({
                TICK:       'TEST',
                TICK_ID:    1,
                DECIMALS:   0,
                SUPPLY:     '500',
                MAX_SUPPLY: '1000',
                MAX_MINT:   '100',
                OWNER:      SOURCE,
            });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.getTokenSupply.resolves('500');

            const params = makeIssueParams({ TICK: 'TEST', DECIMALS: '8' });
            const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, BLOCK_INDEX: LOW_BLOCK });

            await issueHandler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'), `Expected invalid, got: ${data.STATUS}`);
        });
    });
});

// -------------------------------------------------------------------------
// Set MAX_SUPPLY below current SUPPLY → invalid
// -------------------------------------------------------------------------

describe('Token state machine boundary tests @regression @tier2', function () {
    beforeEach(setupStateMachine);
    afterEach(function () { sinon.restore(); });

    describe('TOK-06: MAX_SUPPLY cannot be set below current SUPPLY', function () {

        it('ISSUE with MAX_SUPPLY=499 on token with SUPPLY=500 → invalid (MAX_SUPPLY < SUPPLY)', async function () {
            const token = createTokenInfo({
                TICK:       'TEST',
                TICK_ID:    1,
                DECIMALS:   0,
                SUPPLY:     '500',
                MAX_SUPPLY: '1000',
                MAX_MINT:   '100',
                OWNER:      SOURCE,
            });
            indexer.indexerDb.getTokenInfo.resolves(token);
            // getTokenSupply is what the check compares against
            indexer.indexerDb.getTokenSupply.resolves('500');

            const params = makeIssueParams({ TICK: 'TEST', MAX_SUPPLY: '499' });
            const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, BLOCK_INDEX: LOW_BLOCK });

            await issueHandler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'), `Expected invalid, got: ${data.STATUS}`);
        });
    });
});
