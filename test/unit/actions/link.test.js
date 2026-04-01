process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Link = require('../../../src/actions/link.js');

describe('Link action handler', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config: indexer.config,
            util: indexer.util,
            mapper: indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
        handler = new Link(actionsCtx);
        indexer.util.resetLists();
    });

    function makeParams(coin1, index1, coin2, index2, memo) {
        return ['0', coin1, String(index1), coin2, String(index2), memo || ''];
    }

    // ─── Valid link creation ──────────────────────────────────────────

    it('creates a valid BTC->BTC link', async function () {
        const data = createBaseData({ ACTION: 'LINK', FORMAT: 0 });
        await handler.parse(makeParams('BTC', 100, 'BTC', 200, 'linked'), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('creates a valid cross-chain BTC->LTC link', async function () {
        const data = createBaseData({ ACTION: 'LINK', FORMAT: 0 });
        // COIN2 is LTC so COIN2_ACTION_INDEX is not validated locally
        await handler.parse(makeParams('BTC', 100, 'LTC', 200, 'cross-chain'), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('creates a valid cross-chain BTC->DOGE link', async function () {
        const data = createBaseData({ ACTION: 'LINK', FORMAT: 0 });
        await handler.parse(makeParams('BTC', 100, 'DOGE', 999, ''), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    // ─── COIN1/COIN2 must be in accepted coins ────────────────────────

    it('rejects COIN1 not in accepted coins', async function () {
        const data = createBaseData({ ACTION: 'LINK', FORMAT: 0 });
        await handler.parse(makeParams('XYZ', 100, 'BTC', 200, ''), data, null);
        assert.ok(data['STATUS'].includes('COIN1'), `Expected COIN1 error, got: ${data['STATUS']}`);
    });

    it('rejects COIN2 not in accepted coins', async function () {
        const data = createBaseData({ ACTION: 'LINK', FORMAT: 0 });
        await handler.parse(makeParams('BTC', 100, 'ETH', 200, ''), data, null);
        assert.ok(data['STATUS'].includes('COIN2'), `Expected COIN2 error, got: ${data['STATUS']}`);
    });

    // ─── ACTION_INDEX validations ─────────────────────────────────────

    it('rejects non-numeric COIN1_ACTION_INDEX', async function () {
        const data = createBaseData({ ACTION: 'LINK', FORMAT: 0 });
        const params = ['0', 'BTC', 'abc', 'BTC', '200', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('COIN1_ACTION_INDEX'), `Expected COIN1_ACTION_INDEX error, got: ${data['STATUS']}`);
    });

    it('rejects non-numeric COIN2_ACTION_INDEX', async function () {
        const data = createBaseData({ ACTION: 'LINK', FORMAT: 0 });
        const params = ['0', 'BTC', '100', 'BTC', 'xyz', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('COIN2_ACTION_INDEX'), `Expected COIN2_ACTION_INDEX error, got: ${data['STATUS']}`);
    });

    it('rejects when COIN1_ACTION_INDEX is invalid on current COIN', async function () {
        indexer.indexerDb.isActionIndexValid.resolves(false);
        const data = createBaseData({ ACTION: 'LINK', FORMAT: 0 });
        await handler.parse(makeParams('BTC', 100, 'BTC', 200, ''), data, null);
        assert.ok(data['STATUS'].includes('COIN1_ACTION_INDEX'), `Expected COIN1_ACTION_INDEX status error, got: ${data['STATUS']}`);
    });

    // ─── SOURCE sleeping check ────────────────────────────────────────

    it('rejects when SOURCE is sleeping', async function () {
        indexer.indexerDb.isActionAllowed.resolves(false);
        const data = createBaseData({ ACTION: 'LINK', FORMAT: 0 });
        await handler.parse(makeParams('BTC', 100, 'LTC', 200, ''), data, null);
        assert.ok(data['STATUS'].includes('SOURCE'), `Expected SOURCE sleeping error, got: ${data['STATUS']}`);
    });

    // ─── MEMO validation ──────────────────────────────────────────────

    it('rejects MEMO containing a pipe character', async function () {
        const data = createBaseData({ ACTION: 'LINK', FORMAT: 0 });
        await handler.parse(makeParams('BTC', 100, 'LTC', 200, 'bad|memo'), data, null);
        assert.ok(data['STATUS'].includes('MEMO'), `Expected MEMO error, got: ${data['STATUS']}`);
    });

    // ─── Side-effect checks ───────────────────────────────────────────

    it('calls createLink on the indexerDb', async function () {
        const data = createBaseData({ ACTION: 'LINK', FORMAT: 0 });
        await handler.parse(makeParams('BTC', 100, 'LTC', 200, ''), data, null);
        assert.ok(indexer.indexerDb.createLink.calledOnce);
    });

    it('calls mapper.createMappings after parse', async function () {
        const data = createBaseData({ ACTION: 'LINK', FORMAT: 0 });
        await handler.parse(makeParams('BTC', 100, 'LTC', 200, ''), data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });
});
