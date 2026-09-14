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
// DISPENSER action handler: Format 0 (create) validation and the unknown-format
// guard. The cancel, edit, freshness, create-path and oracle-fee suites live
// beside this file in dispenser.test/, one file per behaviour. Every block in
// every file opens the same 'Dispenser action handler @regression @tier2'
// describe, so every full test title carries that prefix;
// dispenser.test/helpers/dispenser_harness.js is the mock harness they all run on.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../fixtures/mocks');
const { OWNER_ADDR, BLOCK_TIME, EXPIRATION, makeParams, useDispenserHarness } = require('./dispenser.test/helpers/dispenser_harness.js');

const Dispenser = require('../../../src/actions/dispenser/index.js');

// The harness under test. useDispenserHarness rebuilds it before every test
// and restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, dispenser;
const bind = (h) => { ({ indexer, actionsCtx, dispenser } = h); };

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    // ─── Format 0: Create Dispenser ───────────────────────────────────────

    describe('Format 0 – Create Dispenser', function () {
        it('valid dispenser creation calls createDispenser and createDispenserStatus', async function () {
            // FORMAT: 0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||Creating JDOG dispenser`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.createDispenser);
            sinon.assert.calledOnce(indexer.indexerDb.createDispenserStatus);
        });

        it('valid dispenser escrow deducts GIVE_ESCROW from SOURCE balance', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            sinon.assert.calledOnce(indexer.indexerDb.updateBalances);
            sinon.assert.calledOnce(indexer.indexerDb.updateTokens);
        });

        it('GIVE_TICK not found returns invalid', async function () {
            indexer.indexerDb.getTokenInfo
                .withArgs('UNKNOWN', sinon.match.any, sinon.match.any)
                .resolves(null);

            const params = makeParams(`0|BTC|UNKNOWN|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GIVE_TICK'));
            // createDispenser is always called (records the invalid attempt); ledger changes are skipped
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('Format 0 – Create Dispenser', function () {
        it('invalid GET_ADDRESS format returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|not-a-valid-address||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GET_ADDRESS'));
        });

        it('insufficient balance for GIVE_ESCROW returns invalid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 10: '0' });

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('insufficient funds'));
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('Format 0 – Create Dispenser', function () {
        // Balance-dispenser GIVE_AMOUNT positivity gate. Empty or "0" GIVE_AMOUNT
        // used to open a dispenser that settled buyer payments as VALID fills
        // crediting nothing and never auto-closed. The gate is genesis-active on
        // regtest, which is the network this file runs under.
        it('empty GIVE_AMOUNT on a balance dispenser returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GIVE_AMOUNT'), data['STATUS']);
            sinon.assert.notCalled(indexer.indexerDb.createDispenserStatus);
        });

        it('zero GIVE_AMOUNT on a balance dispenser returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|0||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('GIVE_AMOUNT'), data['STATUS']);
        });

        // The gate constrains GIVE_AMOUNT only. Opening empty and topping up with a
        // format-2 refill is a legitimate flow and is not a trap: the dispense-side
        // clamp drives the multiplier to 0 against a zero GIVE_REMAINING, so a
        // payment against an empty dispenser settles invalid and consumes nothing.
        it('empty GIVE_ESCROW with a positive GIVE_AMOUNT stays valid', async function () {
            const params = makeParams(`0|BTC|JDOG|1|||BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('EXPIRATION before BLOCK_TIME returns invalid', async function () {
            const pastExpiry = BLOCK_TIME - 1000;
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${pastExpiry}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('EXPIRATION'));
        });

        it('EXPIRATION equal to BLOCK_TIME returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${BLOCK_TIME}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('EXPIRATION'));
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('Format 0 – Create Dispenser', function () {
        it('GIVE_COIN not matching COIN config returns invalid', async function () {
            const params = makeParams(`0|LTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].startsWith('invalid'));
        });

        it('GET_COIN not matching COIN config returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|LTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].startsWith('invalid'));
        });

        it('SOURCE sleeping returns invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .withArgs(OWNER_ADDR, null, sinon.match.any)
                .resolves(false);

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('SOURCE'));
        });

        it('TICK sleeping returns invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .withArgs(null, 'JDOG', sinon.match.any)
                .resolves(false);

            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('TICK'));
        });

        it('invalid FIAT_CODE returns invalid', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}|XXX|100.00||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('FIAT_CODE'));
        });
    });
});

describe('Dispenser action handler @regression @tier2', function () {
    useDispenserHarness(bind);

    describe('Format 0 – Create Dispenser', function () {
        it('pre-existing error short-circuits processing', async function () {
            const params = makeParams(`0|BTC|JDOG|1||10|BTC||0.01|${OWNER_ADDR}||||${EXPIRATION}|||`);
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, 'invalid: pre-existing');

            // createDispenser is always called (records the attempt); but ledger changes are not applied
            assert.ok(data['STATUS'].includes('pre-existing'));
            sinon.assert.notCalled(indexer.indexerDb.updateBalances);
        });
    });

    // ─── Unknown format ────────────────────────────────────────────────────

    describe('Unknown format', function () {
        it('unknown VERSION returns invalid', async function () {
            const params = makeParams('9|BTC|JDOG|1||10|BTC||0.01|||');
            const data   = createBaseData({ ACTION: 'DISPENSER', FORMAT: 9, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });

            await dispenser.parse(params, data, false);

            assert.ok(data['STATUS'].includes('invalid'));
        });
    });
});
