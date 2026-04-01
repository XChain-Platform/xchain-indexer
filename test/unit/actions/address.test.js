process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Address = require('../../../src/actions/address.js');

describe('Address action handler @regression @tier3', function () {
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
        handler = new Address(actionsCtx);
        // Reset util lists between tests
        indexer.util.resetLists();
    });

    function makeParams(feePreference, requireMemo, memo) {
        return ['0', String(feePreference), String(requireMemo), memo !== undefined ? memo : ''];
    }

    // ─── FEE_PREFERENCE validations ──────────────────────────────────

    it('accepts FEE_PREFERENCE=0', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, ''), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('accepts FEE_PREFERENCE=1', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(1, 0, ''), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('accepts FEE_PREFERENCE=2', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(2, 0, ''), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects FEE_PREFERENCE=3 as invalid value', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(3, 0, ''), data, null);
        assert.ok(data['STATUS'].includes('FEE_PREFERENCE'), `Expected FEE_PREFERENCE error, got: ${data['STATUS']}`);
    });

    it('rejects FEE_PREFERENCE=5 (out of valid range)', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        const params = ['0', '5', '0', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('FEE_PREFERENCE'), `Expected FEE_PREFERENCE error, got: ${data['STATUS']}`);
    });

    // ─── REQUIRE_MEMO validations ─────────────────────────────────────

    it('accepts REQUIRE_MEMO=0', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, ''), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('accepts REQUIRE_MEMO=1', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 1, ''), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects REQUIRE_MEMO=2 as invalid value', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 2, ''), data, null);
        assert.ok(data['STATUS'].includes('REQUIRE_MEMO'), `Expected REQUIRE_MEMO error, got: ${data['STATUS']}`);
    });

    // ─── MEMO validations ─────────────────────────────────────────────

    it('rejects MEMO containing a pipe character', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, 'bad|memo'), data, null);
        assert.ok(data['STATUS'].includes('MEMO'), `Expected MEMO error, got: ${data['STATUS']}`);
    });

    it('rejects MEMO containing a semicolon', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, 'bad;memo'), data, null);
        assert.ok(data['STATUS'].includes('MEMO'), `Expected MEMO error, got: ${data['STATUS']}`);
    });

    it('rejects MEMO exceeding MAX_MEMO_LENGTH', async function () {
        const longMemo = 'x'.repeat(indexer.config['MAX_MEMO_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, longMemo), data, null);
        assert.ok(data['STATUS'].includes('MEMO'), `Expected MEMO length error, got: ${data['STATUS']}`);
    });

    // ─── SOURCE sleeping check ────────────────────────────────────────

    it('rejects when SOURCE is sleeping', async function () {
        indexer.indexerDb.isActionAllowed.resolves(false);
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, ''), data, null);
        assert.ok(data['STATUS'].includes('SOURCE'), `Expected SOURCE sleeping error, got: ${data['STATUS']}`);
    });

    // ─── Side-effect checks ───────────────────────────────────────────

    it('calls createAddressOption on the indexerDb', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, 'hello'), data, null);
        assert.ok(indexer.indexerDb.createAddressOption.calledOnce);
    });

    it('calls mapper.createMappings after parse', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, ''), data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });
});
