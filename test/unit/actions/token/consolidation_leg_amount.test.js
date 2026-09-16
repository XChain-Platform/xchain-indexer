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
// Multi-leg consolidation flag-day (the consolidation_leg_amount_activation row in src/protocol_changes/).
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
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const Send = require('../../../../src/actions/send/index.js');
const {
    GATE_OFF_NETWORK, SOURCE, DEST, makeActionsCtx,
} = require('./consolidation_leg_amount.test/helpers/consolidation_leg_amount_suite.js');

let indexer, handler, rows;

async function parse(params, opts = {}) {
    if (opts.network) indexer.config['NETWORK'] = opts.network;
    const data = createBaseData({ ACTION: 'SEND', FORMAT: params[0] | 0, SOURCE });
    await handler.parse(params, data, null);
    return data['STATUS'];
}

function rejectedSendLegCases() {
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
}

describe('Multi-leg consolidation: per-leg amount format @regression @tier1', function () {
    describe('SEND', rejectedSendLegCases);
});
