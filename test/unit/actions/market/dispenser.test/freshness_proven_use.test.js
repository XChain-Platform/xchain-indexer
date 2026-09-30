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
// DISPENSER fresh-address exception under the proven-use flag-day: at/after it only
// activity that proves use of GET_ADDRESS spends freshness, so an address someone else
// put on a LIST can still be opened from a main wallet; below it any index_addresses
// row counts, exactly as before. Part of the Dispenser suite; see ../dispenser.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { OWNER_ADDR, OTHER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, useDispenserHarness } = require('./helpers/dispenser_harness.js');

const Dispenser    = require('../../../../../src/actions/dispenser/index.js');
const gateRegistry = require('../../../../../src/consensus/gate_registry');

const PROVEN_USE_KEY = 'dispenser_freshness_proven_use_activation.DISPENSER_FRESHNESS_PROVEN_USE_ACTIVATION';

let indexer, actionsCtx, dispenser;
const bind = (h) => { ({ indexer, actionsCtx, dispenser } = h); };

// GET_ADDRESS was named in someone's LIST: it has an index_addresses row (old rule:
// not fresh) but no action, credit or dispenser that proves use (new rule: fresh).
function listedOnly() {
    indexer.indexerDb.getAddressPreferences
        .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
        .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
    indexer.indexerDb.hasXChainActivityBefore.resolves(true);
    indexer.indexerDb.hasProvenUseBefore.resolves(false);
}

// Hold only the proven-use row below its flag-day; every other gate reads as it does.
function provenUseInactive() {
    const real = gateRegistry.activeAt;
    sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...rest) => (key === PROVEN_USE_KEY ? false : real(key, ...rest)));
}

async function openOnOther() {
    const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
    const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: 800000 });
    await dispenser.parse(params, data, false);
    return data;
}

describe('Dispenser fresh-address proven use @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('at/after the proven-use flag-day (regtest genesis)', function () {
        it('a GET_ADDRESS only mentioned in a LIST is still fresh, and the old query is not consulted', async function () {
            listedOnly();
            const data = await openOnOther();
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.hasProvenUseBefore.calledWith(OTHER_ADDR, 800000));
            assert.ok(indexer.indexerDb.hasXChainActivityBefore.notCalled);
        });

        // Arm only the configured coin's slot, the shape a per-chain arming train writes.
        it('follows an arm of the configured coin slot alone', async function () {
            listedOnly();
            const real = gateRegistry.activeAt;
            sinon.stub(gateRegistry, 'activeAt').callsFake((key, network, coin, ...rest) =>
                (key === PROVEN_USE_KEY ? coin === 'BTC' : real(key, network, coin, ...rest)));
            dispenser = new Dispenser(actionsCtx);
            const data = await openOnOther();
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('a GET_ADDRESS with proven prior use is not permitted', async function () {
            listedOnly();
            indexer.indexerDb.hasProvenUseBefore.resolves(true);
            const data = await openOnOther();
            assert.strictEqual(data['STATUS'], 'invalid: GET_ADDRESS (dispenser not permitted)');
        });
    });

    describe('below the proven-use flag-day', function () {
        it('a GET_ADDRESS only mentioned in a LIST stays not fresh (legacy verdict)', async function () {
            listedOnly();
            provenUseInactive();
            dispenser = new Dispenser(actionsCtx);
            const data = await openOnOther();
            assert.strictEqual(data['STATUS'], 'invalid: GET_ADDRESS (dispenser not permitted)');
            assert.ok(indexer.indexerDb.hasXChainActivityBefore.calledWith(OTHER_ADDR, 800000));
            assert.ok(indexer.indexerDb.hasProvenUseBefore.notCalled);
        });
    });

    describe('the registry row', function () {
        it('is unarmed on mainnet and testnet and genesis-active on regtest', function () {
            assert.strictEqual(gateRegistry.activeAt(PROVEN_USE_KEY, 'mainnet', 'BTC', null, 4102444800), false);
            assert.strictEqual(gateRegistry.activeAt(PROVEN_USE_KEY, 'testnet', 'DOGE', null, 4102444800), false);
            assert.strictEqual(gateRegistry.activeAt(PROVEN_USE_KEY, 'regtest', 'BTC', null, 0), true);
        });
    });
});
