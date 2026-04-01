process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Broadcast = require('../../../src/actions/broadcast.js');

describe('Broadcast action handler', function () {
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
        handler = new Broadcast(actionsCtx);
        indexer.util.resetLists();
    });

    // ─── Format validation ────────────────────────────────────────────

    it('accepts format 0 (message + value)', async function () {
        const data = createBaseData({ ACTION: 'BROADCAST', FORMAT: 0 });
        const params = ['0', 'hello world', '42.5'];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('accepts format 1 (oracle: message + value + fee + memo)', async function () {
        const data = createBaseData({ ACTION: 'BROADCAST', FORMAT: 1 });
        const params = ['1', 'BTC-USD', '50000', '1', 'price feed'];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('accepts format 2 (feed: message + fee + memo)', async function () {
        const data = createBaseData({ ACTION: 'BROADCAST', FORMAT: 2 });
        const params = ['2', 'https://example.com/feed.json', '1', 'betting feed'];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('accepts format 3 (feed results: action_index + value + memo)', async function () {
        const data = createBaseData({ ACTION: 'BROADCAST', FORMAT: 3 });
        const params = ['3', '1234', '2', 'results memo'];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects unknown format version', async function () {
        const data = createBaseData({ ACTION: 'BROADCAST', FORMAT: 99 });
        const params = ['99', 'msg'];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('VERSION'), `Expected VERSION error, got: ${data['STATUS']}`);
    });

    // ─── MESSAGE length limit ─────────────────────────────────────────

    it('rejects MESSAGE exceeding MAX_BROADCAST_MESSAGE_LENGTH', async function () {
        const longMsg = 'm'.repeat(indexer.config['MAX_BROADCAST_MESSAGE_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'BROADCAST', FORMAT: 0 });
        const params = ['0', longMsg, '1'];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('MESSAGE'), `Expected MESSAGE length error, got: ${data['STATUS']}`);
    });

    // ─── VALUE length limit ───────────────────────────────────────────

    it('rejects VALUE exceeding MAX_BROADCAST_VALUE_LENGTH', async function () {
        const longVal = '1'.repeat(indexer.config['MAX_BROADCAST_VALUE_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'BROADCAST', FORMAT: 0 });
        const params = ['0', 'short message', longVal];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('VALUE'), `Expected VALUE length error, got: ${data['STATUS']}`);
    });

    // ─── MEMO validation ──────────────────────────────────────────────

    it('rejects MEMO containing a pipe character', async function () {
        const data = createBaseData({ ACTION: 'BROADCAST', FORMAT: 1 });
        const params = ['1', 'BTC-USD', '50000', '1', 'bad|memo'];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('MEMO'), `Expected MEMO error, got: ${data['STATUS']}`);
    });

    it('rejects MEMO containing a semicolon', async function () {
        const data = createBaseData({ ACTION: 'BROADCAST', FORMAT: 1 });
        const params = ['1', 'BTC-USD', '50000', '1', 'bad;memo'];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('MEMO'), `Expected MEMO error, got: ${data['STATUS']}`);
    });

    it('rejects MEMO exceeding MAX_MEMO_LENGTH', async function () {
        const longMemo = 'x'.repeat(indexer.config['MAX_MEMO_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'BROADCAST', FORMAT: 1 });
        const params = ['1', 'BTC-USD', '50000', '1', longMemo];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('MEMO'), `Expected MEMO error, got: ${data['STATUS']}`);
    });

    // ─── Side-effect checks ───────────────────────────────────────────

    it('calls createBroadcast on the indexerDb', async function () {
        const data = createBaseData({ ACTION: 'BROADCAST', FORMAT: 0 });
        const params = ['0', 'hello', '1'];
        await handler.parse(params, data, null);
        assert.ok(indexer.indexerDb.createBroadcast.calledOnce);
    });

    it('calls mapper.createMappings after parse', async function () {
        const data = createBaseData({ ACTION: 'BROADCAST', FORMAT: 0 });
        const params = ['0', 'hello', '1'];
        await handler.parse(params, data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });
});
