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

// test/unit/boundary/tokens/state_machine.test/sub_tokens_and_supply_lock.test.js
//
// Covers sub-token ownership boundaries and permanent maximum-supply locks.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const Issue = require('../../../../../src/actions/issue/index.js');

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

// -------------------------------------------------------------------------
// Sub-token issuance without parent → invalid
// -------------------------------------------------------------------------

describe('Token state machine boundary tests @regression @tier2', function () {
    beforeEach(setupStateMachine);
    afterEach(function () { sinon.restore(); });

    describe('TOK-07: Sub-token requires existing parent', function () {

        it("ISSUE TICK='PARENT.CHILD' when PARENT does not exist → invalid (parent unknown)", async function () {
            // Neither the child nor parent token exist
            indexer.indexerDb.getTokenInfo
                .withArgs('PARENT.CHILD', sinon.match.any, sinon.match.any).resolves(null)
                .withArgs('PARENT',       sinon.match.any, sinon.match.any).resolves(null);

            const params = makeIssueParams({ TICK: 'PARENT.CHILD' });
            const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, BLOCK_INDEX: LOW_BLOCK });

            await issueHandler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'), `Expected invalid, got: ${data.STATUS}`);
        });
    });
});

// -------------------------------------------------------------------------
// Sub-token issuance by non-owner → invalid
// -------------------------------------------------------------------------

describe('Token state machine boundary tests @regression @tier2', function () {
    beforeEach(setupStateMachine);
    afterEach(function () { sinon.restore(); });

    describe('TOK-08: Sub-token must be issued by parent token owner', function () {

        it("ISSUE TICK='PARENT.CHILD' by non-owner of PARENT → invalid (parent issued by another address)", async function () {
            // Parent exists but is owned by OTHER, not SOURCE
            const parentToken = createTokenInfo({
                TICK:  'PARENT',
                OWNER: OTHER,
            });
            indexer.indexerDb.getTokenInfo
                .withArgs('PARENT.CHILD', sinon.match.any, sinon.match.any).resolves(null)
                .withArgs('PARENT',       sinon.match.any, sinon.match.any).resolves(parentToken);

            const params = makeIssueParams({ TICK: 'PARENT.CHILD' });
            const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, BLOCK_INDEX: LOW_BLOCK });

            await issueHandler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'), `Expected invalid, got: ${data.STATUS}`);
        });
    });
});

// -------------------------------------------------------------------------
// Tick with ^ prefix non-numeric body → invalid
// -------------------------------------------------------------------------

describe('Token state machine boundary tests @regression @tier2', function () {
    beforeEach(setupStateMachine);
    afterEach(function () { sinon.restore(); });

    describe('TOK-09: ^-prefixed TICK must have a numeric body', function () {

        it("ISSUE TICK='^abc' (non-numeric body) → invalid (TICK id)", async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);

            const params = makeIssueParams({ TICK: '^abc' });
            const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, BLOCK_INDEX: LOW_BLOCK });

            await issueHandler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'), `Expected invalid, got: ${data.STATUS}`);
        });
    });
});

// -------------------------------------------------------------------------
// LOCK_MAX_SUPPLY requires a declared MAX_SUPPLY cap, not minted supply
// -------------------------------------------------------------------------

describe('Token state machine boundary tests @regression @tier2', function () {
    beforeEach(setupStateMachine);
    afterEach(function () { sinon.restore(); });

    describe('TOK-10: LOCK_MAX_SUPPLY guard : declared cap, not minted supply', function () {
        // The LOCK_MAX_SUPPLY guard validates the *declared cap* (from this action, else
        // the token record), NOT minted supply : a fair-mint token must be able to issue
        // with zero supply, public mint rules, and a permanently locked cap in one ISSUE.
        // The only rejected case is locking with no MAX_SUPPLY declared, which would brick
        // the TICK at a cap of zero.

        function makeExistingToken(maxSupply) {
            return createTokenInfo({
                TICK:            'TEST',
                TICK_ID:         1,
                DECIMALS:        0,
                SUPPLY:          '0',
                MAX_SUPPLY:      maxSupply,
                MAX_MINT:        '100',
                LOCK_MAX_SUPPLY: 0,
                OWNER:           SOURCE,
            });
        }

        // Format 3: VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|
        //           LOCK_SLEEP|LOCK_CALLBACK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
        const LOCK_EDIT_PARAMS = ['3', 'TEST', '1', '', '', '', '', '', '', ''];

        it('ISSUE format 3 LOCK_MAX_SUPPLY=1 on zero-supply token with declared cap → valid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(makeExistingToken('1000'));
            indexer.indexerDb.getTokenSupply.resolves('0');

            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 3, SOURCE, BLOCK_INDEX: LOW_BLOCK });
            await issueHandler.parse(LOCK_EDIT_PARAMS.slice(), data, null);

            assert.strictEqual(data.STATUS, 'valid', `got: ${data.STATUS}`);
        });

        it('ISSUE format 3 LOCK_MAX_SUPPLY=1 with no declared cap → invalid (no max supply)', async function () {
            indexer.indexerDb.getTokenInfo.resolves(makeExistingToken('0'));
            indexer.indexerDb.getTokenSupply.resolves('0');

            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 3, SOURCE, BLOCK_INDEX: LOW_BLOCK });
            await issueHandler.parse(LOCK_EDIT_PARAMS.slice(), data, null);

            assert.strictEqual(data.STATUS, 'invalid: LOCK_MAX_SUPPLY (no max supply)', `got: ${data.STATUS}`);
        });
    });
});

describe('Token state machine boundary tests @regression @tier2', function () {
    beforeEach(setupStateMachine);
    afterEach(function () { sinon.restore(); });

    describe('TOK-10: LOCK_MAX_SUPPLY guard : declared cap, not minted supply', function () {

        it('ISSUE format 0 fair-mint (zero supply, mint rules, locked cap) → valid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            // Fee activation is irrelevant to the lock rule under test
            actionsCtx.protocolChanges.isEnabled.withArgs('ISSUANCE_FEE', sinon.match.any).resolves(false);

            const params = makeIssueParams({
                MAX_SUPPLY:       '1000000',
                MAX_MINT:         '1000',
                MINT_SUPPLY:      '',
                LOCK_MAX_SUPPLY:  '1',
                MINT_ADDRESS_MAX: '1000',
            });
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, BLOCK_INDEX: LOW_BLOCK });
            await issueHandler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid', `got: ${data.STATUS}`);
        });

        it('ISSUE format 0 LOCK_MAX_SUPPLY=1 with MAX_SUPPLY=0 → invalid (no max supply)', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            actionsCtx.protocolChanges.isEnabled.withArgs('ISSUANCE_FEE', sinon.match.any).resolves(false);

            const params = makeIssueParams({ MAX_SUPPLY: '0', LOCK_MAX_SUPPLY: '1' });
            const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, SOURCE, BLOCK_INDEX: LOW_BLOCK });
            await issueHandler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'invalid: LOCK_MAX_SUPPLY (no max supply)', `got: ${data.STATUS}`);
        });
    });
});
