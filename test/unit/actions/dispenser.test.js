process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Dispenser = require('../../../src/actions/dispenser.js');

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

function makeParams(str) {
    return String(str).split('|');
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('Dispenser action handler @regression @tier2', function () {
    let indexer;
    let actionsCtx;
    let dispenser;

    const OWNER_ADDR = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';
    const OTHER_ADDR = '1DestAddressXXXXXXXXXXXXXXXXXaKc5Z';
    const BLOCK_TIME  = 1700000000;
    const EXPIRATION  = BLOCK_TIME + 86400 * 30; // 30 days later

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        dispenser  = new Dispenser(actionsCtx);

        // Default GIVE token exists
        indexer.indexerDb.getTokenInfo
            .withArgs('JDOG', sinon.match.any, sinon.match.any)
            .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null }));

        // Default GET token (coin-denominated; GET_TICK empty so getTokenInfo returns null — that is fine)
        indexer.indexerDb.getTokenInfo
            .withArgs('', sinon.match.any, sinon.match.any)
            .resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(null, sinon.match.any, sinon.match.any)
            .resolves(null);
        indexer.indexerDb.getTokenInfo
            .withArgs(undefined, sinon.match.any, sinon.match.any)
            .resolves(null);

        // Default: sufficient balance (TICK_ID 10 → 1000 tokens)
        indexer.indexerDb.getAddressBalances.resolves({ 10: '1000' });

        // Default: not sleeping, action allowed
        indexer.indexerDb.isActionAllowed.resolves(true);

        // Default preferences
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });

        // Fee tick id
        indexer.indexerDb.getTickerId.resolves(99);
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── Format 0 — Create Dispenser ───────────────────────────────────────

    describe('Format 0 – Create Dispenser', function () {

        it('valid dispenser creation calls createDispenser and createDispenserStatus', async function () {
            // FORMAT: 0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||Creating JDOG dispenser`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenser);
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserStatus);
        });

        it('valid dispenser escrow deducts GIVE_ESCROW from SOURCE balance', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            sinon.assert.calledOnce(indexer.indexerDb.updateBalances);
            sinon.assert.calledOnce(indexer.indexerDb.updateTokens);
        });

        it('GIVE_TICK not found returns invalid', async function () {
            indexer.indexerDb.getTokenInfo
                .withArgs('UNKNOWN', sinon.match.any, sinon.match.any)
                .resolves(null);

            const params = makeParams(`0|BTC|UNKNOWN|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GIVE_TICK'));
            // createDispenser is always called (records the invalid attempt); ledger changes are skipped
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });

        it('invalid GET_ADDRESS format returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|not-a-valid-address||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GET_ADDRESS'));
        });

        it('insufficient balance for GIVE_ESCROW returns invalid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 10: '0' });

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('insufficient funds'));
        });

        it('EXPIRATION before BLOCK_TIME returns invalid', async function () {
            const pastExpiry = BLOCK_TIME - 1000;
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${pastExpiry}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('EXPIRATION'));
        });

        it('EXPIRATION equal to BLOCK_TIME returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${BLOCK_TIME}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('EXPIRATION'));
        });

        it('GIVE_COIN not matching COIN config returns invalid', async function () {
            const params = makeParams(`0|LTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].startsWith('invalid'));
        });

        it('GET_COIN not matching COIN config returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|LTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].startsWith('invalid'));
        });

        it('SOURCE sleeping returns invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .withArgs(OWNER_ADDR, null, sinon.match.any)
                .resolves(false);

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('SOURCE'));
        });

        it('TICK sleeping returns invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .withArgs(null, 'JDOG', sinon.match.any)
                .resolves(false);

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('TICK'));
        });

        it('invalid FIAT_CODE returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}|XXX|100.00||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('FIAT_CODE'));
        });

        it('pre-existing error short-circuits processing', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, 'invalid: pre-existing');

            // createDispenser is always called (records the attempt); but ledger changes are not applied
            assert.ok(data['STATUS'].includes('pre-existing'));
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });
    });

    // ─── Format 1 — Cancel Dispenser ───────────────────────────────────────

    describe('Format 1 – Cancel Dispenser', function () {

        function makeDispenserInfo(overrides = {}) {
            return {
                ACTION_INDEX:       50,
                SOURCE:             OWNER_ADDR,
                GET_ADDRESS:        OWNER_ADDR,
                GIVE_COIN:          'BTC',
                GIVE_TICK:          'JDOG',
                GET_COIN:           'BTC',
                GET_TICK:           null,
                GIVE_REMAINING:     '10',
                DISPENSER_STATUS:   'open',
                EXPIRATION:         EXPIRATION,
                BLOCK_TIME:         BLOCK_TIME,
                ALLOW_LIST:         null,
                BLOCK_LIST:         null,
                ...overrides,
            };
        }

        beforeEach(function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());
        });

        it('owner cancels open dispenser returns valid', async function () {
            const params = makeParams('1|50|Closing dispenser');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserCancel);
        });

        it('cancel sets dispenser status to cancelling', async function () {
            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            const statusCall = indexer.indexerDb.createDispenserStatus.firstCall;
            assert.ok(statusCall, 'createDispenserStatus should have been called');
            assert.strictEqual(statusCall.args[2], 'cancelling');
        });

        it('cancel by non-owner returns invalid', async function () {
            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OTHER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            // createDispenserCancel is always called (records the attempt); ledger changes are skipped
            assert.ok(data['STATUS'].includes('SOURCE'));
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });

        it('cancel of unknown dispenser (getDispenserInfo returns null) throws before validation', async function () {
            // When dispenserInfo is null, the code crashes at line 99 of dispenser.js (info['GIVE_TICK'])
            // before the validation check can run — this is a known code limitation.
            // We verify that the error is propagated as a rejection.
            indexer.indexerDb.getDispenserInfo.resolves(null);

            const params = makeParams('1|9999|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await assert.rejects(
                () => dispenser.parse(params, data, false),
                (err) => {
                    assert.ok(err instanceof TypeError);
                    return true;
                }
            );
        });

        it('cancel of non-open dispenser returns invalid', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ DISPENSER_STATUS: 'closed' }));

            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('DISPENSER_ACTION_INDEX'));
        });

        it('valid cancel updates action index to DISPENSER_CANCEL', async function () {
            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            sinon.assert.calledWith(indexer.indexerDb.updateActionIndex, sinon.match.any, 'DISPENSER_CANCEL');
        });
    });

    // ─── Format 2 — Edit Dispenser ─────────────────────────────────────────

    describe('Format 2 – Edit Dispenser', function () {

        function makeDispenserInfo(overrides = {}) {
            return {
                ACTION_INDEX:     50,
                SOURCE:           OWNER_ADDR,
                GET_ADDRESS:      OWNER_ADDR,
                GIVE_COIN:        'BTC',
                GIVE_TICK:        'JDOG',
                GIVE_REMAINING:   '10',
                GET_COIN:         'BTC',
                GET_TICK:         null,
                DISPENSER_STATUS: 'open',
                EXPIRATION:       EXPIRATION,
                BLOCK_TIME:       BLOCK_TIME,
                ALLOW_LIST:       null,
                BLOCK_LIST:       null,
                ...overrides,
            };
        }

        beforeEach(function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());
        });

        it('owner edits open dispenser returns valid and calls createDispenserEdit', async function () {
            // Add 20 more to escrow, extend expiration
            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||Refilling`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserEdit);
        });

        it('non-owner edit returns invalid', async function () {
            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OTHER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('SOURCE'));
        });

        it('edit of unknown dispenser (getDispenserInfo returns null) throws before validation', async function () {
            // When dispenserInfo is null, the code crashes at info['GIVE_TICK'] before validation.
            indexer.indexerDb.getDispenserInfo.resolves(null);

            const params = makeParams(`2|9999|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await assert.rejects(
                () => dispenser.parse(params, data, false),
                (err) => {
                    assert.ok(err instanceof TypeError);
                    return true;
                }
            );
        });

        it('edit of non-open dispenser returns invalid', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ DISPENSER_STATUS: 'closed' }));

            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('DISPENSER_ACTION_INDEX'));
        });

        it('edit escrow deducted when GIVE_ESCROW provided', async function () {
            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            sinon.assert.calledOnce(indexer.indexerDb.updateBalances);
        });

        it('valid edit updates action index to DISPENSER_EDIT', async function () {
            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            sinon.assert.calledWith(indexer.indexerDb.updateActionIndex, sinon.match.any, 'DISPENSER_EDIT');
        });
    });

    // ─── Unknown format ────────────────────────────────────────────────────

    describe('Unknown format', function () {
        it('unknown VERSION returns invalid', async function () {
            const params = makeParams('9|BTC|JDOG|1||10|BTC||0.01|||');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 9, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('invalid'));
        });
    });
});
