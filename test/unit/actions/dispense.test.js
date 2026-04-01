process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Dispense = require('../../../src/actions/dispense.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// Canonical dispenser fixture used across tests
function makeDispenserInfo(overrides = {}) {
    return {
        ACTION_INDEX:   10,
        SOURCE:         '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
        GET_ADDRESS:    '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
        GIVE_COIN:      'BTC',
        GIVE_TICK:      'JDOG',
        GIVE_AMOUNT:    '1',        // dispense 1 JDOG per GET_AMOUNT unit
        GIVE_REMAINING: '10',       // 10 JDOG left in escrow
        GET_COIN:       'BTC',
        GET_TICK:       null,
        GET_AMOUNT:     '0.01',     // 0.01 BTC triggers 1 GIVE_AMOUNT
        ALLOW_LIST:     null,
        BLOCK_LIST:     null,
        DISPENSER_STATUS: 'open',
        ...overrides,
    };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('Dispense action handler @regression @tier2', function () {
    let indexer;
    let actionsCtx;
    let dispense;

    const OWNER_ADDR  = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';
    const BUYER_ADDR  = '1DestAddressXXXXXXXXXXXXXXXXXaKc5Z';
    const BLOCK_TIME  = 1700000000;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        dispense   = new Dispense(actionsCtx);

        // Default: findMatchingDispensers returns one dispenser action_index
        indexer.indexerDb.findMatchingDispensers.resolves([10]);

        // Default: getDispenserInfo returns the canonical dispenser
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());

        // Default: token info for GIVE and GET ticks
        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, ALLOW_LIST: null, BLOCK_LIST: null }));
        indexer.indexerDb.getTokenInfo
            .withArgs(null, sinon.match.any, sinon.match.any)
            .resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(undefined, sinon.match.any, sinon.match.any)
            .resolves(null);

        // Default: createActionIndex returns a new index
        indexer.indexerDb.createActionIndex.resolves(200);
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── No matching dispensers ───────────────────────────────────────────

    it('no matching dispensers — deleteActionIndex called, createDispense not called', async function () {
        indexer.indexerDb.findMatchingDispensers.resolves([]);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.deleteActionIndex);
        sinon.assert.notCalled(indexer.indexerDb.createDispense);
    });

    // ─── Valid dispense ───────────────────────────────────────────────────

    it('valid dispense — createDispense called with status valid', async function () {
        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01', // exactly 1x GET_AMOUNT → multiplier=1 → give_amount=1
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.createDispense);
        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(dispenseRecord['STATUS'], 'valid');
    });

    it('give_amount calculated from multiplier (2x payment)', async function () {
        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.02', // 2x GET_AMOUNT → multiplier=2 → give_amount=2
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        // give_amount = 2 * 1 (GIVE_AMOUNT) = 2
        assert.ok(String(dispenseRecord['GIVE_AMOUNT']) === '2' ||
                  parseFloat(dispenseRecord['GIVE_AMOUNT']) === 2,
                  `Expected give_amount 2, got ${dispenseRecord['GIVE_AMOUNT']}`);
    });

    it('multiplier capped so give_amount does not exceed GIVE_REMAINING', async function () {
        // GIVE_REMAINING is 3; payment is 0.05 (5x), but can only dispense 3
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_REMAINING: '3' }));

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.05',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        // give_amount should be <= GIVE_REMAINING
        assert.ok(parseFloat(dispenseRecord['GIVE_AMOUNT']) <= 3,
            `give_amount ${dispenseRecord['GIVE_AMOUNT']} exceeds GIVE_REMAINING 3`);
    });

    // ─── Insufficient COIN_AMOUNT ─────────────────────────────────────────

    it('COIN_AMOUNT less than GET_AMOUNT returns invalid dispense', async function () {
        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.005', // less than GET_AMOUNT (0.01)
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(dispenseRecord['STATUS'] !== 'valid',
            `Expected invalid status, got "${dispenseRecord['STATUS']}"`);
    });

    it('multiplier of zero (insufficient funds after loop) returns invalid', async function () {
        // GIVE_REMAINING is 0 so loop reduces multiplier to 0
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_REMAINING: '0' }));

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(dispenseRecord['STATUS'] !== 'valid');
    });

    // ─── Self-trigger prevention ──────────────────────────────────────────

    it('SOURCE same as GET_ADDRESS returns invalid dispense', async function () {
        // Buyer IS the dispenser owner → self-trigger not allowed
        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      OWNER_ADDR, // same as dispenser GET_ADDRESS
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(dispenseRecord['STATUS'] !== 'valid',
            `Expected invalid status for self-trigger, got "${dispenseRecord['STATUS']}"`);
    });

    // ─── Auto-close when GIVE_REMAINING exhausted ────────────────────────

    it('auto-close triggered when GIVE_REMAINING falls below GIVE_AMOUNT after dispense', async function () {
        // GIVE_REMAINING=1, GIVE_AMOUNT=1: after dispensing 1, remaining=0 < GIVE_AMOUNT=1
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            GIVE_AMOUNT:    '1',
            GIVE_REMAINING: '1',
        }));

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledOnce(actionsCtx.processAction);
        const [actionName] = actionsCtx.processAction.firstCall.args;
        assert.strictEqual(actionName, 'DISPENSER_CLOSE');
    });

    it('no auto-close when GIVE_REMAINING still >= GIVE_AMOUNT after dispense', async function () {
        // GIVE_REMAINING=10, GIVE_AMOUNT=1: after dispensing 1, remaining=9 >= 1 → no close
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            GIVE_AMOUNT:    '1',
            GIVE_REMAINING: '10',
        }));

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.notCalled(actionsCtx.processAction);
    });

    // ─── Allow/block list checks ─────────────────────────────────────────

    it('dispenser ALLOW_LIST excludes SOURCE — dispense invalid', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ ALLOW_LIST: '5' }));
        // The list does NOT include BUYER_ADDR
        indexer.indexerDb.getList.resolves([OWNER_ADDR]);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(dispenseRecord['STATUS'] !== 'valid');
    });

    it('dispenser BLOCK_LIST includes SOURCE — dispense invalid', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ BLOCK_LIST: '6' }));
        // BLOCK_LIST includes BUYER_ADDR
        indexer.indexerDb.getList.resolves([BUYER_ADDR]);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(dispenseRecord['STATUS'] !== 'valid');
    });

    it('GIVE_TOKEN ALLOW_LIST includes SOURCE — dispense valid', async function () {
        // Give token has an ALLOW_LIST that includes both BUYER and OWNER
        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({
                TICK:       'JDOG',
                TICK_ID:    10,
                ALLOW_LIST: '3',
                BLOCK_LIST: null,
            }));
        // Both addresses in allow list
        indexer.indexerDb.getList.resolves([BUYER_ADDR, OWNER_ADDR]);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(dispenseRecord['STATUS'], 'valid');
    });

    it('GIVE_TOKEN BLOCK_LIST includes SOURCE — dispense invalid', async function () {
        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({
                TICK:       'JDOG',
                TICK_ID:    10,
                ALLOW_LIST: null,
                BLOCK_LIST: '4',
            }));
        // BUYER is on block list
        indexer.indexerDb.getList.resolves([BUYER_ADDR]);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        const dispenseRecord = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.ok(dispenseRecord['STATUS'] !== 'valid');
    });

    // ─── Multiple dispensers ──────────────────────────────────────────────

    it('multiple matching dispensers — createDispense called for each', async function () {
        const dispenser2 = makeDispenserInfo({ ACTION_INDEX: 11, GET_ADDRESS: OWNER_ADDR });
        indexer.indexerDb.findMatchingDispensers.resolves([10, 11]);
        indexer.indexerDb.getDispenserInfo
            .withArgs('BTC', 10, sinon.match.any)
            .resolves(makeDispenserInfo());
        indexer.indexerDb.getDispenserInfo
            .withArgs('BTC', 11, sinon.match.any)
            .resolves(dispenser2);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        assert.ok(indexer.indexerDb.createDispense.callCount >= 2,
            `Expected createDispense called >=2, got ${indexer.indexerDb.createDispense.callCount}`);
    });

    // ─── Ledger changes ───────────────────────────────────────────────────

    it('valid dispense processes ledger changes and updates balances', async function () {
        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.updateBalances);
    });

    it('valid dispense creates action mappings', async function () {
        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledOnce(indexer.mapper.createMappings);
    });
});
