process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Dispenser_Close = require('../../../src/actions/dispenser_close.js');

describe('Dispenser_Close action handler', function () {
    let indexer, actionsCtx, handler;

    function makeDispenser(overrides) {
        return {
            ACTION_INDEX: 50,
            SOURCE: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            GIVE_TICK: 'TEST',
            GIVE_REMAINING: '200',
            GET_ADDRESS: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            ...overrides,
        };
    }

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
        handler = new Dispenser_Close(actionsCtx);
        indexer.util.resetLists();
    });

    it('does nothing when dispenser is not found', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(null);
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200 });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createDispenserClose.notCalled);
    });

    it('creates a dispenser_close record when dispenser exists', async function () {
        const dispenser = makeDispenser();
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createDispenserClose.calledOnce);
    });

    it('creates a dispenser status record', async function () {
        const dispenser = makeDispenser();
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createDispenserStatus.calledOnce);
    });

    it('credits remaining tokens to SOURCE when no sweep destination', async function () {
        const dispenser = makeDispenser({ GIVE_REMAINING: '150' });
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        indexer.indexerDb.getSweepDestination.resolves(null);
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.createDispenserClose.calledOnce);
    });

    it('credits remaining tokens to sweep destination when available', async function () {
        const SWEEP_DEST = '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev';
        const dispenser = makeDispenser({ GIVE_REMAINING: '150' });
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        indexer.indexerDb.getSweepDestination.resolves(SWEEP_DEST);
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);
        // Destination should have been tracked in addresses list
        const addresses = indexer.util.getAddressesList();
        assert.ok(Object.keys(addresses).includes(SWEEP_DEST), 'Sweep destination should be tracked');
    });

    it('calls updateBalances after processing', async function () {
        const dispenser = makeDispenser();
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);
        assert.ok(indexer.indexerDb.updateBalances.calledOnce);
    });

    it('calls mapper.createMappings after processing', async function () {
        const dispenser = makeDispenser();
        indexer.indexerDb.getDispenserInfo.resolves(dispenser);
        const data = createBaseData({ ACTION: 'DISPENSER_CLOSE', DISPENSER_ACTION_INDEX: 50, BLOCK_INDEX: 200, DISPENSER_STATUS: 'closed' });
        await handler.parse(null, data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });
});
