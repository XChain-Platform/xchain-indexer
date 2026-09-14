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
// DISPENSER Format 2 (edit): owner edits and refills, the MAX_REFILLS cap and
// GIVE_ESCROW on an ownership dispenser.
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

function makeDispenserInfo(overrides = {}) {
    return {
        ACTION_INDEX:     50,
        SOURCE:           OWNER_ADDR,
        GET_ADDRESS:      OWNER_ADDR,
        GIVE_COIN:        'BTC',
        GIVE_TICK:        'JDOG',
        GIVE_REMAINING:   '10',
        GET_COIN:         'BTC',
        GET_TICK:         null,
        DISPENSER_STATUS: 'open',
        EXPIRATION:       EXPIRATION,
        BLOCK_TIME:       BLOCK_TIME,
        ALLOW_LIST:       null,
        BLOCK_LIST:       null,
        ...overrides,
    };
}

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    // ─── Format 2: Edit Dispenser ─────────────────────────────────────────

    describe('Format 2 – Edit Dispenser', function () {
        beforeEach(function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());
        });

        it('owner edits open dispenser returns valid and calls createDispenserEdit', async function () {
            // Add 20 more to escrow, extend expiration
            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||Refilling`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserEdit);
        });

        it('non-owner edit returns invalid', async function () {
            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OTHER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('SOURCE'));
        });

        it('edit of unknown dispenser (getDispenserInfo returns null) throws before validation', async function () {
            // When dispenserInfo is null, the code crashes at info['GIVE_TICK'] before validation.
            indexer.indexerDb.getDispenserInfo.resolves(null);

            const params = makeParams(`2|9999|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await assert.rejects(
                () => dispenser.parse(params, data, false),
                (err) => {
                    assert.ok(err instanceof TypeError);
                    return true;
                }
            );
        });

        it('edit of non-open dispenser returns invalid', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ DISPENSER_STATUS: 'closed' }));

            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('DISPENSER_ACTION_INDEX'));
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('Format 2 – Edit Dispenser', function () {
        beforeEach(function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());
        });

        it('edit escrow deducted when GIVE_ESCROW provided', async function () {
            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            sinon.assert.calledOnce(indexer.indexerDb.updateBalances);
        });

        it('valid edit updates action index to DISPENSER_EDIT', async function () {
            const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            sinon.assert.calledWith(indexer.indexerDb.updateActionIndex, sinon.match.any, 'DISPENSER_EDIT');
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);
    describe('Format 2 – Edit Dispenser', function () {
        beforeEach(function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());
        });

        // ── MAX_REFILLS cap (dispenser_caps_activation.js). A refill is a
        //    format-2 edit that tops up GIVE_ESCROW; the 6th is rejected. Gated on the
        //    dispenser-family cohort (mainnet block_time 1786060800, testnet/regtest genesis).
        describe('MAX_REFILLS cap', function () {

            it('rejects the 6th refill (caps active, regtest genesis)', async function () {
                indexer.indexerDb.getDispenserRefillCount.resolves(5); // already at the limit
                const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);   // GIVE_ESCROW=20 top-up
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.ok(data['STATUS'].includes('MAX_REFILLS'), 'the 6th refill must be rejected: ' + data['STATUS']);
                assert.ok(indexer.indexerDb.getDispenserRefillCount.calledWith(data['DISPENSER_ACTION_INDEX']),
                    'the refill count must be queried for the edited dispenser');
            });

            it('allows the 5th refill (below the limit)', async function () {
                indexer.indexerDb.getDispenserRefillCount.resolves(4);
                const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid');
            });

            it('does NOT count a non-refill edit (no GIVE_ESCROW) against the cap', async function () {
                indexer.indexerDb.getDispenserRefillCount.resolves(5); // at the limit
                // Expiration-only edit: GIVE_ESCROW empty, so it is not a refill.
                const params = makeParams(`2|50||${EXPIRATION + 86400}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid', 'a non-refill edit must not be blocked by MAX_REFILLS');
            });

            it('below the caps flag-day (mainnet block_time < 1786060800): no refill limit', async function () {
                actionsCtx.config = Object.assign({}, indexer.config, { NETWORK: 'mainnet', COIN: 'BTC' });
                dispenser = new Dispenser(actionsCtx);
                indexer.indexerDb.getDispenserRefillCount.resolves(5); // would be rejected if the cap were active
                const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
                // BLOCK_TIME 1700000000 < 1786060800 => caps inactive
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid', 'below the flag-day the legacy uncapped behavior must run');
            });
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('Format 2 – Edit Dispenser', function () {
        beforeEach(function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());
        });

        // Ownership dispensers hold no balance escrow, on edit as on create.
        // Without this rule a format-2 refill debits GIVE_ESCROW while close/expire
        // take the GIVE_OWNERSHIP branch that credits nothing back, stranding the balance.
        // Gated on the same dispenser-family cohort as MAX_REFILLS above.
        describe('GIVE_ESCROW on an ownership dispenser', function () {

            it('rejects a format-2 refill of an ownership dispenser (cohort active, regtest genesis)', async function () {
                indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_OWNERSHIP: 1 }));
                const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);   // GIVE_ESCROW=20 top-up
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.ok(data['STATUS'].includes('GIVE_ESCROW'),
                    'a refill of an ownership dispenser must be rejected: ' + data['STATUS']);
                sinon.assert.notCalled(indexer.indexerDb.updateBalances);
            });

            it('still allows an expiration-only edit of an ownership dispenser', async function () {
                indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_OWNERSHIP: 1 }));
                const params = makeParams(`2|50||${EXPIRATION + 86400}|||`);     // GIVE_ESCROW empty
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid',
                    'an ownership dispenser must stay editable for expiration and lists');
            });
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('Format 2 – Edit Dispenser', function () {
        beforeEach(function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());
        });

        describe('GIVE_ESCROW on an ownership dispenser', function () {

            it('leaves a balance-dispenser refill untouched', async function () {
                indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_OWNERSHIP: 0 }));
                const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid');
            });

            it('below the cohort flag-day (mainnet block_time < 1786060800): legacy accept', async function () {
                actionsCtx.config = Object.assign({}, indexer.config, { NETWORK: 'mainnet', COIN: 'BTC' });
                dispenser = new Dispenser(actionsCtx);
                indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_OWNERSHIP: 1 }));
                const params = makeParams(`2|50|20|${EXPIRATION + 86400}|||`);
                // BLOCK_TIME 1700000000 < 1786060800 => cohort inactive
                const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 2, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

                await dispenser.parse(params, data, false);

                assert.strictEqual(data['STATUS'], 'valid',
                    'below the flag-day historical replay must stay byte-identical');
            });
        });
    });
});
