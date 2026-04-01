process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const File = require('../../../src/actions/file.js');

describe('File action handler @regression @tier3', function () {
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
        handler = new File(actionsCtx);
        indexer.util.resetLists();
    });

    // ─── Valid file creation ──────────────────────────────────────────

    it('creates a valid file record', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', 'Test File', 'a memo'];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('creates a valid file with no memo', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'logo.jpg', 'image/jpeg', 'Logo', ''];
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects unknown format version', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 99 });
        const params = ['99', 'test.txt', 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('VERSION'), `Expected VERSION error, got: ${data['STATUS']}`);
    });

    // ─── NAME length limit ────────────────────────────────────────────

    it('rejects NAME exceeding MAX_FILE_NAME_LENGTH', async function () {
        const longName = 'n'.repeat(indexer.config['MAX_FILE_NAME_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', longName, 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('NAME'), `Expected NAME length error, got: ${data['STATUS']}`);
    });

    // ─── TYPE length limit ────────────────────────────────────────────

    it('rejects TYPE exceeding MAX_FILE_TYPE_LENGTH', async function () {
        const longType = 't'.repeat(indexer.config['MAX_FILE_TYPE_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.bin', longType, 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('TYPE'), `Expected TYPE length error, got: ${data['STATUS']}`);
    });

    // ─── TITLE length limit ───────────────────────────────────────────

    it('rejects TITLE exceeding MAX_FILE_TITLE_LENGTH', async function () {
        const longTitle = 'T'.repeat(indexer.config['MAX_FILE_TITLE_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', longTitle, ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('TITLE'), `Expected TITLE length error, got: ${data['STATUS']}`);
    });

    // ─── SOURCE sleeping check ────────────────────────────────────────

    it('rejects when SOURCE is sleeping', async function () {
        indexer.indexerDb.isActionAllowed.resolves(false);
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('SOURCE'), `Expected SOURCE sleeping error, got: ${data['STATUS']}`);
    });

    // ─── Side-effect checks ───────────────────────────────────────────

    it('calls createFile on the indexerDb', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(indexer.indexerDb.createFile.calledOnce);
    });

    it('calls mapper.createMappings after parse', async function () {
        const data = createBaseData({ ACTION: 'FILE', FORMAT: 0 });
        const params = ['0', 'test.txt', 'text/plain', 'Title', ''];
        await handler.parse(params, data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });
});
