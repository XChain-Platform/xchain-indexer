// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// test/unit/batch_probe_preflight.test/oracle_fee_disclosure.test.js
//
// Covers probe-local oracle fee totals and the decoded-transaction controls.

const Dispenser = require('../../../src/actions/dispenser/index.js');
const {
    assert, sinon, Actions, createMockIndexer, createBaseData, createTokenInfo
} = require('./helpers/preflight.js');

let indexer, actionsCtx, dispenser;
const OWNER_ADDR  = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const ORACLE_ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const BLOCK_TIME  = 1700000000;
const EXPIRATION  = BLOCK_TIME + 86400 * 30;

const modeBParams = () => String(
    `0|BTC|JDOG|1||1000|BTC||0|${OWNER_ADDR}|USD||${ORACLE_ADDR}|${EXPIRATION}|||Mode B`).split('|');

function probeData(shared){
    let d = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });
    d['FEE_PROBE'] = true;
    if(shared) d['PROBE_ORACLE_FEES'] = shared;
    return d;
}

function setupDispenserHarness() {
    indexer    = createMockIndexer();
    actionsCtx = {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
        isBatchProbeForbiddenSubAction: Actions.isBatchProbeForbiddenSubAction,
        processAction:   sinon.stub().resolves()
    };
    dispenser = new Dispenser(actionsCtx);

    indexer.indexerDb.getTokenInfo.withArgs('JDOG', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'JDOG', TICK_ID: 10, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null }));
    for(const empty of ['', null, undefined])
        indexer.indexerDb.getTokenInfo.withArgs(empty, sinon.match.any, sinon.match.any).resolves(null);
    indexer.indexerDb.getAddressBalances.resolves({ 10: '1000' });
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getTickerId.resolves(99);
    indexer.indexerDb.getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0.01' });
    indexer.indexerDb.getPricesInTimeRange = sinon.stub().resolves([{ price: '50000' }]);
}

describe('BATCH sub-command pre-flight (spec row 46) @regression @tier1', function () {

    describe('probe-local oracle fee disclosure', function () {
        beforeEach(function () {
            setupDispenserHarness();
        });

        afterEach(function () { sinon.restore(); });

        it('a probe records the fee owed even with no oracle output to read', async function () {
            const data = probeData();          // no TX_OUTPUTS: a probe has no transaction
            await dispenser.parse(modeBParams(), data, false);

            assert.strictEqual(data['STATUS'], 'valid', 'the probe answers optimistically, as designed');
            const owed = data['PROBE_ORACLE_FEES'];
            assert.ok(owed && owed[ORACLE_ADDR], 'the fee owed must be disclosed');
            assert.ok(Number(owed[ORACLE_ADDR]) > 0);
        });

        it('SUMS across sibling sub-commands paying the same oracle', async function () {
            // This is the gap being disclosed: quoteOracleFee reads no output, so each
            // sub-command alone quotes the same single fee as covered. Only the running total
            // tells a composer the batch owes N times that.
            const shared = {};
            await dispenser.parse(modeBParams(), probeData(shared), false);
            const one = shared[ORACLE_ADDR];
            await dispenser.parse(modeBParams(), probeData(shared), false);
            const two = shared[ORACLE_ADDR];

            assert.ok(Number(one) > 0, 'first sub-command recorded nothing');
            assert.strictEqual(two, indexer.util.bcformat(indexer.util.bcmul(one, '2', 8), 8),
                'two DISPENSERs on one oracle must owe twice one fee');
        });
    });
});

describe('BATCH sub-command pre-flight (spec row 46) @regression @tier1', function () {

    describe('probe-local oracle fee disclosure', function () {
        beforeEach(setupDispenserHarness);

        afterEach(function () { sinon.restore(); });

        it('records nothing when no fee is owed (belowDust / zero fee)', async function () {
            indexer.indexerDb.getOraclePrice = sinon.stub().resolves({ value: '0.05', fee: '0' });
            const data = probeData();
            await dispenser.parse(modeBParams(), data, false);
            assert.strictEqual(data['PROBE_ORACLE_FEES'], undefined,
                'a zero-fee oracle must tally nothing, matching validateOracleFee');
        });

        it('BELOW-PROBE CONTROL: a real transaction still needs the output and records nothing', async function () {
            const data = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });
            await dispenser.parse(modeBParams(), data, false);
            assert.strictEqual(data['STATUS'], 'invalid: ORACLE_ADDRESS (missing oracle fee output)');
            assert.strictEqual(data['PROBE_ORACLE_FEES'], undefined);
        });

        it('BELOW-PROBE CONTROL: a real transaction that PASSES the oracle check records nothing', async function () {
            // The control above is not enough on its own and was measured to be vacuous: with
            // no output the check fails, so the accumulate is skipped for a reason that has
            // nothing to do with FEE_PROBE. This one pays the oracle so validateOracleFee
            // genuinely returns valid, which is the only state in which the FEE_PROBE
            // condition is what stops a consensus path from writing a probe-only field.
            const data = createBaseData({ ACTION: 'DISPENSER', FORMAT: 0, SOURCE: OWNER_ADDR, BLOCK_TIME, COIN: 'BTC' });
            data['TX_OUTPUTS'] = [{ address: ORACLE_ADDR, value: '0.00001' }];
            await dispenser.parse(modeBParams(), data, false);
            assert.strictEqual(data['STATUS'], 'valid', 'the oracle check must PASS for this control to bind');
            assert.strictEqual(data['PROBE_ORACLE_FEES'], undefined,
                'a decoded transaction must never carry the probe-only disclosure');
        });
    });
});
