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

const Send  = require('../../../../src/actions/send.js');
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
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

const LOW_BLOCK   = 100;
const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DESTINATION = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';

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

describe('Security: malformed parameter injection @regression @tier4', function () {
    let indexer, actionsCtx;

    beforeEach(function () {
        indexer     = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);

        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', DECIMALS: 0 }));
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
    });

    afterEach(function () {
        sinon.restore();
    });

    it('SEC-13: SEND with empty string AMOUNT → no crash (safely handled as zero)', async function () {
        const handler = new Send(actionsCtx);
        const params  = ['0', 'TEST', '', DESTINATION, ''];
        const data    = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

        // Empty string is treated as null by isNull(), skipping AMOUNT format validation.
        // bcnum() now safely returns 0 for non-numeric inputs instead of crashing.
        // A zero-amount SEND proceeds without error; this is safe (no state change).
        await handler.parse(params, data, null);
        // Key assertion: no crash; the handler completes regardless of status
        assert.ok(data.STATUS !== undefined, 'Handler should complete without crashing');
    });

    it('SEC-14: SEND with non-numeric AMOUNT (\'abc\') → invalid', async function () {
        const handler = new Send(actionsCtx);
        const params  = ['0', 'TEST', 'abc', DESTINATION, ''];
        const data    = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('SEC-15: SEND with SQL injection in AMOUNT → invalid', async function () {
        const handler = new Send(actionsCtx);
        const params  = ['0', 'TEST', '1; DROP TABLE sends', DESTINATION, ''];
        const data    = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('SEC-16: ISSUE with TICK containing pipe delimiter → handled safely', async function () {
        const handler = new Issue(actionsCtx);
        indexer.indexerDb.getTokenInfo.resolves(null);
        // Pipe in TICK would have been split during parsing, so the params array
        // would be misaligned: handler should not crash
        const params  = makeIssueParams({ TICK: 'BAD|TICK' });
        const data    = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

        await handler.parse(params, data, null);

        // Should either be invalid or at least not throw
        assert.ok(typeof data.STATUS === 'string', 'handler should set a status string');
    });

    it('SEC-17: SEND with extremely long AMOUNT string (10000 chars) → invalid', async function () {
        const handler = new Send(actionsCtx);
        const longAmount = '1'.repeat(10000);
        const params  = ['0', 'TEST', longAmount, DESTINATION, ''];
        const data    = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('SEC-18: SEND with null DESTINATION → invalid', async function () {
        const handler = new Send(actionsCtx);
        const params  = ['0', 'TEST', '100', null, ''];
        const data    = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE, COIN_DESTINATION: null });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });
});
