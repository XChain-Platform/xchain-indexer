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
// DISPENSER Format 2 refill: from the dispenser_refill_policy_activation height a
// refill is refused while the give token sleeps or while its allow and block
// lists exclude the refilling SOURCE, as a create is. Below the height, and on
// every network where the row is unarmed, the refill settles as it always did
// and the two policy reads are never made.
// Part of the Dispenser suite; see ../dispenser.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { OWNER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, useDispenserHarness } = require('./helpers/dispenser_harness.js');
const { stubGate } = require('../../../../helpers/gate_modules.js');

const gateRegistry = require('../../../../../src/consensus/gate_registry');

const KEY = 'dispenser_refill_policy_activation.DISPENSER_REFILL_POLICY_ACTIVATION';
// Above any height a chain reaches, below the unarmed sentinel.
const FAR_HEIGHT = 500000000;
const REFILL = `2|50|20|${EXPIRATION + 86400}|||`;

let indexer, actionsCtx, dispenser;
const bind = (h) => { ({ indexer, actionsCtx, dispenser } = h); };

function dispenserInfo() {
    return {
        ACTION_INDEX: 50, SOURCE: OWNER_ADDR, GET_ADDRESS: OWNER_ADDR,
        GIVE_COIN: 'BTC', GIVE_TICK: 'JDOG', GIVE_REMAINING: '10', GET_COIN: 'BTC', GET_TICK: null,
        DISPENSER_STATUS: 'open', EXPIRATION, BLOCK_TIME, ALLOW_LIST: null, BLOCK_LIST: null,
    };
}

function refillData() {
    return createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });
}

// The give-token reads the rule adds: the tick-only sleep read and the
// SOURCE-plus-tick list read. The SOURCE-only sleep read predates the rule.
function tickReads() {
    return indexer.indexerDb.isActionAllowed.getCalls().filter((call) => call.args[1] === 'JDOG');
}

describe('Dispenser refill token policy @regression @tier2', function () {
    useDispenserHarness(bind);

    beforeEach(function () {
        indexer.indexerDb.getDispenserInfo.resolves(dispenserInfo());
    });

    function sleepTick() {
        indexer.indexerDb.isActionAllowed.withArgs(null, 'JDOG', sinon.match.any).resolves(false);
    }

    function excludeSource() {
        indexer.indexerDb.isActionAllowed.withArgs(OWNER_ADDR, 'JDOG', sinon.match.any).resolves(false);
    }

    describe('armed', function () {
        it('refuses a refill while the give token sleeps and escrows nothing', async function () {
            sleepTick();
            const data = refillData();
            await dispenser.parse(makeParams(REFILL), data, false);

            assert.strictEqual(data['STATUS'], 'invalid: TICK (sleeping)');
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });

        it('refuses a refill from a SOURCE the give token lists out and escrows nothing', async function () {
            excludeSource();
            const data = refillData();
            await dispenser.parse(makeParams(REFILL), data, false);

            assert.strictEqual(data['STATUS'], 'invalid: SOURCE (not authorized)');
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });

        it('reads the tick from the dispenser row at the edit block', async function () {
            const data = refillData();
            await dispenser.parse(makeParams(REFILL), data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.deepStrictEqual(tickReads().map((call) => call.args),
                [[null, 'JDOG', data['BLOCK_INDEX']], [OWNER_ADDR, 'JDOG', data['BLOCK_INDEX']]]);
        });

        it('reads the row by height at the edit block, on the handler network and coin', async function () {
            const gate = stubGate(sinon, KEY, true);
            const data = refillData();
            await dispenser.parse(makeParams(REFILL), data, false);

            assert.ok(gate.calledWith(dispenser.config['NETWORK'], dispenser.config['COIN'], Number(data['BLOCK_INDEX']), null));
        });

        it('leaves an edit that adds no escrow alone, sleeping token or not', async function () {
            sleepTick();
            excludeSource();
            const data = refillData();
            await dispenser.parse(makeParams(`2|50||${EXPIRATION + 86400}|||`), data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(tickReads().length, 0);
        });

        it('keeps the not-owner verdict ahead of the token policy', async function () {
            sleepTick();
            const info = dispenserInfo();
            info.SOURCE = info.GET_ADDRESS = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
            indexer.indexerDb.getDispenserInfo.resolves(info);
            const data = refillData();
            await dispenser.parse(makeParams(REFILL), data, false);

            assert.strictEqual(data['STATUS'], 'invalid: SOURCE (not owner)');
        });
    });

    describe('below the height', function () {
        beforeEach(function () {
            stubGate(sinon, KEY, false);
        });

        it('settles a refill of a sleeping token and makes neither policy read', async function () {
            sleepTick();
            const data = refillData();
            await dispenser.parse(makeParams(REFILL), data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserEdit);
            assert.strictEqual(tickReads().length, 0);
        });

        it('settles a refill from a listed-out SOURCE and makes neither policy read', async function () {
            excludeSource();
            const data = refillData();
            await dispenser.parse(makeParams(REFILL), data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserEdit);
            assert.strictEqual(tickReads().length, 0);
        });
    });

    describe('the row', function () {
        it('is unarmed on mainnet and on every testnet coin, and active from regtest genesis', function () {
            for (const coin of ['BTC', 'LTC', 'DOGE']) {
                for (const network of ['mainnet', 'testnet'])
                    assert.strictEqual(gateRegistry.activeAt(KEY, network, coin, FAR_HEIGHT, null), false, coin + ':' + network);
                assert.strictEqual(gateRegistry.activeAt(KEY, 'regtest', coin, 0, null), true, coin + ':regtest');
            }
        });
    });
});
