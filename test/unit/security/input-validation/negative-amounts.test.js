'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');

// Import action handlers
const Send  = require('../../../../src/actions/send.js');
const Mint  = require('../../../../src/actions/mint.js');
const Issue = require('../../../../src/actions/issue.js');
const Order = require('../../../../src/actions/order.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
const SOURCE      = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';
const DESTINATION = '1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9';

// Issue format 0 param builder
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

// ---------------------------------------------------------------------------
// Suite: isValidAmountFormat direct tests
// ---------------------------------------------------------------------------

describe('Security: negative amount rejection in isValidAmountFormat()', function () {
    let util;

    before(function () {
        const indexer = createMockIndexer();
        util = indexer.util;
    });

    it('SEC-01: isValidAmountFormat(0, \'-100\') → false', function () {
        assert.strictEqual(util.isValidAmountFormat(0, '-100'), false);
    });

    it('SEC-02: isValidAmountFormat(8, \'-1.5\') → false', function () {
        assert.strictEqual(util.isValidAmountFormat(8, '-1.5'), false);
    });

    it('SEC-03: isValidAmountFormat(0, \'-0\') → false', function () {
        assert.strictEqual(util.isValidAmountFormat(0, '-0'), false);
    });

    it('SEC-04: isValidAmountFormat(18, \'-0.000000000000000001\') → false', function () {
        assert.strictEqual(util.isValidAmountFormat(18, '-0.000000000000000001'), false);
    });

    it('SEC-05: isValidAmountFormat(0, \'100\') → true (positive still works)', function () {
        assert.strictEqual(util.isValidAmountFormat(0, '100'), true);
    });

    it('SEC-06: isValidAmountFormat(8, \'1.50000000\') → true (positive decimal still works)', function () {
        assert.strictEqual(util.isValidAmountFormat(8, '1.50000000'), true);
    });

    it('SEC-12: isValidAmountFormat(0, \'0\') → true (zero is not negative)', function () {
        assert.strictEqual(util.isValidAmountFormat(0, '0'), true);
    });
});

// ---------------------------------------------------------------------------
// Suite: negative amounts rejected by action handlers
// ---------------------------------------------------------------------------

describe('Security: negative amounts rejected by action handlers', function () {
    let indexer, actionsCtx;

    beforeEach(function () {
        indexer     = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);

        // Standard mock setup for token resolution
        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', DECIMALS: 0, MAX_SUPPLY: '1000', MAX_MINT: '100', SUPPLY: '500' }));
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
        indexer.indexerDb.getActionCreditDebitAmount.resolves(0);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('SEC-07: SEND with negative AMOUNT → invalid status', async function () {
        const handler = new Send(actionsCtx);
        const params  = ['0', 'TEST', '-100', DESTINATION, ''];
        const data    = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('SEC-08: MINT with negative AMOUNT → invalid status', async function () {
        const handler = new Mint(actionsCtx);
        const params  = ['0', 'TEST', '-50', '', ''];
        const data    = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('SEC-09: ISSUE with negative MAX_SUPPLY → invalid status', async function () {
        const handler = new Issue(actionsCtx);
        indexer.indexerDb.getTokenInfo.resolves(null); // New token
        const params  = makeIssueParams({ TICK: 'NEGTOK', MAX_SUPPLY: '-1000', MAX_MINT: '100' });
        const data    = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('SEC-10: ORDER with negative GIVE_AMOUNT → invalid status', async function () {
        const handler = new Order(actionsCtx);
        const params  = ['0', 'BTC', 'TEST', '-100', 'BTC', 'OTHER', '50', '', '', '', '', ''];
        const data    = createBaseData({ ACTION: 'ORDER', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('SEC-11: SEND with \'-0\' AMOUNT → invalid status', async function () {
        const handler = new Send(actionsCtx);
        const params  = ['0', 'TEST', '-0', DESTINATION, ''];
        const data    = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });
});
