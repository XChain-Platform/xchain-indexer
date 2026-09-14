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
// DISPENSER GET_ADDRESS freshness under the oracle-shape flag-day, driven
// through the real utxo-tracker client against stubbed JSON-RPC replies.
// Part of the Dispenser suite; see ../dispenser.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const { OWNER_ADDR, OTHER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, useDispenserHarness } = require('./helpers/dispenser_harness.js');

const Dispenser = require('../../../../src/actions/dispenser/index.js');

// The harness under test. useDispenserHarness rebuilds it before every test
// and restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, dispenser;
const bind = (h) => { ({ indexer, actionsCtx, dispenser } = h); };

const shapeGate  = require('../../../../src/dispenser_freshness_shape_activation.js');
const RealTracker = require('../../../../src/chain/utxo_tracker.js');
const SHAPE_KEY   = 'BTC:mainnet';
const ARMED_AT    = 400;   // below the 961000 freshness height, so the tracker path still runs

let origShape, origFetch;

// Drive the real client against a stubbed JSON-RPC reply, so the verdict
// travels the deployed path: dispenser -> gate -> UtxoTracker -> fetch.
async function runWithTrackerReply(result, blockIndex) {
    indexer.indexerDb.getAddressPreferences
        .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
        .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
    // If the local query were consulted it would say "has history", so a
    // 'valid' here can only have come from the tracker answer.
    indexer.indexerDb.hasXChainActivityBefore.resolves(true);

    actionsCtx.config      = Object.assign({}, indexer.config, { NETWORK: 'mainnet', COIN: 'BTC' });
    actionsCtx.utxoTracker = new RealTracker('localhost', 3005);
    dispenser              = new Dispenser(actionsCtx);

    global.fetch = sinon.stub().resolves({
        ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }),
    });

    const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
    const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: blockIndex });
    await dispenser.parse(params, data, false);
    return data['STATUS'];
}

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('GET_ADDRESS different from SOURCE validation (freshness)', function () {
        // ── The ORACLE-SHAPE flag-day, driven end to end through the real tracker
        //    client (src/dispenser_freshness_shape_activation.js). A non-null
        //    get_first_seen answer with no numeric height read as "never appeared on
        //    chain" and GRANTED the fresh-address exception, so a malformed-but-
        //    successful tracker reply accepted a create that a peer with a healthy
        //    tracker rejects. At/after the gate that answer throws and the existing
        //    catch reads it as not fresh. The window is BELOW the freshness causality
        //    gate, which is the only place the tracker is consulted at all, so it is
        //    modelled on mainnet BTC with the shape gate armed there for the duration
        //    of the case (mainnet ships UNARMED, which its own suite pins).
        describe('oracle-shape flag-day (malformed tracker reply must not grant freshness)', function () {
            beforeEach(function () {
                origShape = Object.getOwnPropertyDescriptor(shapeGate.DISPENSER_FRESHNESS_SHAPE_ACTIVATION, SHAPE_KEY);
                origFetch = global.fetch;
            });

            afterEach(function () {
                Object.defineProperty(shapeGate.DISPENSER_FRESHNESS_SHAPE_ACTIVATION, SHAPE_KEY, origShape);
                global.fetch = origFetch;
            });

            const MALFORMED = [
                ['a stringly-typed height',   { height: '100' }],
                ['a missing height field',    { other: 'field' }],
                ['a boolean height',          { height: true }],
                ['a nested-object height',    { value: { height: 100 } }],
                ['a non-object result',       'seen'],
            ];

            for (const [label, result] of MALFORMED) {
                it(`${label} is NOT permitted at/after the flag day`, async function () {
                    shapeGate.DISPENSER_FRESHNESS_SHAPE_ACTIVATION[SHAPE_KEY] = ARMED_AT;
                    const status = await runWithTrackerReply(result, ARMED_AT);
                    assert.ok(status.includes('GET_ADDRESS') && status.includes('not permitted'),
                        'a malformed tracker answer must fail closed, not grant the exception; got ' + status);
                });

                it(`${label} still GRANTS freshness one block below the flag day (replay unchanged)`, async function () {
                    shapeGate.DISPENSER_FRESHNESS_SHAPE_ACTIVATION[SHAPE_KEY] = ARMED_AT;
                    const status = await runWithTrackerReply(result, ARMED_AT - 1);
                    assert.strictEqual(status, 'valid',
                        'below the flag day the fail-open null is the replay-frozen verdict');
                });
            }
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('GET_ADDRESS different from SOURCE validation (freshness)', function () {
        describe('oracle-shape flag-day (malformed tracker reply must not grant freshness)', function () {
            beforeEach(function () {
                origShape = Object.getOwnPropertyDescriptor(shapeGate.DISPENSER_FRESHNESS_SHAPE_ACTIVATION, SHAPE_KEY);
                origFetch = global.fetch;
            });

            afterEach(function () {
                Object.defineProperty(shapeGate.DISPENSER_FRESHNESS_SHAPE_ACTIVATION, SHAPE_KEY, origShape);
                global.fetch = origFetch;
            });

            it('with mainnet UNARMED (as shipped) the malformed reply still grants freshness', async function () {
                // The posture the fleet deploys with: registering the gate moves no
                // mainnet verdict until the operator sizes the height on the arming train.
                const status = await runWithTrackerReply({ height: '100' }, 500);
                assert.strictEqual(status, 'valid');
            });

            it('a genuine never-seen answer is still fresh at/after the flag day', async function () {
                // The gate must deny malformed answers only, never the verdict itself.
                shapeGate.DISPENSER_FRESHNESS_SHAPE_ACTIVATION[SHAPE_KEY] = ARMED_AT;
                const status = await runWithTrackerReply(null, ARMED_AT);
                assert.strictEqual(status, 'valid');
            });

            it('a well-shaped sighting is still not permitted at/after the flag day', async function () {
                shapeGate.DISPENSER_FRESHNESS_SHAPE_ACTIVATION[SHAPE_KEY] = ARMED_AT;
                const status = await runWithTrackerReply({ height: 100 }, ARMED_AT);
                assert.ok(status.includes('GET_ADDRESS') && status.includes('not permitted'));
            });

            it('a sighting later than BLOCK_INDEX is still fresh at/after the flag day', async function () {
                // The height comparison is untouched by the shape gate.
                shapeGate.DISPENSER_FRESHNESS_SHAPE_ACTIVATION[SHAPE_KEY] = ARMED_AT;
                const status = await runWithTrackerReply({ height: 900 }, ARMED_AT);
                assert.strictEqual(status, 'valid');
            });
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('GET_ADDRESS different from SOURCE validation (freshness)', function () {
        describe('oracle-shape flag-day (malformed tracker reply must not grant freshness)', function () {
            beforeEach(function () {
                origShape = Object.getOwnPropertyDescriptor(shapeGate.DISPENSER_FRESHNESS_SHAPE_ACTIVATION, SHAPE_KEY);
                origFetch = global.fetch;
            });

            afterEach(function () {
                Object.defineProperty(shapeGate.DISPENSER_FRESHNESS_SHAPE_ACTIVATION, SHAPE_KEY, origShape);
                global.fetch = origFetch;
            });

            it('the gate verdict is keyed on this action\'s own BLOCK_INDEX', async function () {
                shapeGate.DISPENSER_FRESHNESS_SHAPE_ACTIVATION[SHAPE_KEY] = ARMED_AT;
                const tracker = { enabled: true, getFirstSeen: sinon.stub().resolves(null) };
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
                actionsCtx.config      = Object.assign({}, indexer.config, { NETWORK: 'mainnet', COIN: 'BTC' });
                actionsCtx.utxoTracker = tracker;
                dispenser              = new Dispenser(actionsCtx);

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                for (const [blockIndex, expected] of [[ARMED_AT - 1, false], [ARMED_AT, true]]) {
                    const data = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: blockIndex });
                    await dispenser.parse(params, data, false);
                    const opts = tracker.getFirstSeen.lastCall.args[1];
                    assert.strictEqual(!!(opts && opts.strictShape), expected,
                        'block ' + blockIndex + ' must pass strictShape=' + expected);
                }
            });
        });
    });
});
