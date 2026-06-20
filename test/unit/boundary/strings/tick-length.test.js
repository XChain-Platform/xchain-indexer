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
const Issue = require('../../../../src/actions/issue.js');

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            // ISSUANCE_FEE is block-gated (protocol_changes.js: mainnet 862633);
            // mirror that so sub-activation blocks skip the fee (all other changes on).
            isEnabled:  sinon.stub().callsFake(async (name, block) =>
                name === "ISSUANCE_FEE" ? Number(block) >= 862633 : true),
        },
        processAction: sinon.stub().resolves(),
    };
}

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

describe('Tick name boundary tests @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer     = createMockIndexer();
        actionsCtx  = makeActionsCtx(indexer);
        handler     = new Issue(actionsCtx);
        indexer.indexerDb.getTokenInfo.resolves(null); // new token
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.isDistributed.resolves(false);
        indexer.indexerDb.getAddressBalances.resolves({});
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTokenSupply.resolves('0');
    });

    afterEach(function () { sinon.restore(); });

    it('STR-01: TICK at minimum length (1 char) is valid', async function () {
        const params = makeIssueParams({ TICK: 'A' });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 100 });
        await handler.parse(params, data, null);
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('STR-02: TICK at maximum length (250 chars) is valid', async function () {
        const params = makeIssueParams({ TICK: 'A'.repeat(250) });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 100 });
        await handler.parse(params, data, null);
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('STR-03: TICK exceeding maximum (251 chars) is invalid', async function () {
        const params = makeIssueParams({ TICK: 'A'.repeat(251) });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 100 });
        await handler.parse(params, data, null);
        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('STR-04: Empty TICK (0 chars) is invalid', async function () {
        const params = makeIssueParams({ TICK: '' });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 100 });
        await handler.parse(params, data, null);
        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('STR-09: TICK with forbidden pipe char is invalid', async function () {
        const params = makeIssueParams({ TICK: 'TEST|TOKEN' });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 100 });
        await handler.parse(params, data, null);
        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('STR-10: TICK with forbidden semicolon is invalid', async function () {
        const params = makeIssueParams({ TICK: 'TEST;TOKEN' });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 100 });
        await handler.parse(params, data, null);
        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('STR-11: TICK with every allowed special char is valid', async function () {
        // The tick contains a '.' so the indexer treats it as a child issuance.
        // The portion before the last '.' is the parent: '~!@#$%^&*()_+-={}[]:<>'
        // Stub getTokenInfo to return a parent token owned by SOURCE when asked for
        // that parent tick, and null for the full child tick (new issuance).
        const SOURCE     = createBaseData().SOURCE;
        const parentTick = '~!@#$%^&*()_+-={}[]:<>';
        indexer.indexerDb.getTokenInfo
            .withArgs(parentTick, sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: parentTick, TICK_ID: 99, OWNER: SOURCE }));
        indexer.indexerDb.getTokenInfo
            .withArgs('~!@#$%^&*()_+-={}[]:<>.?', sinon.match.any, sinon.match.any)
            .resolves(null);

        const params = makeIssueParams({ TICK: '~!@#$%^&*()_+-={}[]:<>.?' });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 100 });
        await handler.parse(params, data, null);
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('STR-12: TICK starting with period is invalid', async function () {
        const params = makeIssueParams({ TICK: '.INVALID' });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 100 });
        await handler.parse(params, data, null);
        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('STR-13: TICK ending with period is invalid', async function () {
        const params = makeIssueParams({ TICK: 'INVALID.' });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 100 });
        await handler.parse(params, data, null);
        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });
});
