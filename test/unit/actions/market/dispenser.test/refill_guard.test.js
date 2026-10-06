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
// DISPENSER Format 2 refill: the controller guard runs on a refill of a
// controller-bound token only once the DISPENSER_REFILL protocol change is
// active; the row is unarmed on mainnet and testnet.
// Part of the Dispenser suite; see ../dispenser.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { OWNER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, useDispenserHarness } = require('./helpers/dispenser_harness.js');

const guardUtil = require('../../../../../src/utility/controller_guard.js');
const ProtocolChanges = require('../../../../../src/protocol_changes');

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

describe('Dispenser refill controller guard @regression @tier2', function () {
    useDispenserHarness(bind);

    let guard;
    beforeEach(function () {
        indexer.indexerDb.getDispenserInfo.resolves(dispenserInfo());
        guard = sinon.stub(dispenser.util, 'maybeRunControllerGuard').resolves({ error: null, guardFee: 0, payoutLegs: null });
    });

    function setRefillActive(active) {
        actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => name === 'DISPENSER_REFILL' ? active : true);
    }

    it('active: a refill the controller denies is refused and nothing is escrowed', async function () {
        setRefillActive(true);
        guard.resolves({ error: 'controller denied', guardFee: 0, payoutLegs: null });
        const data = refillData();
        await dispenser.parse(makeParams(`2|50|20|${EXPIRATION + 86400}|||`), data, false);

        sinon.assert.calledOnce(guard);
        assert.strictEqual(guard.firstCall.args[2].actionType, 'DISPENSER_REFILL');
        assert.strictEqual(guard.firstCall.args[2].tick, 'JDOG');
        assert.strictEqual(data['STATUS'], 'invalid: controller denied');
        sinon.assert.notCalled(indexer.indexerDb.updateBalances);
    });

    it('active: a refill the controller allows settles', async function () {
        setRefillActive(true);
        const data = refillData();
        await dispenser.parse(makeParams(`2|50|20|${EXPIRATION + 86400}|||`), data, false);

        sinon.assert.calledOnce(guard);
        assert.strictEqual(data['STATUS'], 'valid');
        sinon.assert.calledOnce(indexer.indexerDb.createDispenserEdit);
    });

    it('inactive: the same denied refill is unguarded and settles', async function () {
        setRefillActive(false);
        guard.resolves({ error: 'controller denied', guardFee: 0, payoutLegs: null });
        const data = refillData();
        await dispenser.parse(makeParams(`2|50|20|${EXPIRATION + 86400}|||`), data, false);

        sinon.assert.notCalled(guard);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('active: an edit that adds no escrow is not guarded', async function () {
        setRefillActive(true);
        const data = refillData();
        await dispenser.parse(makeParams(`2|50||${EXPIRATION + 86400}|||`), data, false);

        sinon.assert.notCalled(guard);
    });

    it('DISPENSER_REFILL routes to the trade controller class', function () {
        assert.strictEqual(guardUtil.controllerActionClass('DISPENSER_REFILL'), 'trade');
    });

    it('DISPENSER_REFILL is unarmed on mainnet and testnet, so it is inactive there', async function () {
        for (const network of ['mainnet', 'testnet']) {
            const pc = new ProtocolChanges({ config: { NETWORK: network }, util: {}, decoderDb: { getBlockTime: async () => 4102444800 }, indexerDb: {} });
            assert.strictEqual(pc.isDefined('DISPENSER_REFILL'), true, network);
            assert.strictEqual(await pc.isEnabled('DISPENSER_REFILL', 1), false, network);
        }
        assert.strictEqual(ProtocolChanges.DISPENSER_REFILL_MAINNET_TIME, ProtocolChanges.UNARMED);
    });
});
