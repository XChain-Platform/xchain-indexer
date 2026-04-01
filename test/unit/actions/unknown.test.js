process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Unknown = require('../../../src/actions/unknown.js');

describe('Unknown action handler @regression @tier3', function () {
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
        handler = new Unknown(actionsCtx);
        indexer.util.resetLists();
    });

    // ─── Status set to 'invvalid' (intentional typo in source) ───────

    it('sets STATUS to invvalid when no incoming error', async function () {
        const data = createBaseData({ ACTION: 'UNKNOWN' });
        await handler.parse(null, data, null);
        assert.strictEqual(data['STATUS'], 'invvalid');
    });

    it('sets STATUS to the incoming error string when error is provided', async function () {
        const data = createBaseData({ ACTION: 'UNKNOWN' });
        await handler.parse(null, data, 'invalid: something went wrong');
        assert.strictEqual(data['STATUS'], 'invalid: something went wrong');
    });

    it('preserves any non-null error value as STATUS', async function () {
        const data = createBaseData({ ACTION: 'UNKNOWN' });
        await handler.parse(null, data, 'custom error message');
        assert.strictEqual(data['STATUS'], 'custom error message');
    });

    // ─── addAddressTicker called ──────────────────────────────────────

    it('adds SOURCE to the addresses list', async function () {
        const data = createBaseData({ ACTION: 'UNKNOWN', SOURCE: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt' });
        await handler.parse(null, data, null);
        const addresses = indexer.util.getAddressesList();
        assert.ok(Object.keys(addresses).includes(data['SOURCE']), 'SOURCE should be in addresses list');
    });

    // ─── createMappings called ────────────────────────────────────────

    it('calls mapper.createMappings', async function () {
        const data = createBaseData({ ACTION: 'UNKNOWN' });
        await handler.parse(null, data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });

    it('calls mapper.createMappings even when an error is passed in', async function () {
        const data = createBaseData({ ACTION: 'UNKNOWN' });
        await handler.parse(null, data, 'some prior error');
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });
});
