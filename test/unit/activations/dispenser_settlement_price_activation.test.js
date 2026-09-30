/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/activations/dispenser_settlement_price_activation.test.js
 *
 * FIAT dispenser admission against the prices DISPENSE settles with. A DISPENSE
 * prices a Mode A dispenser from a validator snapshot inside
 * [block_time - FIAT_DISPENSER_PRICE_WINDOW, block_time], and a Mode B dispenser
 * from an oracle price inside that window paired with a validator price at most one
 * window older than the oracle price's effective_at. Creates and refills used to be
 * accepted without either, opening dispensers whose every payment was rejected
 * while the buyer's coin stayed with the seller.
 *
 * The gate row (dispenser_settlement_price_activation.DISPENSER_SETTLEMENT_PRICE_ACTIVATION)
 * is genesis-active on regtest and unarmed on mainnet and testnet, so these cases run
 * above it unless the registry read is stubbed off.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const gateRegistry = require('../../../src/consensus/gate_registry');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');
const Dispenser = require('../../../src/actions/dispenser/index.js');

const GATE_KEY    = 'dispenser_settlement_price_activation.DISPENSER_SETTLEMENT_PRICE_ACTIVATION';
const OWNER_ADDR  = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const ORACLE_ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const WINDOW      = 86400;
const HOUR        = 3600;

// The reported DOGE testnet case: the oracle's only price took effect at
// 1790276557 (2026-09-24 19:02:37 UTC) and the create was dry-run at about
// 2026-09-25 21:10 UTC, 26 hours later.
const PRICE_EFFECTIVE_AT = 1790276557;
const BLOCK_TIME         = 1790370600;
const EXPIRATION         = BLOCK_TIME + WINDOW * 30;

const STALE      = 'invalid: ORACLE_ADDRESS (stale oracle price)';
const UNPAIRED   = 'invalid: ORACLE_ADDRESS (no validator price pairs with the oracle price)';
const NO_SNAPSHOT = 'invalid: FIAT_CODE (no price snapshot in the settlement window)';

const params = (s) => String(s).split('|');
const MODE_B_CREATE = () => params(`0|BTC|JDOG||1||BTC||0.01|${OWNER_ADDR}|USD||${ORACLE_ADDR}|${EXPIRATION}|||Ownership Mode B`);
const MODE_A_CREATE = () => params(`0|BTC|JDOG|1|0|10|BTC||0.01|${OWNER_ADDR}|USD|0.05||${EXPIRATION}|||Mode A`);
const REFILL        = () => params(`2|50|20|${EXPIRATION + WINDOW}|||`);
const EXPIRY_EDIT   = () => params(`2|50||${EXPIRATION + WINDOW}|||`);

// An in-memory price store answering the three reads with the SQL's own bounds:
// BETWEEN is inclusive, newest first, and getOraclePrice is the newest effective row.
function priceStore(oracleRows, validatorRows){
    const newestFirst = (rows, key) => rows.slice().sort((a, b) => b[key] - a[key]);
    return {
        getOraclePrice: sinon.stub().callsFake(async (a, c, t, f, blockTime) =>
            newestFirst(oracleRows, 'effectiveAt').find((r) => r.effectiveAt <= blockTime) || null),
        getOraclePricesInTimeRange: sinon.stub().callsFake(async (a, c, t, f, start, end) =>
            newestFirst(oracleRows, 'effectiveAt').filter((r) => r.effectiveAt >= start && r.effectiveAt <= end)),
        getPricesInTimeRange: sinon.stub().callsFake(async (pair, start, end) =>
            newestFirst(validatorRows, 'timestamp').filter((r) => r.timestamp >= start && r.timestamp <= end)),
    };
}
const oracle    = (effectiveAt) => ({ price: '0.05', value: '0.05', fee: '0', effectiveAt });
const validator = (timestamp) => ({ price: '50000', timestamp });

// A dispenser handler over a mock indexer holding these price rows. Format 2 edits
// target a FIAT dispenser built from `existing` (Mode A unless it names an oracle).
function setup(oracleRows, validatorRows, existing = {}){
    const indexer = createMockIndexer();
    const dispenser = new Dispenser({
        config: indexer.config, util: indexer.util, mapper: indexer.mapper,
        decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb,
        protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
        processAction: sinon.stub().resolves(),
    });
    const db = indexer.indexerDb;
    db.getTokenInfo.withArgs('JDOG', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0,
            ALLOW_LIST: null, BLOCK_LIST: null, OWNER: OWNER_ADDR }));
    for (const empty of ['', null, undefined])
        db.getTokenInfo.withArgs(empty, sinon.match.any, sinon.match.any).resolves(null);
    db.getAddressBalances.resolves({ 10: '1000', 99: '999999999' });
    db.isActionAllowed.resolves(true);
    db.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    db.getTickerId.resolves(99);
    db.isOwnershipEscrowed.resolves(false);
    db.setTokenEscrow = sinon.stub().resolves();
    db.getDispenserInfo.resolves({ ACTION_INDEX: 50, SOURCE: OWNER_ADDR, GET_ADDRESS: OWNER_ADDR,
        GIVE_COIN: 'BTC', GIVE_TICK: 'JDOG', GIVE_REMAINING: '10', GET_COIN: 'BTC', GET_TICK: null,
        DISPENSER_STATUS: 'open', EXPIRATION, BLOCK_TIME: BLOCK_TIME - WINDOW, ALLOW_LIST: null,
        BLOCK_LIST: null, FIAT: 'USD', FIAT_AMOUNT: '0.05', ORACLE_ADDRESS: null, ...existing });
    Object.assign(db, priceStore(oracleRows, validatorRows));
    return { indexer, dispenser, db };
}

async function run(paramsList, oracleRows, validatorRows, existing){
    const { dispenser, db } = setup(oracleRows, validatorRows, existing);
    const format = Number(paramsList[0]);
    const data = createBaseData({ ACTION: 'DISPENSER', FORMAT: format, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });
    await dispenser.parse(paramsList, data, false);
    return { data, db };
}

describe('Mode B create needs an oracle price DISPENSE can settle against @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('rejects the reported case: the only price took effect 26 hours before the create', async function () {
        const { data, db } = await run(MODE_B_CREATE(), [oracle(PRICE_EFFECTIVE_AT)], [validator(BLOCK_TIME - HOUR)]);
        assert.strictEqual(data['STATUS'], STALE);
        sinon.assert.notCalled(db.setTokenEscrow);
    });

    it('rejects a fresh oracle price with no validator price at or before it', async function () {
        // Oracle effective 23h ago, validator snapshot only 1h ago: settlement pairs an
        // oracle row with a validator row no newer than its effective_at, so none pairs.
        const { data } = await run(MODE_B_CREATE(), [oracle(BLOCK_TIME - 23 * HOUR)], [validator(BLOCK_TIME - HOUR)]);
        assert.strictEqual(data['STATUS'], UNPAIRED);
    });

    it('accepts an oracle price exactly at the window edge with a validator price paired to it', async function () {
        const edge = BLOCK_TIME - WINDOW;
        const { data, db } = await run(MODE_B_CREATE(), [oracle(edge)], [validator(edge - WINDOW)]);
        assert.strictEqual(data['STATUS'], 'valid', data['STATUS']);
        sinon.assert.calledOnce(db.setTokenEscrow);
    });
});

describe('Mode A create needs a validator snapshot DISPENSE can settle against @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('rejects a create when the newest snapshot is older than the settlement window', async function () {
        const { data } = await run(MODE_A_CREATE(), [], [validator(BLOCK_TIME - WINDOW - 1)]);
        assert.strictEqual(data['STATUS'], NO_SNAPSHOT);
    });

    it('accepts a create with a snapshot exactly at the window edge', async function () {
        const { data } = await run(MODE_A_CREATE(), [], [validator(BLOCK_TIME - WINDOW)]);
        assert.strictEqual(data['STATUS'], 'valid', data['STATUS']);
    });
});

describe('FIAT refill needs a price DISPENSE can settle against @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('rejects a Mode A refill with no snapshot in the window', async function () {
        const { data, db } = await run(REFILL(), [], []);
        assert.strictEqual(data['STATUS'], NO_SNAPSHOT);
        sinon.assert.notCalled(db.updateBalances);
    });

    it('rejects a Mode B refill whose oracle has gone stale', async function () {
        const { data } = await run(REFILL(), [oracle(PRICE_EFFECTIVE_AT)], [validator(BLOCK_TIME - HOUR)],
            { ORACLE_ADDRESS: ORACLE_ADDR, FIAT_AMOUNT: null });
        assert.strictEqual(data['STATUS'], STALE);
    });

    it('accepts a Mode A refill with a fresh snapshot', async function () {
        const { data } = await run(REFILL(), [], [validator(BLOCK_TIME - HOUR)]);
        assert.strictEqual(data['STATUS'], 'valid', data['STATUS']);
    });

    it('still accepts an edit that adds no escrow, so an owner can extend or relist an unpriced dispenser', async function () {
        const { data } = await run(EXPIRY_EDIT(), [], []);
        assert.strictEqual(data['STATUS'], 'valid', data['STATUS']);
    });
});

describe('FIAT admission below the settlement price gate @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('still accepts the stale Mode B create and the unpriced Mode A create below the gate', async function () {
        sinon.stub(gateRegistry, 'activeAt').callThrough().withArgs(GATE_KEY).returns(false);
        const modeB = await run(MODE_B_CREATE(), [oracle(PRICE_EFFECTIVE_AT)], [validator(BLOCK_TIME - HOUR)]);
        assert.strictEqual(modeB.data['STATUS'], 'valid', modeB.data['STATUS']);
        const modeA = await run(MODE_A_CREATE(), [], []);
        assert.strictEqual(modeA.data['STATUS'], 'valid', modeA.data['STATUS']);
    });

    it('is armed from genesis on regtest and unarmed on mainnet and testnet', function () {
        assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'regtest', null, null, 0), true);
        assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'mainnet', null, null, BLOCK_TIME), false);
        assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'testnet', null, null, BLOCK_TIME), false);
    });
});

// The admission helper against the real DISPENSE matchers over the same rows: a create
// is admitted exactly when a large enough payment at that block would be priced.
describe('findSettlementPriceGap agrees with the DISPENSE matchers @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    const T = BLOCK_TIME;
    const CASES = [
        ['stale oracle',             [oracle(T - WINDOW - 1)],          [validator(T - WINDOW - 2)]],
        ['oracle at the edge',       [oracle(T - WINDOW)],              [validator(T - 2 * WINDOW)]],
        ['validator after oracle',   [oracle(T - 23 * HOUR)],           [validator(T - HOUR)]],
        ['validator too old',        [oracle(T - HOUR)],                [validator(T - HOUR - WINDOW - 1)]],
        ['second row pairs',         [oracle(T - HOUR), oracle(T - 20 * HOUR)], [validator(T - 21 * HOUR)]],
        ['fresh pair',               [oracle(T - HOUR)],                [validator(T - 2 * HOUR)]],
        ['no rows',                  [],                                []],
    ];

    for (const [name, oracleRows, validatorRows] of CASES) {
        it('Mode B: ' + name, async function () {
            const { indexer, db } = setup(oracleRows, validatorRows);
            const gap = await indexer.util.findSettlementPriceGap({ FIAT: 'USD', ORACLE_ADDRESS: ORACLE_ADDR,
                GIVE_COIN: 'BTC', GIVE_TICK: 'JDOG', GET_COIN: 'BTC' }, T, WINDOW, db);
            const match = await indexer.util.reverseOraclePriceMatch('1000', ORACLE_ADDR, 'BTC', 'JDOG', 'USD', T, WINDOW, db, 'BTC');
            assert.strictEqual(gap === null, match !== null, name + ': gap ' + gap);
        });

        it('Mode A: ' + name, async function () {
            const { indexer, db } = setup(oracleRows, validatorRows);
            const gap = await indexer.util.findSettlementPriceGap({ FIAT: 'USD', ORACLE_ADDRESS: null,
                GIVE_COIN: 'BTC', GIVE_TICK: 'JDOG', GET_COIN: 'BTC' }, T, WINDOW, db);
            const match = await indexer.util.reversePriceMatch('1000', '0.05', 'BTC/USD', T, WINDOW, db);
            assert.strictEqual(gap === null, match !== null, name + ': gap ' + gap);
        });
    }
});
