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
// DISPENSER GET_ADDRESS freshness below the flag-day: the external tracker
// verdict and the stale-fresh diagnostic that records a lagging tracker.
// Part of the Dispenser suite; see ../dispenser.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { OWNER_ADDR, OTHER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, useDispenserHarness } = require('./helpers/dispenser_harness.js');

const Dispenser = require('../../../../../src/actions/dispenser/index.js');

// The harness under test. useDispenserHarness rebuilds it before every test
// and restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, dispenser;
const bind = (h) => { ({ indexer, actionsCtx, dispenser } = h); };

function mainnetBelowGateCtx() {
    actionsCtx.config = Object.assign({}, indexer.config, { NETWORK: 'mainnet', COIN: 'BTC' });
}

// get_first_seen answers the same null for "never appeared" and for "this
// tracker has not indexed that far yet / is halted", so a fresh-by-null
// verdict computed against a lagging tracker is a false positive with no
// trace. These pin the diagnostic that records it, and pin that it stays a
// diagnostic: the verdict is replay-frozen and must not move.
async function runBelowGateFresh(tracker) {
    indexer.indexerDb.getAddressPreferences
        .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
        .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
    mainnetBelowGateCtx();
    actionsCtx.utxoTracker = tracker;
    dispenser = new Dispenser(actionsCtx);

    const logged = [];
    sinon.stub(console, 'log').callsFake((...args) => { logged.push(args.join(' ')); });

    const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
    const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: 500 });
    await dispenser.parse(params, data, false);

    return { status: data['STATUS'], stale: logged.filter(l => l.includes('DISPENSER_FRESHNESS_STALE')) };
}

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('GET_ADDRESS different from SOURCE validation (freshness)', function () {
        // ── BELOW the freshness flag-day: byte-identical legacy behavior. The verdict
        //    comes from the external utxo-tracker getFirstSeen HTTP call and the local
        //    query is NEVER consulted. Modelled with a mainnet-BTC config below 961000
        //    (util keeps its own regtest config, so the regtest test addresses still
        //    validate; only the freshness gate sees mainnet).
        describe('legacy path (below the freshness flag-day: mainnet BTC < 961000)', function () {
            it('tracker-fresh GET_ADDRESS is allowed, and the local query is NOT consulted', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
                // If the local query were (wrongly) consulted it would say "has history".
                indexer.indexerDb.hasXChainActivityBefore.resolves(true);

                mainnetBelowGateCtx();
                const getFirstSeen = sinon.stub().resolves(null); // never seen => fresh
                actionsCtx.utxoTracker = { enabled: true, getFirstSeen };
                dispenser = new Dispenser(actionsCtx);

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: 500 });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(getFirstSeen.calledWith(OTHER_ADDR), 'legacy path must consult the tracker');
                assert.ok(indexer.indexerDb.hasXChainActivityBefore.notCalled,
                    'below the gate the local freshness query must NOT be consulted');
            });
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('GET_ADDRESS different from SOURCE validation (freshness)', function () {
        describe('legacy path (below the freshness flag-day: mainnet BTC < 961000)', function () {
            it('tracker-not-fresh GET_ADDRESS is not permitted', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });

                mainnetBelowGateCtx();
                actionsCtx.utxoTracker = { enabled: true, getFirstSeen: sinon.stub().resolves({ height: 100 }) };
                dispenser = new Dispenser(actionsCtx);

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: 500 });

                await dispenser.parse(params, data, false);

                assert.ok(data['STATUS'].includes('GET_ADDRESS') && data['STATUS'].includes('not permitted'));
            });

            it('tracker throwing falls back to not-fresh (invalid), byte-identical legacy behavior', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });

                mainnetBelowGateCtx();
                actionsCtx.utxoTracker = { enabled: true, getFirstSeen: sinon.stub().rejects(new Error('db error')) };
                dispenser = new Dispenser(actionsCtx);

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: 500 });

                await dispenser.parse(params, data, false);

                assert.ok(data['STATUS'].includes('GET_ADDRESS') && data['STATUS'].includes('not permitted'));
            });
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('GET_ADDRESS different from SOURCE validation (freshness)', function () {
        describe('legacy path (below the freshness flag-day: mainnet BTC < 961000)', function () {
            const SYNCED   = { tracker_height: 500, node_height: 500, lag: 0, synced: true, mempool_ready: true };
            const LAGGING  = { tracker_height: 10, node_height: 500, lag: 490, synced: false, mempool_ready: false };
            const HALTED   = { tracker_height: 10, node_height: -1, lag: null, synced: false,
                               mempool_ready: false, halted: true, halt_reason: 'unrecoverable reorg' };

            it('records a fresh verdict that rests on a lagging tracker, without changing it', async function () {
                const r = await runBelowGateFresh({
                    enabled: true,
                    getFirstSeen:       sinon.stub().resolves(null),
                    getFirstSeenStatus: sinon.stub().resolves({ firstSeen: null, sync: LAGGING }),
                });
                assert.strictEqual(r.status, 'valid', 'the replay-frozen verdict must not move');
                assert.strictEqual(r.stale.length, 1, 'a stale-fresh grant must leave a trace');
                assert.ok(r.stale[0].includes('lag=490') && r.stale[0].includes('synced=false'));
            });

            it('records a fresh verdict that rests on a halted tracker', async function () {
                const r = await runBelowGateFresh({
                    enabled: true,
                    getFirstSeen:       sinon.stub().resolves(null),
                    getFirstSeenStatus: sinon.stub().resolves({ firstSeen: null, sync: HALTED }),
                });
                assert.strictEqual(r.status, 'valid');
                assert.strictEqual(r.stale.length, 1);
                assert.ok(r.stale[0].includes('halted=true') && r.stale[0].includes('lag=null'));
            });

            it('stays silent when the tracker vouches for the null answer', async function () {
                const r = await runBelowGateFresh({
                    enabled: true,
                    getFirstSeen:       sinon.stub().resolves(null),
                    getFirstSeenStatus: sinon.stub().resolves({ firstSeen: null, sync: SYNCED }),
                });
                assert.strictEqual(r.status, 'valid');
                assert.strictEqual(r.stale.length, 0, 'a synced tracker is not a stale grant');
            });

            it('never probes when the verdict did not rest on a null answer', async function () {
                const getFirstSeenStatus = sinon.stub().resolves({ firstSeen: null, sync: LAGGING });
                const r = await runBelowGateFresh({
                    enabled: true,
                    getFirstSeen: sinon.stub().resolves({ height: 900 }), // seen later than BLOCK_INDEX
                    getFirstSeenStatus,
                });
                assert.strictEqual(r.status, 'valid', 'first-seen above BLOCK_INDEX is still fresh');
                assert.ok(getFirstSeenStatus.notCalled, 'a non-null answer needs no lag probe');
                assert.strictEqual(r.stale.length, 0);
            });
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('GET_ADDRESS different from SOURCE validation (freshness)', function () {
        describe('legacy path (below the freshness flag-day: mainnet BTC < 961000)', function () {
            it('leaves the verdict alone when the probe itself fails or is unsupported', async function () {
                const thrown = await runBelowGateFresh({
                    enabled: true,
                    getFirstSeen:       sinon.stub().resolves(null),
                    getFirstSeenStatus: sinon.stub().rejects(new Error('UTXO tracker RPC error: {"code":-32601}')),
                });
                assert.strictEqual(thrown.status, 'valid', 'a -32601 must never become a rejection');
                assert.strictEqual(thrown.stale.length, 0);

                sinon.restore();

                // A tracker client predating the sibling: no method at all.
                const absent = await runBelowGateFresh({
                    enabled: true,
                    getFirstSeen: sinon.stub().resolves(null),
                });
                assert.strictEqual(absent.status, 'valid');
                assert.strictEqual(absent.stale.length, 0);
            });
        });
    });
});
