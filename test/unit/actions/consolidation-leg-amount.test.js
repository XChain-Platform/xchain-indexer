'use strict';

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
// Multi-leg consolidation flag-day (consolidation_leg_amount_activation.js).
//
// SEND and DESTROY merge same-key legs BEFORE any leg's amount format is checked, so
// two 0.5 legs of a 0-decimals token summed to '1' and settled while either leg alone
// was rejected. Above the threshold a leg whose raw amount fails its tick's format is
// held out of the merge and reaches the per-leg check on its own.
//
// Every gated case carries its FAILURE-REPRODUCING CONTROL: the same input with the
// gate forced off, asserted to still produce the ORIGINAL laundered outcome. Without
// that control a green run would look identical if the harness never reached the
// consolidation path at all, and the below-threshold reading has to stay pinned anyway
// because byte-identical replay is the whole point of the gate.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Send       = require('../../../src/actions/send.js');
const Destroy    = require('../../../src/actions/destroy.js');
const activation = require('../../../src/consolidation_leg_amount_activation.js');

// Any network the activation map does not carry reads as OFF, which is how these tests
// reach the legacy behavior without editing the module's thresholds.
const GATE_OFF_NETWORK = 'no-such-network';

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DEST   = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';
const DEST2  = 'n2j7X44Gm6P4E9cs2H13EkBAotYbjPZW17';

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

describe('Multi-leg consolidation: per-leg amount format @regression @tier1', function () {

    describe('activation module', function () {

        it('mainnet is UNARMED on the house sentinel', function () {
            assert.strictEqual(activation.CONSOLIDATION_LEG_AMOUNT_ACTIVATION.mainnet, 9999999999);
            assert.strictEqual(activation.isConsolidationLegAmountActive(1700000000, 'mainnet'), false);
        });

        it('testnet and regtest run from genesis', function () {
            assert.strictEqual(activation.isConsolidationLegAmountActive(0, 'testnet'), true);
            assert.strictEqual(activation.isConsolidationLegAmountActive(0, 'regtest'), true);
        });

        it('an unknown network and a non-finite blockTime both read as off', function () {
            assert.strictEqual(activation.isConsolidationLegAmountActive(1700000000, GATE_OFF_NETWORK), false);
            assert.strictEqual(activation.isConsolidationLegAmountActive('nonsense', 'regtest'), false);
        });

        it('the threshold binds at its own instant, not after it', function () {
            const map   = activation.CONSOLIDATION_LEG_AMOUNT_ACTIVATION;
            const saved = map.testnet;
            map.testnet = 1700000000;
            try {
                assert.strictEqual(activation.isConsolidationLegAmountActive(1699999999, 'testnet'), false);
                assert.strictEqual(activation.isConsolidationLegAmountActive(1700000000, 'testnet'), true);
            } finally {
                map.testnet = saved;
            }
        });
    });

    describe('SEND', function () {

        let indexer, handler, rows;

        beforeEach(function () {
            indexer = createMockIndexer();
            handler = new Send(makeActionsCtx(indexer));
            rows    = [];

            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 }));
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressBalances.resolves({ 1: 1000 });
            indexer.indexerDb.findMatchingDispensers.resolves([]);
            indexer.indexerDb.findDispenserSends.resolves([]);
            // `send` aliases `data`, so every call records the SAME object: snapshot each row at
            // call time or the assertions below would only ever see the last leg's state.
            indexer.indexerDb.createSend.callsFake(async (s) => {
                rows.push({ AMOUNT: String(s['AMOUNT']), STATUS: s['STATUS'], DESTINATION: s['DESTINATION'] });
            });
        });

        afterEach(function () { sinon.restore(); });

        async function parse(params, opts = {}) {
            if (opts.network) indexer.config['NETWORK'] = opts.network;
            const data = createBaseData({ ACTION: 'SEND', FORMAT: params[0] | 0, SOURCE });
            await handler.parse(params, data, null);
            return data['STATUS'];
        }

        it('a single 0.5 leg of a 0-decimals token is rejected (the rule that was being laundered)', async function () {
            assert.strictEqual(await parse(['0', 'TEST', '0.5', DEST, '']), 'invalid: AMOUNT (format)');
        });

        it('two 0.5 legs to one destination are each rejected instead of settling as 1', async function () {
            const status = await parse(['1', 'TEST', '0.5', DEST, '0.5', DEST, '']);
            assert.strictEqual(status, 'invalid: AMOUNT (format)');
            assert.strictEqual(rows.length, 2);
            assert.deepStrictEqual(rows.map(r => r.STATUS), ['invalid: AMOUNT (format)', 'invalid: AMOUNT (format)']);
        });

        it('control: below the threshold the same two legs still settle as one valid 1-token send', async function () {
            // The pre-fix outcome, and the byte-identical-replay guarantee. If this ever reads
            // invalid the gate has stopped gating; if the case above ever reads valid the rule
            // has stopped binding. Neither can pass vacuously.
            const status = await parse(['1', 'TEST', '0.5', DEST, '0.5', DEST, ''], { network: GATE_OFF_NETWORK });
            assert.strictEqual(status, 'valid');
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(indexer.util.bcformat(rows[0].AMOUNT, 0), '1');
        });

        it('an honest sibling leg still settles beside a rejected one', async function () {
            const status = await parse(['1', 'TEST', '0.5', DEST, '10', DEST, '']);
            assert.strictEqual(rows.length, 2);
            assert.deepStrictEqual(rows.map(r => r.STATUS).sort(),
                ['invalid: AMOUNT (format)', 'valid']);
            assert.strictEqual(status, 'valid');   // last leg parsed is the valid one
        });

        it('control: below the threshold that same pair rounds into a single 11-token send', async function () {
            // bcadd formats to the tick's DECIMALS, so 10 + 0.5 laundered to '11', not '10.5':
            // the merge does not merely hide a fractional leg, it invents supply movement.
            const status = await parse(['1', 'TEST', '0.5', DEST, '10', DEST, ''], { network: GATE_OFF_NETWORK });
            assert.strictEqual(status, 'valid');
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(indexer.util.bcformat(rows[0].AMOUNT, 0), '11');
        });

        it('two well-formed legs to one destination still consolidate, gate on', async function () {
            const status = await parse(['1', 'TEST', '50', DEST, '30', DEST, '']);
            assert.strictEqual(status, 'valid');
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(indexer.util.bcformat(rows[0].AMOUNT, 0), '80');
        });

        it('record order follows first-occurrence order, gate on and gate off alike', async function () {
            const params = ['1', 'TEST', '5', DEST, '7', DEST2, '9', DEST, ''];
            await parse(params);
            const on = rows.map(r => r.DESTINATION);
            rows = [];
            await parse(params, { network: GATE_OFF_NETWORK });
            assert.deepStrictEqual(on, rows.map(r => r.DESTINATION));
            assert.deepStrictEqual(on, [DEST, DEST2]);
        });
    });

    describe('DESTROY', function () {

        let indexer, handler, rows;

        beforeEach(function () {
            indexer = createMockIndexer();
            handler = new Destroy(makeActionsCtx(indexer));
            rows    = [];

            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 }));
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressBalances.resolves({ 1: 1000 });
            indexer.indexerDb.createDestroy.callsFake(async (d) => {
                rows.push({ AMOUNT: String(d['AMOUNT']), STATUS: d['STATUS'] });
            });
        });

        afterEach(function () { sinon.restore(); });

        async function parse(params, opts = {}) {
            if (opts.network) indexer.config['NETWORK'] = opts.network;
            const data = createBaseData({ ACTION: 'DESTROY', FORMAT: params[0] | 0, SOURCE });
            await handler.parse(params, data, null);
            return data['STATUS'];
        }

        it('two 0.5 legs of one tick are each rejected instead of merging to 1', async function () {
            const status = await parse(['1', 'TEST', '0.5', 'TEST', '0.5', '']);
            assert.strictEqual(status, 'invalid: AMOUNT (format)');
            assert.strictEqual(rows.length, 2);
            assert.deepStrictEqual(rows.map(r => r.STATUS), ['invalid: AMOUNT (format)', 'invalid: AMOUNT (format)']);
        });

        it('control: below the threshold the same two legs still burn a valid 1', async function () {
            const status = await parse(['1', 'TEST', '0.5', 'TEST', '0.5', ''], { network: GATE_OFF_NETWORK });
            assert.strictEqual(status, 'valid');
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(indexer.util.bcformat(rows[0].AMOUNT, 0), '1');
        });

        it('two well-formed legs of one tick still consolidate, gate on', async function () {
            const status = await parse(['1', 'TEST', '20', 'TEST', '30', '']);
            assert.strictEqual(status, 'valid');
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(indexer.util.bcformat(rows[0].AMOUNT, 0), '50');
        });
    });
});
