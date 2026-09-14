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
// DISPENSER GET_ADDRESS different from SOURCE: the open-to-anyone preference
// and the local freshness path at/above the freshness flag-day.
// Part of the Dispenser suite; see ../dispenser.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const { OWNER_ADDR, OTHER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, useDispenserHarness } = require('./helpers/dispenser_harness.js');

const Dispenser = require('../../../../src/actions/dispenser.js');

// The harness under test. useDispenserHarness rebuilds it before every test
// and restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, dispenser;
const bind = (h) => { ({ indexer, actionsCtx, dispenser } = h); };

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    // ─── GET_ADDRESS != SOURCE validation (lines 268-282) ───────────────

    describe('GET_ADDRESS different from SOURCE validation (freshness)', function () {

        it('GET_ADDRESS with DISPENSER_PREFERENCE=2 allows any opener', async function () {
            // GET_ADDRESS != SOURCE, but GET_ADDRESS has DISPENSER_PREFERENCE=2 (open to anyone)
            indexer.indexerDb.getAddressPreferences
                .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 2 });

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('GET_ADDRESS different from SOURCE validation (freshness)', function () {
        // ── AT/ABOVE the freshness flag-day (regtest is genesis-active): the verdict
        //    derives from indexer-local chain state (db.hasXChainActivityBefore); the
        //    external utxo-tracker is NEVER consulted. dispenser_freshness_activation.js.
        describe('local path (freshness flag-day active, regtest genesis)', function () {
            it('fresh GET_ADDRESS (no prior XChain activity) is allowed, and the tracker is NOT consulted', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
                indexer.indexerDb.hasXChainActivityBefore.resolves(false); // fresh

                // Wire a tracker too, to prove the local path never touches it.
                const getFirstSeen = sinon.stub().resolves({ height: 1 }); // would say "not fresh" if consulted
                actionsCtx.utxoTracker = { enabled: true, getFirstSeen };
                dispenser = new Dispenser(actionsCtx);

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.hasXChainActivityBefore.calledWith(OTHER_ADDR, data['BLOCK_INDEX']),
                    'local freshness query must be consulted with BLOCK_INDEX');
                assert.ok(getFirstSeen.notCalled, 'the external utxo-tracker must NOT be consulted above the gate');
            });

            it('non-fresh GET_ADDRESS (prior XChain activity) is not permitted', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
                indexer.indexerDb.hasXChainActivityBefore.resolves(true); // has history

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.ok(data['STATUS'].includes('GET_ADDRESS') && data['STATUS'].includes('not permitted'));
            });
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('GET_ADDRESS different from SOURCE validation (freshness)', function () {
        describe('local path (freshness flag-day active, regtest genesis)', function () {
            it('non-fresh GET_ADDRESS with origin standing is allowed (DISPENSER_ORIGIN_STANDING)', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
                indexer.indexerDb.hasXChainActivityBefore.resolves(true); // not fresh
                indexer.indexerDb.hasDispenserOriginStanding
                    .withArgs(OWNER_ADDR, OTHER_ADDR, sinon.match.any)
                    .resolves(true);

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: 800000 });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.hasDispenserOriginStanding.calledWith(OWNER_ADDR, OTHER_ADDR, sinon.match.any));
            });
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('GET_ADDRESS different from SOURCE validation (freshness)', function () {
        describe('local path (freshness flag-day active, regtest genesis)', function () {
            it('non-fresh GET_ADDRESS where a DIFFERENT address holds standing stays invalid', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
                indexer.indexerDb.hasXChainActivityBefore.resolves(true); // not fresh
                // Default hasDispenserOriginStanding resolves false.

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: 800000 });

                await dispenser.parse(params, data, false);

                assert.ok(data['STATUS'].includes('GET_ADDRESS') && data['STATUS'].includes('not permitted'));
            });

            it('origin standing is not consulted when DISPENSER_ORIGIN_STANDING is inactive', async function () {
                indexer.indexerDb.getAddressPreferences
                    .withArgs(OTHER_ADDR, sinon.match.any, sinon.match.any)
                    .resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 0 });
                indexer.indexerDb.hasXChainActivityBefore.resolves(true); // not fresh
                actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(
                    async (name) => name !== 'DISPENSER_ORIGIN_STANDING',
                );
                dispenser = new Dispenser(actionsCtx);
                indexer.indexerDb.hasDispenserOriginStanding.resolves(true);

                const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OTHER_ADDR}||||${EXPIRATION}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC', BLOCK_INDEX: 800000 });

                await dispenser.parse(params, data, false);

                assert.ok(data['STATUS'].includes('GET_ADDRESS') && data['STATUS'].includes('not permitted'));
                assert.ok(indexer.indexerDb.hasDispenserOriginStanding.notCalled);
            });
        });
    });
});
