process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../fixtures/mocks');

const Mapper = require('../../src/mapper.js');

describe('Mapper @regression @tier3', function () {
    let indexer, mapper;

    beforeEach(function () {
        indexer = createMockIndexer();
        mapper  = new Mapper(indexer);
        indexer.util.resetLists();
    });

    // ─── Address mappings ─────────────────────────────────────────────

    it('creates address mapping for a tracked address', async function () {
        indexer.util.addAddressTicker('1AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
        const data = createBaseData({ ACTION: 'SEND', ACTION_INDEX: 1, STATUS: 'valid' });
        await mapper.createMappings(data);
        assert.ok(indexer.indexerDb.createActionMapping.calledWith(1, 'address', '1AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
    });

    it('creates address mappings for multiple tracked addresses', async function () {
        indexer.util.addAddressTicker('1AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
        indexer.util.addAddressTicker('1AddrBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
        const data = createBaseData({ ACTION: 'SEND', ACTION_INDEX: 1, STATUS: 'valid' });
        await mapper.createMappings(data);
        const addressCalls = indexer.indexerDb.createActionMapping.args.filter(a => a[1] === 'address');
        assert.strictEqual(addressCalls.length, 2);
    });

    // ─── Tick mappings ────────────────────────────────────────────────

    it('creates tick mapping for a tracked ticker', async function () {
        indexer.util.addAddressTicker('1AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'TEST');
        const data = createBaseData({ ACTION: 'SEND', ACTION_INDEX: 1, STATUS: 'valid' });
        await mapper.createMappings(data);
        assert.ok(indexer.indexerDb.createActionMapping.calledWith(1, 'tick', 'TEST'));
    });

    it('creates tick mappings for multiple tickers on the same address', async function () {
        indexer.util.addAddressTicker('1AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ['TICK1', 'TICK2']);
        const data = createBaseData({ ACTION: 'SEND', ACTION_INDEX: 1, STATUS: 'valid' });
        await mapper.createMappings(data);
        const tickCalls = indexer.indexerDb.createActionMapping.args.filter(a => a[1] === 'tick');
        assert.strictEqual(tickCalls.length, 2);
    });

    // ─── No duplicate mappings ────────────────────────────────────────

    it('does not create duplicate address mappings', async function () {
        // Adding the same address twice should only produce one mapping
        indexer.util.addAddressTicker('1AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'TICK1');
        indexer.util.addAddressTicker('1AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'TICK2');
        const data = createBaseData({ ACTION: 'SEND', ACTION_INDEX: 1, STATUS: 'valid' });
        await mapper.createMappings(data);
        const addressCalls = indexer.indexerDb.createActionMapping.args.filter(a => a[1] === 'address');
        assert.strictEqual(addressCalls.length, 1);
    });

    it('does not create duplicate tick mappings', async function () {
        // Adding the same tick for two different addresses should only produce one tick mapping
        indexer.util.addAddressTicker('1AddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'SAME_TICK');
        indexer.util.addAddressTicker('1AddrBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'SAME_TICK');
        const data = createBaseData({ ACTION: 'SEND', ACTION_INDEX: 1, STATUS: 'valid' });
        await mapper.createMappings(data);
        const tickCalls = indexer.indexerDb.createActionMapping.args.filter(a => a[1] === 'tick' && a[2] === 'SAME_TICK');
        assert.strictEqual(tickCalls.length, 1);
    });

    it('does nothing when addresses list is empty', async function () {
        const data = createBaseData({ ACTION: 'SEND', ACTION_INDEX: 1, STATUS: 'valid' });
        await mapper.createMappings(data);
        assert.ok(indexer.indexerDb.createActionMapping.notCalled);
    });

    // ─── LINK FILE→TICK mapping ───────────────────────────────────────

    it('creates FILE→TICK mapping for valid LINK when owner matches', async function () {
        const FILE_INDEX  = 5;
        const ISSUE_INDEX = 6;
        const OWNER_ADDR  = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';
        const TOKEN_TICK  = 'MYTOKEN';

        indexer.indexerDb.getActionData.callsFake(async (actionIndex) => {
            if (actionIndex == FILE_INDEX)  return { action: 'FILE',  action_index: FILE_INDEX,  tick: null };
            if (actionIndex == ISSUE_INDEX) return { action: 'ISSUE', action_index: ISSUE_INDEX, tick: TOKEN_TICK };
            return null;
        });
        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: TOKEN_TICK, OWNER: OWNER_ADDR }));

        indexer.util.addAddressTicker(OWNER_ADDR);
        const data = createBaseData({
            ACTION: 'LINK',
            ACTION_INDEX: 10,
            STATUS: 'valid',
            SOURCE: OWNER_ADDR,
            COIN1: 'BTC',  COIN1_ACTION_INDEX: FILE_INDEX,
            COIN2: 'BTC',  COIN2_ACTION_INDEX: ISSUE_INDEX,
        });
        await mapper.createMappings(data);
        assert.ok(indexer.indexerDb.createFileMapping.calledWith(FILE_INDEX, 'tick', TOKEN_TICK));
    });

    it('does NOT create FILE→TICK mapping when LINK status is not valid', async function () {
        const OWNER_ADDR = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';
        indexer.util.addAddressTicker(OWNER_ADDR);
        const data = createBaseData({
            ACTION: 'LINK',
            ACTION_INDEX: 10,
            STATUS: 'invalid: something',
            SOURCE: OWNER_ADDR,
            COIN1: 'BTC', COIN1_ACTION_INDEX: 5,
            COIN2: 'BTC', COIN2_ACTION_INDEX: 6,
        });
        await mapper.createMappings(data);
        assert.ok(indexer.indexerDb.createFileMapping.notCalled);
    });

    it('does NOT create FILE→TICK mapping when SOURCE does not own the token', async function () {
        const FILE_INDEX  = 5;
        const ISSUE_INDEX = 6;
        const SOURCE_ADDR = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';
        const OWNER_ADDR  = '1DifferentOwnerXXXXXXXXXXXXXXXXXXXX';

        indexer.indexerDb.getActionData.callsFake(async (actionIndex) => {
            if (actionIndex == FILE_INDEX)  return { action: 'FILE',  action_index: FILE_INDEX,  tick: null };
            if (actionIndex == ISSUE_INDEX) return { action: 'ISSUE', action_index: ISSUE_INDEX, tick: 'MYTOKEN' };
            return null;
        });
        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'MYTOKEN', OWNER: OWNER_ADDR }));

        indexer.util.addAddressTicker(SOURCE_ADDR);
        const data = createBaseData({
            ACTION: 'LINK',
            ACTION_INDEX: 10,
            STATUS: 'valid',
            SOURCE: SOURCE_ADDR,
            COIN1: 'BTC', COIN1_ACTION_INDEX: FILE_INDEX,
            COIN2: 'BTC', COIN2_ACTION_INDEX: ISSUE_INDEX,
        });
        await mapper.createMappings(data);
        assert.ok(indexer.indexerDb.createFileMapping.notCalled);
    });
});
