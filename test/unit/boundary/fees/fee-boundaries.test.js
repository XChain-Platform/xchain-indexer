'use strict';

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

// XCHAIN tick_id used in all fee scenarios
const XCHAIN_TICK_ID = 99;
const SOURCE = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';

describe('Fee boundary tests @regression @tier1', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer     = createMockIndexer();
        actionsCtx  = makeActionsCtx(indexer);
        handler     = new Issue(actionsCtx);

        indexer.indexerDb.getTokenInfo.resolves(null); // new token by default
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.isDistributed.resolves(false);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTokenSupply.resolves('0');
        // getTickerId for XCHAIN gas token
        indexer.indexerDb.getTickerId.resolves(XCHAIN_TICK_ID); // XCHAIN tick_id = 99
    });

    afterEach(function () { sinon.restore(); });

    it('FEE-01: Issue at block 862632 (one before activation) requires no fee even with no XCHAIN balance', async function () {
        // Block is one before fee activation — no fee should be charged
        indexer.indexerDb.getAddressBalances.resolves({}); // no XCHAIN

        const params = makeIssueParams({ TICK: 'NOTOK' });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 862632, SOURCE });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('FEE-02: Issue at block 862633 (activation block) with exactly enough XCHAIN succeeds', async function () {
        // Block meets activation threshold; balance is exactly ISSUANCE_FEE_TOKEN (1 XCHAIN)
        indexer.indexerDb.getAddressBalances.resolves({ [XCHAIN_TICK_ID]: '1.00000000' });

        const params = makeIssueParams({ TICK: 'FEETOK' });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 862633, SOURCE });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('FEE-03: Issue at block 862633 with insufficient XCHAIN (1 sat short) is invalid', async function () {
        // 0.99999999 is one satoshi below the 1.00000000 XCHAIN fee
        indexer.indexerDb.getAddressBalances.resolves({ [XCHAIN_TICK_ID]: '0.99999999' });

        const params = makeIssueParams({ TICK: 'INSUF' });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 862633, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });

    it('FEE-04: Issue at block 862633 with exact XCHAIN balance drains account to zero — valid', async function () {
        // Balance equals fee exactly — fee is charged, leaving zero XCHAIN
        indexer.indexerDb.getAddressBalances.resolves({ [XCHAIN_TICK_ID]: '1.00000000' });

        const params = makeIssueParams({ TICK: 'EXACT' });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 862633, SOURCE });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('FEE-05: Re-issuance (update existing token) requires no fee even after activation block', async function () {
        // tokenInfo is not null → this is an update, not a new issuance → no fee charged
        indexer.indexerDb.getTokenInfo.resolves(
            createTokenInfo({ TICK: 'EXISTING', TICK_ID: 5, OWNER: SOURCE })
        );
        indexer.indexerDb.getAddressBalances.resolves({}); // no XCHAIN at all

        const params = makeIssueParams({ TICK: 'EXISTING', DESCRIPTION: 'Updated desc' });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 900000, SOURCE });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('FEE-06: Sub-token issuance charges ISSUANCE_FEE_SUBTOKEN (0.5 XCHAIN) — valid with exact balance', async function () {
        // TICK = 'PARENT.CHILD' → detected as sub-token because parts.length > 1
        // Parent tick must exist and be owned by SOURCE
        indexer.indexerDb.getTokenInfo
            .withArgs('PARENT', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PARENT', TICK_ID: 5, OWNER: SOURCE }));
        indexer.indexerDb.getTokenInfo
            .withArgs('PARENT.CHILD', sinon.match.any, sinon.match.any)
            .resolves(null); // new sub-token

        // Balance is exactly the sub-token fee (0.50000000)
        indexer.indexerDb.getAddressBalances.resolves({ [XCHAIN_TICK_ID]: '0.50000000' });

        const params = makeIssueParams({ TICK: 'PARENT.CHILD' });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 862633, SOURCE });

        await handler.parse(params, data, null);

        assert.strictEqual(data.STATUS, 'valid', `expected valid but got: ${data.STATUS}`);
    });

    it('FEE-07: Sub-token issuance with 1 sat below ISSUANCE_FEE_SUBTOKEN (0.49999999) is invalid', async function () {
        // 0.49999999 is one satoshi below the 0.50000000 sub-token fee
        indexer.indexerDb.getTokenInfo
            .withArgs('PARENT', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'PARENT', TICK_ID: 5, OWNER: SOURCE }));
        indexer.indexerDb.getTokenInfo
            .withArgs('PARENT.CHILD', sinon.match.any, sinon.match.any)
            .resolves(null);

        indexer.indexerDb.getAddressBalances.resolves({ [XCHAIN_TICK_ID]: '0.49999999' });

        const params = makeIssueParams({ TICK: 'PARENT.CHILD' });
        const data   = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: 862633, SOURCE });

        await handler.parse(params, data, null);

        assert.ok(data.STATUS.startsWith('invalid'), `expected invalid but got: ${data.STATUS}`);
    });
});
