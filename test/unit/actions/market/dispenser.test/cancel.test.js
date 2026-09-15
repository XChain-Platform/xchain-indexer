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
// DISPENSER Format 1 (cancel): owner and delegated cancels, the non-owner and
// non-open rejections, and the action-index update.
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

function makeDispenserInfo(overrides = {}) {
    return {
        ACTION_INDEX:       50,
        SOURCE:             OWNER_ADDR,
        GET_ADDRESS:        OWNER_ADDR,
        GIVE_COIN:          'BTC',
        GIVE_TICK:          'JDOG',
        GET_COIN:           'BTC',
        GET_TICK:           null,
        GIVE_REMAINING:     '10',
        DISPENSER_STATUS:   'open',
        EXPIRATION:         EXPIRATION,
        BLOCK_TIME:         BLOCK_TIME,
        ALLOW_LIST:         null,
        BLOCK_LIST:         null,
        ...overrides,
    };
}

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    // ─── Format 1: Cancel Dispenser ───────────────────────────────────────

    describe('Format 1 – Cancel Dispenser', function () {
        beforeEach(function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());
        });

        it('owner cancels open dispenser returns valid', async function () {
            const params = makeParams('1|50|Closing dispenser');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserCancel);
        });

        it('cancel sets dispenser status to cancelling', async function () {
            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            const statusCall = indexer.indexerDb.createDispenserStatus.firstCall;
            assert.ok(statusCall, 'createDispenserStatus should have been called');
            assert.strictEqual(statusCall.args[2], 'cancelling');
        });

        it('cancel by non-owner returns invalid', async function () {
            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OTHER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            // createDispenserCancel is always called (records the attempt); ledger changes are skipped
            assert.ok(data['STATUS'].includes('SOURCE'));
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('Format 1 – Cancel Dispenser', function () {
        beforeEach(function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());
        });

        // Delegated dispensers (GET_ADDRESS != SOURCE): the ownership gate accepts EITHER
        // the create SOURCE or the GET_ADDRESS the dispenser operates on. This is the
        // contract the recognition-only decoder mirrors when it resolves a cancel/edit by
        // acting address (it has no action_index of its own), so both arms are pinned
        // here: a decoder that keys on only one of them keeps a cancelled dispenser in its
        // open view and keeps proposing DISPENSE triggers the indexer drops.
        it('a delegated dispenser can be cancelled by its original creator', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
                SOURCE:      OWNER_ADDR,   // opened the dispenser
                GET_ADDRESS: OTHER_ADDR,   // but it operates on (and is paid at) OTHER
            }));
            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserCancel);
        });

        it('a delegated dispenser can also be cancelled by its GET_ADDRESS', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
                SOURCE:      OWNER_ADDR,
                GET_ADDRESS: OTHER_ADDR,
            }));
            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OTHER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserCancel);
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('Format 1 – Cancel Dispenser', function () {
        beforeEach(function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());
        });

        it('cancel of unknown dispenser (getDispenserInfo returns null) throws before validation', async function () {
            // When dispenserInfo is null, the code crashes at line 99 of dispenser.js (info['GIVE_TICK'])
            // before the validation check can run (this is a known code limitation).
            // We verify that the error is propagated as a rejection.
            indexer.indexerDb.getDispenserInfo.resolves(null);

            const params = makeParams('1|9999|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await assert.rejects(
                () => dispenser.parse(params, data, false),
                (err) => {
                    assert.ok(err instanceof TypeError);
                    return true;
                }
            );
        });

        it('cancel of non-open dispenser returns invalid', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ DISPENSER_STATUS: 'closed' }));

            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('DISPENSER_ACTION_INDEX'));
        });

        it('valid cancel updates action index to DISPENSER_CANCEL', async function () {
            const params = makeParams('1|50|');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 1, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            sinon.assert.calledWith(indexer.indexerDb.updateActionIndex, sinon.match.any, 'DISPENSER_CANCEL');
        });
    });
});
