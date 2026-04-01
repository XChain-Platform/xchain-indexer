'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const Mint  = require('../../../../src/actions/mint.js');
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

const SOURCE = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';

function makeMintableToken(overrides = {}) {
    return createTokenInfo(Object.assign({
        TICK: 'TEST', TICK_ID: 1, DECIMALS: 0,
        MAX_SUPPLY: '1000', MAX_MINT: '100', SUPPLY: '0',
        LOCK_MINT: 0, MINT_ADDRESS_MAX: null,
        MINT_START_BLOCK: '50', MINT_STOP_BLOCK: '200',
        BLOCK_INDEX: 10,
    }, overrides));
}

describe('MINT block window boundary tests', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Mint(actionsCtx);
        indexer.indexerDb.getTokenInfo.resolves(makeMintableToken());
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getActionCreditDebitAmount.resolves('0');
        indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);
    });

    afterEach(function () { sinon.restore(); });

    it('TS-07: MINT at exactly MINT_START_BLOCK (block 50) is valid', async function () {
        const params = ['0', 'TEST', '50', '', ''];
        const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: 50, SOURCE });
        await handler.parse(params, data, null);
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('TS-08: MINT one block before MINT_START_BLOCK (block 49) is invalid', async function () {
        const params = ['0', 'TEST', '50', '', ''];
        const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: 49, SOURCE });
        await handler.parse(params, data, null);
        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('TS-09: MINT at exactly MINT_STOP_BLOCK (block 200) is valid', async function () {
        const params = ['0', 'TEST', '50', '', ''];
        const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: 200, SOURCE });
        await handler.parse(params, data, null);
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('TS-10: MINT one block after MINT_STOP_BLOCK (block 201) is invalid', async function () {
        const params = ['0', 'TEST', '50', '', ''];
        const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: 201, SOURCE });
        await handler.parse(params, data, null);
        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });
});

describe('FORMAT_VERSION boundary tests (via ISSUE)', function () {
    let indexer, actionsCtx, issueHandler;

    // Minimal Issue params for format 0 (enough fields to pass validation if format is known)
    function makeMinimalIssueParams() {
        return [
            '0',          // VERSION
            'NEWTOKEN',   // TICK
            '1000',       // MAX_SUPPLY
            '100',        // MAX_MINT
            '0',          // DECIMALS
            'Test token', // DESCRIPTION
            '', '', '',   // MINT_SUPPLY, TRANSFER, TRANSFER_SUPPLY
            '', '', '',   // LOCK_MAX_SUPPLY, LOCK_MAX_MINT, LOCK_DESCRIPTION
            '', '',       // LOCK_SLEEP, LOCK_CALLBACK
            '', '', '',   // CALLBACK_BLOCK, CALLBACK_TICK, CALLBACK_AMOUNT
            '', '',       // ALLOW_LIST, BLOCK_LIST
            '',           // MINT_ADDRESS_MAX
            '', '',       // MINT_START_BLOCK, MINT_STOP_BLOCK
            '', '',       // LOCK_MINT, LOCK_MINT_SUPPLY
            '',           // MEMO
        ];
    }

    beforeEach(function () {
        indexer      = createMockIndexer();
        actionsCtx   = makeActionsCtx(indexer);
        issueHandler = new Issue(actionsCtx);
        indexer.indexerDb.getTokenInfo.resolves(null);    // new token
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.isDistributed.resolves(false);
        indexer.indexerDb.getAddressBalances.resolves({});
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTokenSupply.resolves('0');
    });

    afterEach(function () { sinon.restore(); });

    it('TS-14: FORMAT_VERSION = 0 (control) is valid', async function () {
        const params = makeMinimalIssueParams();
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0 });
        await issueHandler.parse(params, data, null);
        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('TS-14: FORMAT_VERSION = 255 (max value getFormatVersion accepts, but unknown to Issue) is invalid', async function () {
        // getFormatVersion returns 255 for numeric 255 — it is within range but Issue has no formats[255]
        const params = makeMinimalIssueParams();
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 255 });
        await issueHandler.parse(params, data, null);
        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('TS-15: FORMAT_VERSION = 256 (getFormatVersion returns null) is invalid', async function () {
        // getFormatVersion returns null for values > 255; action rejects null format
        const params = makeMinimalIssueParams();
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: null });
        await issueHandler.parse(params, data, null);
        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });
});
