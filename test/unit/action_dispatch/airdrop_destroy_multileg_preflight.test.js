/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/action_dispatch/airdrop_destroy_multileg_preflight.test.js
 *
 * AIRDROP and DESTROY settle each leg through the shared STATUS field, so the record ends
 * holding the LAST leg's verdict. The read-only pre-flight keeps each leg's own verdict and
 * answers for all of them, as SEND does. Driven through the real handlers, then the real
 * verdict read-back and pre-flight answer.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData, createTokenInfo } = require('../../fixtures/mocks');
const { SOURCE, freshDestroySuite } = require('../actions/token/destroy.test/helpers/destroy_suite.js');
const { nativeFeeAirdrop } = require('../actions/token/airdrop.test/helpers/native_fee_legs.js');
const batchProbe = require('../../../src/actions/batch/probe.js');
const { readDryRunVerdict, dryRunOutcome } = require('../../../src/actions/actions_class/dry_run_support.js');
const { preflightResult } = require('../../../src/actions/actions_class/quote_answers.js');

const FEE_REFUSED  = 'invalid: insufficient funds (FEE)';
const BURN_REFUSED = 'invalid: insufficient funds';

// Read the verdict and the pre-flight answer off a finished run exactly as dryRunAction and
// computePreflight do.
async function answerFor(ctx, data){
    const verdict = { status: null };
    ctx.indexerDb.getFeeRecord = async () => null;
    await readDryRunVerdict(Object.assign({ _primaryVerdict: null }, ctx), data, verdict);
    const run = dryRunOutcome(100, 1000, verdict, null, null);
    return { run, answer: preflightResult(ctx, {}, run, 'xchain', 'XCHAIN') };
}

// A three-leg AIRDROP in XCHAIN-balance mode; SOURCE can pay the fee of two legs, so the
// middle leg (two recipients, twice the fee) is the one the chain refuses.
async function airdropRun(probe){
    const { indexer, handler, data } = nativeFeeAirdrop({ nativeFeeValue: '0' });
    indexer.config['NETWORK'] = 'regtest';
    data['NETWORK'] = 'regtest';
    data['TX_OUTPUTS'] = [];
    if(probe){
        data['FEE_PROBE'] = true;
        data['DRY_RUN'] = true;
    }
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000', 9: '0.00250000' });
    indexer.indexerDb.getList.callsFake(async list => Number(list) === 2
        ? ['middle-recipient-a', 'middle-recipient-b']
        : ['single-recipient']);
    const rows = [];
    indexer.indexerDb.createAirdrop.callsFake(async airdrop => rows.push(airdrop['STATUS']));
    await handler.parse(['2', 'TEST', '10', '1', 'TEST', '10', '2', 'TEST', '10', '3', null], data, null);
    return { indexer, data, rows };
}

// A two-tick DESTROY: TEST holds enough, XTEST holds `xtestBalance`.
async function destroyRun(probe, params, balances){
    const { indexer, actionsCtx, handler } = freshDestroySuite();
    indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 }));
    indexer.indexerDb.getTokenInfo.withArgs('XTEST').resolves(createTokenInfo({ TICK: 'XTEST', TICK_ID: 2, DECIMALS: 0 }));
    indexer.indexerDb.getAddressBalances.resolves(balances);
    indexer.indexerDb.isActionAllowed.resolves(true);
    const rows = [];
    indexer.indexerDb.createDestroy.callsFake(async destroy => rows.push(destroy['STATUS']));
    const data = createBaseData({ ACTION: 'DESTROY', FORMAT: 1, SOURCE });
    if(probe){
        data['FEE_PROBE'] = true;
        data['DRY_RUN'] = true;
    }
    await handler.parse(params, data, null);
    return { actionsCtx, data, rows };
}

describe('AIRDROP and DESTROY pre-flight answers for every leg @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('a refused middle AIRDROP leg before a valid last leg is not quoted valid', async function () {
        const { indexer, data, rows } = await airdropRun(true);
        assert.deepStrictEqual(rows, ['valid', FEE_REFUSED, 'valid'], 'the chain refuses the middle leg');
        assert.strictEqual(data['STATUS'], 'valid', 'the record still ends holding the last leg');

        const { run, answer } = await answerFor({ util: indexer.util, config: indexer.config, indexerDb: indexer.indexerDb }, data);
        assert.strictEqual(run.status, FEE_REFUSED);
        assert.strictEqual(answer.valid, false);
        assert.deepStrictEqual(answer.legs.map(l => l.status), ['valid', FEE_REFUSED, 'valid']);
    });

    it('a refused first DESTROY leg before a valid last leg is not quoted valid', async function () {
        const { actionsCtx, data, rows } = await destroyRun(true,
            ['1', 'TEST', '100', 'XTEST', '20', 'memo'], { 1: '10', 2: '500' });
        assert.deepStrictEqual(rows, ['invalid: insufficient funds', 'valid']);
        assert.strictEqual(data['STATUS'], 'valid');

        const { run, answer } = await answerFor(actionsCtx, data);
        assert.strictEqual(run.status, 'invalid: insufficient funds');
        assert.strictEqual(answer.valid, false);
        assert.deepStrictEqual(answer.legs.map(l => [l.tick, l.amount, l.status]),
            [['TEST', '100', 'invalid: insufficient funds'], ['XTEST', '20', 'valid']]);
        assert.ok(!answer.legs.some(l => 'destination' in l), 'a leg with no destination names none');
    });

    it('a refused last DESTROY leg after a valid first leg names both legs', async function () {
        const { actionsCtx, data, rows } = await destroyRun(true,
            ['1', 'TEST', '10', 'XTEST', '200', 'memo'], { 1: '500', 2: '5' });
        assert.deepStrictEqual(rows, ['valid', BURN_REFUSED]);

        const { run, answer } = await answerFor(actionsCtx, data);
        assert.strictEqual(run.status, BURN_REFUSED);
        assert.strictEqual(answer.valid, false);
        assert.deepStrictEqual(answer.legs.map(l => l.status), ['valid', BURN_REFUSED]);
    });

    it('a BATCH sub-command folds the legs of a DESTROY rather than reading the last', async function () {
        const { actionsCtx, data } = await destroyRun(true,
            ['1', 'TEST', '100', 'XTEST', '20', 'memo'], { 1: '10', 2: '500' });
        batchProbe.recordSubVerdict.call({ util: actionsCtx.util }, Object.assign(data, { PROBE_SUB_VERDICTS: [] }),
            'DESTROY', 0, null);
        const sub = data['PROBE_SUB_VERDICTS'][0];
        assert.strictEqual(sub.status, 'invalid: insufficient funds');
        assert.strictEqual(sub.legs.length, 2);
    });

    it('records no leg verdicts and changes no row outside the read-only pre-flight', async function () {
        const air = await airdropRun(false);
        assert.strictEqual(air.data['PROBE_LEG_VERDICTS'], undefined);
        assert.deepStrictEqual(air.rows, ['valid', FEE_REFUSED, 'valid']);

        const des = await destroyRun(false, ['1', 'TEST', '100', 'XTEST', '20', 'memo'], { 1: '10', 2: '500' });
        assert.strictEqual(des.data['PROBE_LEG_VERDICTS'], undefined);
        assert.deepStrictEqual(des.rows, ['invalid: insufficient funds', 'valid']);
    });
});
