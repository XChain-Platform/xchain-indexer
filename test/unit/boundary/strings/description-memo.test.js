'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

// Relative path from test/unit/boundary/strings/ to fixtures and src
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const Issue = require('../../../../src/actions/issue.js');
const Send  = require('../../../../src/actions/send.js');

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

// Valid BTC addresses used in Send tests
const DESTINATION = '1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9';

describe('Description & memo boundary tests @regression @tier3', function () {

    // -------------------------------------------------------------------------
    // DESCRIPTION boundary (Issue handler)
    // MAX_TOKEN_DESCRIPTION = 250; check is `>= 250` so 249 passes, 250 fails
    // -------------------------------------------------------------------------
    describe('DESCRIPTION field (Issue)', function () {
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

        it('STR-05: DESCRIPTION at 249 chars is valid', async function () {
            const params = makeIssueParams({ DESCRIPTION: 'A'.repeat(249) });
            const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 100 });
            await handler.parse(params, data, null);
            assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
        });

        it('STR-06: DESCRIPTION at 250 chars is invalid (off-by-one: >= 250 check)', async function () {
            const params = makeIssueParams({ DESCRIPTION: 'A'.repeat(250) });
            const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 100 });
            await handler.parse(params, data, null);
            assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
        });
    });

    // -------------------------------------------------------------------------
    // MEMO boundary (Send handler)
    // MAX_MEMO_LENGTH = 250; check is `> 250` so 250 passes, 251 fails
    // -------------------------------------------------------------------------
    describe('MEMO field (Send)', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer     = createMockIndexer();
            actionsCtx  = makeActionsCtx(indexer);
            handler     = new Send(actionsCtx);
            indexer.indexerDb.getTokenInfo.resolves(
                createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 })
            );
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.findMatchingDispensers.resolves([]);
            indexer.indexerDb.findDispenserSends.resolves([]);
        });

        afterEach(function () { sinon.restore(); });

        it('STR-07: MEMO at 250 chars is valid', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, 'A'.repeat(250)];
            const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100 });
            await handler.parse(params, data, null);
            assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
        });

        it('STR-08: MEMO at 251 chars is invalid', async function () {
            const params = ['0', 'TEST', '100', DESTINATION, 'A'.repeat(251)];
            const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: 100 });
            await handler.parse(params, data, null);
            assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
        });
    });
});
