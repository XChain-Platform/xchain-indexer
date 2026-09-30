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
// The list remove sentinel on the Version 2 edits of DISPENSER, ORDER and SWAP: at/after
// LIST_EDIT_REMOVE_ACTIVATION an edit carrying `0` in ALLOW_LIST or BLOCK_LIST is valid
// and stores 0; below it `0` is an unknown list exactly as before, and a create never
// takes it.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData, createMockIndexer, createTokenInfo } = require('../../../fixtures/mocks');
const dispenserHarness   = require('./dispenser.test/helpers/dispenser_harness.js');
const orderContext       = require('./order.test/helpers/order_context.js');

const Swap         = require('../../../../src/actions/swap/index.js');
const gateRegistry = require('../../../../src/consensus/gate_registry');

const REMOVE_KEY = 'list_edit_remove_activation.LIST_EDIT_REMOVE_ACTIVATION';
const { OWNER_ADDR, BLOCK_TIME, EXPIRATION, makeParams } = dispenserHarness;

// Hold only the remove row below its flag-day; every other gate reads as it does.
function removeInactive() {
    const real = gateRegistry.activeAt;
    sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...rest) => (key === REMOVE_KEY ? false : real(key, ...rest)));
}

// Arm only the BTC slot of the remove row, the shape a per-chain arming train writes.
function removeArmedForBtcOnly() {
    const real = gateRegistry.activeAt;
    sinon.stub(gateRegistry, 'activeAt').callsFake((key, network, coin, ...rest) =>
        (key === REMOVE_KEY ? coin === 'BTC' : real(key, network, coin, ...rest)));
}

function openRow(extra) {
    return Object.assign({
        SOURCE: OWNER_ADDR, GET_ADDRESS: OWNER_ADDR, GIVE_COIN: 'BTC', GET_COIN: 'BTC',
        EXPIRATION, BLOCK_TIME, ALLOW_LIST: 7, BLOCK_LIST: 8,
    }, extra);
}

// One edit per action, built on that action's own unit harness.
const CASES = [
    {
        name: 'DISPENSER', write: 'createDispenserEdit',
        build() {
            const h = dispenserHarness.createDispenserHarness();
            h.indexer.indexerDb.getDispenserInfo.resolves(openRow({ ACTION_INDEX: 50, GIVE_TICK: 'JDOG', GIVE_REMAINING: '10', GET_TICK: null, DISPENSER_STATUS: 'open' }));
            return { indexer: h.indexer, handler: h.dispenser };
        },
        edit: (allow, block) => makeParams(`2|50|||${allow}|${block}|`),
        create: () => makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|0||`),
    },
    {
        name: 'ORDER', write: 'createOrderEdit',
        build() {
            const h = orderContext.makeOrderContext();
            h.indexer.indexerDb.getOrderInfo.resolves(openRow({ ACTION_INDEX: 42, GIVE_TICK: 'RAREPEPE', GET_TICK: 'PEPECASH', ORDER_STATUS: 'open' }));
            return { indexer: h.indexer, handler: h.order };
        },
        edit: (allow, block) => makeParams(`2|42||${allow}|${block}|`),
    },
    {
        name: 'SWAP', write: 'createSwapEdit',
        build() {
            // The same stand-in swap.test.js builds: two known ticks and funded balances.
            const indexer = createMockIndexer();
            const handler = new Swap({
                config: indexer.config, util: indexer.util, mapper: indexer.mapper,
                decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb,
                protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
                processAction: sinon.stub().resolves(),
            });
            indexer.util.resetLists();
            const ticks = { GIVE: createTokenInfo({ TICK: 'GIVE', TICK_ID: 1, DECIMALS: 0 }), GET: createTokenInfo({ TICK: 'GET', TICK_ID: 2, DECIMALS: 0 }) };
            indexer.indexerDb.getTokenInfo.callsFake(async (tick) => ticks[tick] || null);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000', 99: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getTickerId.resolves(99);
            indexer.indexerDb.getSwapInfo.resolves(openRow({ ACTION_INDEX: 10, GIVE_TICK: 'GIVE', GIVE_AMOUNT: '10', GIVE_REMAINING: '10', GET_TICK: 'GET', GET_AMOUNT: '5', SWAP_STATUS: 'open' }));
            return { indexer, handler };
        },
        edit: (allow, block) => makeParams(`2|10||${allow}|${block}|`),
    },
];

async function runEdit(c, params, format = 2) {
    const { indexer, handler } = c.build();
    const data = createBaseData({ ACTION: c.name, FORMAT: format, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });
    await handler.parse(params, data, false);
    return { data, indexer };
}

for (const c of CASES) {
    describe(c.name + ' v2 edit list remove sentinel @regression @tier2', function () {
        afterEach(() => sinon.restore());

        it('at/after the flag-day an ALLOW_LIST of 0 is valid and stored as the removal', async function () {
            const { data, indexer } = await runEdit(c, c.edit('0', ''));
            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb[c.write]);
            assert.strictEqual(String(indexer.indexerDb[c.write].firstCall.args[0]['ALLOW_LIST']), '0');
            assert.ok(indexer.indexerDb.getListType.neverCalledWith('0'), 'a removal names no LIST to look up');
        });

        it('at/after the flag-day a BLOCK_LIST of 0 is valid too', async function () {
            const { data } = await runEdit(c, c.edit('', '0'));
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('follows an arm of the configured coin slot alone', async function () {
            removeArmedForBtcOnly();
            const { data } = await runEdit(c, c.edit('0', ''));
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('below the flag-day 0 is still an unknown list', async function () {
            removeInactive();
            const { data, indexer } = await runEdit(c, c.edit('0', ''));
            assert.strictEqual(data['STATUS'], 'invalid: ALLOW_LIST (unknown)');
            // An invalid edit is still recorded, with its invalid status, so the overlay never reads it
            sinon.assert.calledOnce(indexer.indexerDb[c.write]);
            assert.strictEqual(indexer.indexerDb[c.write].firstCall.args[0]['STATUS'], 'invalid: ALLOW_LIST (unknown)');
        });
    });
}

describe('list remove sentinel scope @regression @tier2', function () {
    afterEach(() => sinon.restore());

    it('a create (Version 0) never takes 0 as a list, even at/after the flag-day', async function () {
        const { data } = await runEdit(CASES[0], CASES[0].create(), 0);
        assert.strictEqual(data['STATUS'], 'invalid: ALLOW_LIST (unknown)');
    });

    it('the registry row is unarmed on mainnet and testnet and genesis-active on regtest', function () {
        assert.strictEqual(gateRegistry.activeAt(REMOVE_KEY, 'mainnet', 'BTC', null, 4102444800), false);
        assert.strictEqual(gateRegistry.activeAt(REMOVE_KEY, 'testnet', 'LTC', null, 4102444800), false);
        assert.strictEqual(gateRegistry.activeAt(REMOVE_KEY, 'regtest', 'BTC', null, 0), true);
    });
});
