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
// BATCH D10 spam collapse over duration-metered creates (ORDER, SWAP,
// DISPENSER). Part of the Batch suite; see ../batch.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { SOURCE, useBatchHarness } = require('./helpers/batch_harness.js');

const Batch = require('../../../../../src/actions/batch/index.js');

// The harness under test. useBatchHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, handler;
const bind = (h) => { ({ indexer, actionsCtx, handler } = h); };

const ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

// createBaseData's BLOCK_TIME. The fee is a pure function of (EXPIRATION - BLOCK_TIME),
// so the two are written together here and nowhere else in this block.
const BLOCK_TIME = 1700000000;
const day        = (n) => String(BLOCK_TIME + (n * 86400));

// BTC regtest, unified lane: UNIFIED_EXPIRATION_FEE_FREE_DAYS 90, EXPIRATION_PER_DAY 550
// gas, GAS_PRICE 0.00001 XCHAIN. A 100-day create is 10 chargeable days = 5500 gas =
// 0.055 XCHAIN, and a 90-day create is inside the free window and costs nothing.
// Written out rather than recomputed, so a schedule change reddens these tests instead
// of silently re-deriving whatever the code now believes.
const CREATE_FEE = '0.05500000';
const EXP_PAID   = day(100);

// Real ORDER / SWAP / DISPENSER handlers, so the EXPIRATION position under test is the
// one their OWN format strings declare (index 10, 10 and 13 today). A hand-written
// format string here would let the pre-check and the handlers drift apart in exactly
// the way reading the format string exists to prevent.
const Order     = require('../../../../../src/actions/order/index.js');
const Swap      = require('../../../../../src/actions/swap/index.js');
const Dispenser = require('../../../../../src/actions/dispenser/index.js');

function stubGates(weightsOn) {
    const known = ['BATCH', 'SEND', 'ISSUE', 'MINT', 'ORDER', 'SWAP', 'DISPENSER',
                   'EXECUTE', 'ISSUANCE_FEE', 'UNIFIED_FEES'];
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
        if (name === 'BATCH_SUBACTION_NORMALIZATION') return true;
        if (name === 'BATCH_ISSUANCE_LIMITS') return true;
        if (name === 'BATCH_COST_WEIGHTING') return weightsOn;
        return known.includes(name);
    });
    // The seam batch.js reads positions through. Mirrors actions/index.js's own map.
    const paramHandlers = {
        ORDER:     new Order(actionsCtx),
        SWAP:      new Swap(actionsCtx),
        DISPENSER: new Dispenser(actionsCtx),
    };
    actionsCtx.setActionParamHandler = (action) => paramHandlers[action] || null;
    handler = new Batch(actionsCtx);
}

// Wire shapes. Positions are NOT restated here beyond what a real encoder would emit;
// the trailing field is EXPIRATION in each create format.
const orderCreate     = (exp) => 'ORDER|0|BTC|TEST|10|0|BTC|OTHER|20|0|' + ADDR + '|' + exp;

function repeat(fn, n, exp) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(fn(exp));
    return out;
}

async function run(weightsOn, commands, balance) {
    stubGates(weightsOn);
    const data = createBaseData({
        ACTION:  'BATCH',
        FORMAT:  0,
        SOURCE,
        TX_DATA: 'BATCH|0|' + commands.join(';'),
    });
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getAddressBalances.resolves(balance === null ? {} : { 1: balance });
    await handler.parse(['0'], data, null);
    return data;
}
const EXP_FREE   = day(90);
const swapCreate      = (exp) => 'SWAP|0|BTC|TEST|10|0|BTC|OTHER|20|0|' + ADDR + '|' + exp;
// Three empty fields between GET_ADDRESS and EXPIRATION: FIAT_CODE, FIAT_AMOUNT,
// ORACLE_ADDRESS. That gap is the point of the DISPENSER case below.
const dispenserCreate = (exp) => 'DISPENSER|0|BTC|TEST|10|0|0|BTC|OTHER|1|' + ADDR + '||||' + exp;

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D10 spam collapse widened to duration-metered creates (BATCH_COST_WEIGHTING)', function () {
        it('gate OFF: an all-ORDER no-gas batch keeps the pre-flag verdict, N records and all', async function () {
            // The unwidened predicate bails on the first non-ISSUE sub-command, so this batch is
            // valid and every command runs. This is the byte-identity half of the pair: the
            // widening may not move a single verdict below its own flag.
            const data = await run(false, repeat(orderCreate, 3, EXP_PAID), '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 3);
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0,
                'the widened pre-check must not even read a balance below its flag');
        });

        it('gate ON: an all-ORDER no-gas batch collapses to ONE invalid record (A7)', async function () {
            const data = await run(true, repeat(orderCreate, 3, EXP_PAID), '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: GAS (insufficient)');
            assert.strictEqual(actionsCtx.processAction.callCount, 0, 'no sub-command runs');
            assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1, 'one whole-batch record, not three invalid rows');
            assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0);
        });

        it('gate ON: exactly the create fee is affordable (boundary)', async function () {
            const data = await run(true, repeat(orderCreate, 3, EXP_PAID), CREATE_FEE);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 3, 'the handlers decide which of the three can pay');
        });

        it('gate ON: one satoshi under the create fee is rejected (no off-by-one)', async function () {
            const data = await run(true, repeat(orderCreate, 3, EXP_PAID), '0.05499999');

            assert.strictEqual(data['STATUS'], 'invalid: GAS (insufficient)');
        });

        it('gate ON: a create inside the free expiration window is FREE, so nothing collapses', async function () {
            // A positively-known cost of ZERO is the opposite of an unknown cost: the
            // sub-command really can be valid on an empty balance.
            const data = await run(true, repeat(orderCreate, 3, EXP_FREE), '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 3);
        });

        it('gate ON: a create carrying NO expiration is free, and one of them exempts the batch', async function () {
            const data = await run(true, ['ISSUE|0|JDOG.1', 'ISSUE|0|JDOG.2', orderCreate('')], '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 3);
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D10 spam collapse widened to duration-metered creates (BATCH_COST_WEIGHTING)', function () {
        it('gate ON: an EDIT is not priceable here, so the batch proceeds', async function () {
            // Format 2 prices the DIFFERENCE against the stored record's EXPIRATION, which
            // needs a read this pre-check refuses to make. Unknown cost, no collapse.
            const data = await run(true, ['ORDER|2|5|' + EXP_PAID, 'ORDER|2|6|' + EXP_PAID], '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 2);
        });

        it('gate ON: a CANCEL is not priceable here, so the batch proceeds', async function () {
            const data = await run(true, ['ORDER|1|5', 'ORDER|1|6'], '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('gate ON: an unparseable EXPIRATION is UNKNOWN, neither free nor costly', async function () {
            const data = await run(true, repeat(orderCreate, 3, 'soon'), '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid', 'a garbage field may never manufacture a collapse');
        });

        it('gate ON: SWAP creates are priced by the same rule', async function () {
            const data = await run(true, repeat(swapCreate, 3, EXP_PAID), '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: GAS (insufficient)');

            const funded = await run(true, repeat(swapCreate, 3, EXP_PAID), CREATE_FEE);
            assert.strictEqual(funded['STATUS'], 'valid');
        });

        it('gate ON: DISPENSER EXPIRATION is read from ITS OWN format string, not ORDER\'s position', async function () {
            // DISPENSER carries EXPIRATION at index 13; ORDER and SWAP carry it at 10. Both
            // halves are needed: the first alone cannot tell "read from the format string" from
            // "hardcoded 13", and the second alone cannot tell "correctly ignored" from
            // "DISPENSER is not priced at all".
            const priced = await run(true, repeat(dispenserCreate, 3, EXP_PAID), '0.00000000');
            assert.strictEqual(priced['STATUS'], 'invalid: GAS (insufficient)');

            // Same timestamp, but sitting in FIAT_CODE (index 10) with EXPIRATION absent. A
            // pre-check hardcoded to ORDER's position would price it and wrongly collapse.
            const misread = await run(true, ['DISPENSER|0|BTC|TEST|10|0|0|BTC|OTHER|1|' + ADDR + '|' + EXP_PAID], '0.00000000');
            assert.strictEqual(misread['STATUS'], 'valid');
        });

        it('gate ON: MINT is deliberately NOT priced, because a MINT is free', async function () {
            const data = await run(true, ['MINT|0|TEST|10'], '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D10 spam collapse widened to duration-metered creates (BATCH_COST_WEIGHTING)', function () {
        it('gate ON: the cheapest sub-command still sets the bar across mixed classes', async function () {
            // A child ISSUE costs 0.5 and a 100-day create costs 0.055. A source holding the
            // create's price can land the create, so rejecting the batch would destroy work
            // that really would have succeeded.
            const data = await run(true, ['ISSUE|0|JDOG.1', orderCreate(EXP_PAID)], CREATE_FEE);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 2);

            const broke = await run(true, ['ISSUE|0|JDOG.1', orderCreate(EXP_PAID)], '0.05499999');
            assert.strictEqual(broke['STATUS'], 'invalid: GAS (insufficient)');
        });

        it('gate ON: pricing a create costs NO database read', async function () {
            // The whole reason the duration classes are priceable at all is that the fee is a
            // pure function of EXPIRATION and BLOCK_TIME. If this ever needs a read, the check
            // has started doing the O(commands x reads) work it exists to avoid.
            await run(true, repeat(orderCreate, 250, EXP_PAID), '0.00000000');

            assert.strictEqual(indexer.indexerDb.getTokenInfo.callCount, 0, 'no token probes for the duration classes');
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 1, 'one balance read for the whole batch');
        });

        it('gate ON: native-coin fee mode stays out of scope for the new classes too', async function () {
            stubGates(true);
            const data = createBaseData({
                ACTION:     'BATCH',
                FORMAT:     0,
                SOURCE,
                TX_DATA:    'BATCH|0|' + repeat(orderCreate, 3, EXP_PAID).join(';'),
                TX_OUTPUTS: [{ address: indexer.config['ADDRESS']['FEE_DESTINATION'], value: '0.001' }],
            });
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressBalances.resolves({});

            await handler.parse(['0'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0, 'no gas read at all in native mode');
        });

        it('gate ON: an earlier verdict still short-circuits the widened check', async function () {
            const data = await run(true, repeat(orderCreate, 251, EXP_PAID), '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0);
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D10 spam collapse widened to duration-metered creates (BATCH_COST_WEIGHTING)', function () {
        it('gate ON: a missing positional-layout seam is UNKNOWN cost, never a collapse', async function () {
            // An Actions without setActionParamHandler (an older build, a partial double) must
            // degrade to the unwidened verdict rather than to a hardcoded position.
            stubGates(true);
            delete actionsCtx.setActionParamHandler;
            handler = new Batch(actionsCtx);
            const data = createBaseData({
                ACTION: 'BATCH', FORMAT: 0, SOURCE,
                TX_DATA: 'BATCH|0|' + repeat(orderCreate, 3, EXP_PAID).join(';'),
            });
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressBalances.resolves({});

            await handler.parse(['0'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });
    });
});
