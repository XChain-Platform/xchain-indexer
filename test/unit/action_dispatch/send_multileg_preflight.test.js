'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Pre-flight of a multi-destination SEND answers for every leg, not the last one.
//
// The SEND handler settles each consolidated leg on its own and writes the leg's status into
// the action record's STATUS, so the record ends holding the LAST leg's verdict. The dry-run
// read that field back as the action's verdict: a multi-send whose last leg settles answered
// `valid` while the chain refused the legs before it, and the same legs in another order
// answered `invalid`. Driven here through the real SEND handler, then the real verdict
// read-back and pre-flight answer, so nothing between the leg and the answer is stubbed.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../../fixtures/mocks');
const Send = require('../../../src/actions/send/index.js');
const { readDryRunVerdict, dryRunOutcome } = require('../../../src/actions/actions_class/dry_run_support.js');
const { preflightResult } = require('../../../src/actions/actions_class/quote_answers.js');
const {
    SOURCE, DESTINATION, DEST2, makeActionsCtx, makeData, makeToken, makeBalances,
} = require('../actions/token/send.test/helpers/send_harness.js');

const REFUSED = 'invalid: DESTINATION (not authorized)';
const BLOCK_LIST_ID = 7;

let indexer, actionsCtx;

// Run one SEND wire through the real handler as the read-only pre-flight does (FEE_PROBE set
// on the record), then read its verdict and pre-flight answer exactly as dryRunAction and
// computePreflight do.
async function preflight(params, { probe = true } = {}){
    const data = makeData({ SOURCE, FORMAT: Number(params[0]) });
    if(probe) data['FEE_PROBE'] = true;
    await new Send(actionsCtx).parse(params, data, null);
    const verdict = { status: null };
    await readDryRunVerdict(Object.assign({ _primaryVerdict: null }, actionsCtx), data, verdict);
    const run = dryRunOutcome(100, 1000, verdict, null, null);
    const answer = preflightResult(actionsCtx, {}, run, 'xchain', 'XCHAIN');
    return { data, run, answer };
}

// The rows the handler wrote, one per leg, in settle order. Copied at call time: each leg
// hands createSend the action record itself, which the next leg overwrites.
let written;
function sendRows(){
    return written;
}
function recordSendRows(){
    written = [];
    indexer.indexerDb.createSend = sinon.stub().callsFake(async (send) => {
        written.push({ destination: send['DESTINATION'], status: send['STATUS'] });
    });
}

// A fresh mock indexer per test: DEST2 is on the token's block list, DESTINATION is not,
// and SOURCE holds enough for every leg.
function useMultiSendHarness(){
    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        indexer.indexerDb.getTokenInfo.resolves(makeToken({ BLOCK_LIST: BLOCK_LIST_ID }));
        indexer.indexerDb.getList = sinon.stub().callsFake(async (id) => (id === BLOCK_LIST_ID ? [DEST2] : []));
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 1000));
        indexer.indexerDb.findMatchingDispensers.resolves([]);
        indexer.indexerDb.findDispenserSends.resolves([]);
        // The fee row the read-back reads (none staged in this harness).
        indexer.indexerDb.getFeeRecord = sinon.stub().resolves(null);
        recordSendRows();
    });

    afterEach(function () { sinon.restore(); });
}

describe('SEND pre-flight answers for every leg of a multi-send @regression @tier1', function () {
    useMultiSendHarness();

    it('a refused leg before a valid last leg is not quoted valid', async function () {
        // Format 1: one tick, the block-listed destination first, an open one last.
        const { data, run, answer } = await preflight(['1', 'TEST', '1', DEST2, '1', DESTINATION, '']);

        assert.notStrictEqual(run.status, 'valid', 'the chain refuses the first leg');
        assert.strictEqual(run.status, REFUSED);
        assert.strictEqual(answer.valid, false);
        assert.strictEqual(answer.error, REFUSED);
        assert.deepStrictEqual(answer.legs.map((l) => [l.destination, l.status]),
            [[DEST2, REFUSED], [DESTINATION, 'valid']], 'each leg answers with its own verdict');

        // Consensus untouched: the record's STATUS is still the last leg's, and the rows are
        // the same two rows with the same per-leg statuses.
        assert.strictEqual(data['STATUS'], 'valid');
        assert.deepStrictEqual(sendRows(), [
            { destination: DEST2, status: REFUSED },
            { destination: DESTINATION, status: 'valid' }]);
    });

    it('the answer does not depend on leg order', async function () {
        const { run, answer } = await preflight(['1', 'TEST', '1', DESTINATION, '1', DEST2, '']);
        assert.strictEqual(run.status, REFUSED);
        assert.strictEqual(answer.valid, false);
        assert.deepStrictEqual(answer.legs.map((l) => l.status), ['valid', REFUSED]);
    });
});

describe('SEND pre-flight answers for every leg of a multi-send @regression @tier1', function () {
    useMultiSendHarness();

    it('an all-valid multi-send still answers valid, with every leg listed', async function () {
        indexer.indexerDb.getList = sinon.stub().resolves([]);
        const { run, answer } = await preflight(['1', 'TEST', '1', DEST2, '1', DESTINATION, '']);
        assert.strictEqual(run.status, 'valid');
        assert.strictEqual(answer.valid, true);
        assert.strictEqual(answer.error, null);
        assert.deepStrictEqual(answer.legs.map((l) => [l.destination, l.status, l.tick]),
            [[DEST2, 'valid', 'TEST'], [DESTINATION, 'valid', 'TEST']]);
    });

    it('a single refused leg still answers invalid', async function () {
        const { run, answer } = await preflight(['0', 'TEST', '1', DEST2, '']);
        assert.strictEqual(run.status, REFUSED);
        assert.strictEqual(answer.valid, false);
        assert.strictEqual(answer.legs.length, 1);
    });

    it('a decoded (non-probe) transaction carries no leg record and the same rows', async function () {
        const { data } = await preflight(['1', 'TEST', '1', DEST2, '1', DESTINATION, ''], { probe: false });
        assert.strictEqual(data['PROBE_LEG_VERDICTS'], undefined, 'the leg record is pre-flight only');
        assert.strictEqual(data['STATUS'], 'valid');
        assert.deepStrictEqual(sendRows(), [
            { destination: DEST2, status: REFUSED },
            { destination: DESTINATION, status: 'valid' }]);
    });
});
