// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Decision-F fee arithmetic (spec sec 10).
// Pins: (1) getUnifiedDurationFee is BYTE-IDENTICAL to the historical ORDER
// format-0 arithmetic (the extraction was a pure transplant); (2) the day
// count ROUNDS TO NEAREST (90.5d -> 91), the shipped mathjs fixed-precision
// behavior, so an implementer reaching for a floor forks from ORDER at every
// fractional-day boundary; (3) the spec sec-10 value table; (4) bcmuldivfloor,
// the parimutuel payout primitive, floors exactly and conserves.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert  = require('assert');
const sinon   = require('sinon');
const Utility = require('../../../src/utility');
const Bet     = require('../../../src/actions/bet');
const gateRegistry = require('../../../src/consensus/gate_registry');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const { ORACLE, ALICE, feedInfo } = require('../actions/bridge/bet.test/helpers/bet_fixtures.js');

const util = new Utility();
const T0 = 1800000000;
const EDIT_GATE = 'bet_feed_list_edit_activation.BET_FEED_LIST_EDIT_ACTIVATION';

function betEditHarness(feedOverrides = {}, listType = 2) {
    const indexer = createMockIndexer();
    const handler = new Bet({
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: indexer.protocolChanges,
        processAction: sinon.stub().resolves(),
    });
    indexer.util.resetLists();
    indexer.indexerDb.getBetFeedInfo.resolves(feedInfo(feedOverrides));
    indexer.indexerDb.getListType.resolves(listType);
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000' });
    sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();
    return { indexer, handler };
}

async function parseBetEdit(options = {}) {
    const { feed = {}, source = ORACLE, allow = '', block = '', listType = 2 } = options;
    const { indexer, handler } = betEditHarness(feed, listType);
    const data = createBaseData({ ACTION: 'BET', FORMAT: 4, SOURCE: source });
    await handler.parse(['4', '5', allow, block, ''], data, null);
    return { data, indexer, handler };
}

describe('BET format 4 parse and validation @regression @tier2', function () {
    afterEach(() => sinon.restore());

    it('recognizes the wire format and rejects it below the activation gate', async function () {
        const real = gateRegistry.activeAt;
        const activeAt = sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...rest) =>
            key === EDIT_GATE ? false : real(key, ...rest));
        const { data, handler, indexer } = await parseBetEdit({ allow: '9' });
        assert.strictEqual(handler.formats[4], 'VERSION|FEED_ACTION_INDEX|ALLOW_LIST|BLOCK_LIST|MEMO');
        assert.strictEqual(data['STATUS'], 'invalid: VERSION (unknown)');
        sinon.assert.calledWith(activeAt, EDIT_GATE, 'regtest', 'BTC', data['BLOCK_INDEX'], null);
        sinon.assert.notCalled(indexer.indexerDb.getListType);
    });

    it('allows the owner to retain one list and replace the other on an open feed', async function () {
        const { data, indexer } = await parseBetEdit({
            feed: { ALLOW_LIST: 7, BLOCK_LIST: 8 },
            block: '9',
        });
        assert.strictEqual(data['STATUS'], 'valid');
        sinon.assert.calledOnceWithExactly(indexer.indexerDb.getListType, '9', data['BLOCK_INDEX']);
    });

    it('treats zero as detach without looking up a list', async function () {
        const { data, indexer } = await parseBetEdit({
            feed: { ALLOW_LIST: 7, BLOCK_LIST: 8 },
            allow: '0',
        });
        assert.strictEqual(data['STATUS'], 'valid');
        sinon.assert.notCalled(indexer.indexerDb.getListType);
    });

    it('rejects an edit with both list fields blank', async function () {
        const { data } = await parseBetEdit();
        assert.strictEqual(data['STATUS'], 'invalid: ALLOW_LIST/BLOCK_LIST (empty)');
    });

    it('requires an existing open feed owned by the source', async function () {
        let result = await parseBetEdit({ source: ALICE, allow: '9' });
        assert.strictEqual(result.data['STATUS'], 'invalid: SOURCE (not owner)');
        sinon.restore();

        result = await parseBetEdit({ feed: { FEED_STATUS: 'closed' }, allow: '9' });
        assert.strictEqual(result.data['STATUS'], 'invalid: FEED_ACTION_INDEX (feed not open)');
        sinon.restore();

        const { indexer, handler } = betEditHarness();
        indexer.indexerDb.getBetFeedInfo.resolves(false);
        const data = createBaseData({ ACTION: 'BET', FORMAT: 4, SOURCE: ORACLE });
        await handler.parse(['4', '404', '9', '', ''], data, null);
        assert.strictEqual(data['STATUS'], 'invalid: FEED_ACTION_INDEX (unknown)');
    });

    it('rejects malformed, unknown, and unsupported list references', async function () {
        let result = await parseBetEdit({ allow: '-1' });
        assert.strictEqual(result.data['STATUS'], 'invalid: ALLOW_LIST (format)');
        sinon.restore();

        result = await parseBetEdit({ allow: '9', listType: false });
        assert.strictEqual(result.data['STATUS'], 'invalid: ALLOW_LIST (unknown)');
        sinon.restore();

        result = await parseBetEdit({ block: '9', listType: 1 });
        assert.strictEqual(result.data['STATUS'], 'invalid: BLOCK_LIST (unsupported)');
    });

    it('rejects equal effective allow and block list references', async function () {
        const { data } = await parseBetEdit({
            feed: { ALLOW_LIST: 7, BLOCK_LIST: 8 },
            block: '7',
        });
        assert.strictEqual(data['STATUS'], 'invalid: BLOCK_LIST (same as ALLOW_LIST)');
    });
});

describe('BET decision-F fee arithmetic @regression @tier2', function () {
    it('keeps list edits free like cancel and resolve', async function () {
        const fees = { AMOUNT: '9' };
        const applyFees = require('../../../src/actions/bet/fees.js').applyFees;
        const error = await applyFees.call({ util }, {}, 4, fees, {}, null, null);
        assert.strictEqual(error, null);
        assert.strictEqual(String(fees.AMOUNT), '0');
    });

    it('shares the ORDER duration arithmetic exactly across the free-window boundary', function () {
        for (const days of [1, 14, 44, 89, 90, 90.4, 90.5, 90.6, 91, 120, 365, 730]) {
            const until = T0 + Math.round(days * 86400);
            const viaOrder = util.getUnifiedExpirationFee({ FORMAT: 0, BLOCK_TIME: T0, EXPIRATION: until }, null);
            const viaBetKeyedToOrder = util.getUnifiedDurationFee(until, T0, 'EXPIRATION_PER_DAY');
            assert.strictEqual(String(viaBetKeyedToOrder.gasCost), String(viaOrder.gasCost), days + 'd gasCost');
            assert.strictEqual(String(viaBetKeyedToOrder.fee), String(viaOrder.fee), days + 'd fee');
        }
    });

    it('BET_FEED_PER_DAY defaults equal to EXPIRATION_PER_DAY, so the two families price alike today', function () {
        assert.strictEqual(util.config['GAS_SCHEDULE']['BET_FEED_PER_DAY'], util.config['GAS_SCHEDULE']['EXPIRATION_PER_DAY']);
        assert.strictEqual(util.config['GAS_SCHEDULE']['BET_PER_CREDIT'], 100);
        for (const days of [91, 365]) {
            const until = T0 + days * 86400;
            const bet   = util.getUnifiedDurationFee(until, T0, 'BET_FEED_PER_DAY');
            const order = util.getUnifiedDurationFee(until, T0, 'EXPIRATION_PER_DAY');
            assert.strictEqual(String(bet.fee), String(order.fee), days + 'd');
        }
    });

    it('day count rounds to nearest (the consensus trap): 90.4d free, 90.5d charges one day', function () {
        const at = f => util.getUnifiedDurationFee(T0 + Math.round(f * 86400), T0, 'BET_FEED_PER_DAY');
        assert.strictEqual(String(at(90.4).gasCost), '0');
        assert.strictEqual(String(at(90.5).gasCost), '550');
        assert.strictEqual(String(at(90.5).fee), '0.0055');
    });

    it('matches the spec section-10 value table', function () {
        const rows = [
            [14,  '0',      '0'],
            [44,  '0',      '0'],
            [90,  '0',      '0'],
            [91,  '550',    '0.0055'],
            [120, '16500',  '0.165'],
            [365, '151250', '1.5125'],
            [730, '352000', '3.52'],
        ];
        for (const [days, gas, fee] of rows) {
            const r = util.getUnifiedDurationFee(T0 + days * 86400, T0, 'BET_FEED_PER_DAY');
            assert.strictEqual(String(r.gasCost), gas, days + 'd gas');
            assert.strictEqual(String(r.fee), fee, days + 'd fee');
        }
    });
});

describe('BET decision-F fee arithmetic @regression @tier2', function () {
    describe('bcmuldivfloor (parimutuel payout primitive)', function () {

        it('computes the worked-example payouts exactly', function () {
            // stake * pot / W floored at 8dp: A = 10 * 17.325 / 12.5 = 13.86
            assert.strictEqual(String(util.bcmuldivfloor('10.00000000', '17.32500000', '12.50000000', 8)), '13.86');
            assert.strictEqual(String(util.bcmuldivfloor('2.50000000',  '17.32500000', '12.50000000', 8)), '3.465');
        });

        it('floors (never rounds up) and conserves: sum of floored payouts <= pot', function () {
            // 3 equal winners of 1/3 each: each gets floor(pot/3) and the sum
            // undershoots pot by <= 3 base units (the dust the oracle absorbs)
            const pot = '10.00000000';
            const each = util.bcmuldivfloor('1', pot, '3', 8);
            assert.strictEqual(String(each), '3.33333333');
            const sum = util.bcadd(util.bcadd(each, each, 8), each, 8);
            assert.ok(util.bclte(sum, pot));
            assert.strictEqual(String(util.bcsub(pot, sum, 8)), String(util.bcnum('0.00000001')));
        });

        it('zero-floors a dust winning stake in the rake case', function () {
            // ONE base unit * ~0.99 rake -> 9.9e-9 -> floors to 0 at 8 decimals
            assert.strictEqual(String(util.bcmuldivfloor('0.00000001', '9.90000000', '10.00000001', 8)), '0');
        });

        it('returns 0 on a zero divisor (bcdiv convention)', function () {
            assert.strictEqual(String(util.bcmuldivfloor('5', '5', '0', 8)), '0');
        });
    });
});
