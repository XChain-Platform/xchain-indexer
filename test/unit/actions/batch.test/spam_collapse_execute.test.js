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
// BATCH D10 spam collapse at the EXECUTE acceptance floor, and the floor probe
// fault guard. Part of the Batch suite; see ../batch.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const { SOURCE, useBatchHarness } = require('./helpers/batch_harness.js');

const Batch = require('../../../../src/actions/batch.js');

// The harness under test. useBatchHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, handler;
const bind = (h) => { ({ indexer, actionsCtx, handler } = h); };

// VM_EXECUTE_BASE 1000 gas x GAS_PRICE 0.00001 XCHAIN. Written out rather than
// recomputed from the config, so a schedule change reddens these tests instead of
// silently re-deriving whatever the code now believes. This is the SAME number
// execute.js (~209-211) charges before it enters the VM.
const EXECUTE_FEE = '0.01000000';

const exec  = (n) => 'EXECUTE|0|7|method' + n + '|';
const xexec = (n) => 'XEXEC|0|7|method' + n + '|';

function stubGates(weightsOn) {
    const known = ['BATCH', 'SEND', 'ISSUE', 'MINT', 'ORDER', 'EXECUTE', 'XEXEC',
                   'ISSUANCE_FEE', 'UNIFIED_FEES'];
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
        if (name === 'BATCH_SUBACTION_NORMALIZATION') return true;
        if (name === 'BATCH_ISSUANCE_LIMITS') return true;
        if (name === 'BATCH_COST_WEIGHTING') return weightsOn;
        return known.includes(name);
    });
    handler = new Batch(actionsCtx);
}

// The GAS token, as-of this block. execute.js gates its whole fee block on this same
// read (`tokenInfo &&`), so the floor is knowable only when the token exists; every
// test that expects a price must therefore seed it, and the one that does not seed it
// is the negative case below.
function gasTokenExists() {
    indexer.indexerDb.getTokenInfo
        .withArgs('XCHAIN', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'XCHAIN', TICK_ID: 1, DECIMALS: 8 }));
}

function repeat(fn, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(fn(i));
    return out;
}

async function run(weightsOn, commands, balance, extra) {
    stubGates(weightsOn);
    const data = createBaseData(Object.assign({
        ACTION:  'BATCH',
        FORMAT:  0,
        SOURCE,
        TX_DATA: 'BATCH|0|' + commands.join(';'),
    }, extra || {}));
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getAddressBalances.resolves(balance === null ? {} : { 1: balance });
    await handler.parse(['0'], data, null);
    return data;
}

function gasTokenThrows(err) {
    indexer.indexerDb.getTokenInfo
        .withArgs('XCHAIN', sinon.match.any, sinon.match.any)
        .rejects(err);
}

function dbError(errno) {
    const e = new Error('mariadb errno ' + errno);
    e.errno = errno;
    return e;
}

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D10 spam collapse widened to the EXECUTE floor (BATCH_COST_WEIGHTING)', function () {
        it('gate OFF: an all-EXECUTE no-gas batch keeps the pre-flag verdict, N records and all', async function () {
            // The byte-identity half of the pair. Below its own flag the widening may not move
            // a single verdict, and it may not even read a balance to decide that.
            gasTokenExists();
            const data = await run(false, repeat(exec, 3), '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 3);
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0,
                'the widened pre-check must not even read a balance below its flag');
        });

        it('gate ON: an all-EXECUTE no-gas batch collapses to ONE invalid record (A7)', async function () {
            // The vector this whole spec exists for: 250 EXECUTEs a source cannot pay for
            // currently buy 250 invalid rows of block-loop work for nothing.
            gasTokenExists();
            const data = await run(true, repeat(exec, 3), '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: GAS (insufficient)');
            assert.strictEqual(actionsCtx.processAction.callCount, 0, 'no sub-command runs');
            assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1,
                'one whole-batch record, not three invalid rows');
            assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0);
        });

        it('gate ON: exactly the acceptance floor is affordable (boundary)', async function () {
            gasTokenExists();
            const data = await run(true, repeat(exec, 3), EXECUTE_FEE);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 3,
                'the handlers decide which of the three can actually pay');
        });

        it('gate ON: one satoshi under the floor is rejected (no off-by-one)', async function () {
            gasTokenExists();
            const data = await run(true, repeat(exec, 3), '0.00999999');

            assert.strictEqual(data['STATUS'], 'invalid: GAS (insufficient)');
        });

        it('gate ON: XEXEC is deliberately NOT priced, because it is fee-less on this chain', async function () {
            // xexec.js injects with IS_EMISSION true and pays nothing here (:213, :221): it runs
            // against the cross-chain request's gas_escrow, not a wallet. Pricing it would be an
            // OVER-estimate, the one error this predicate may never make. This test is what
            // makes that a decision rather than an accident: adding XEXEC to vmBaseFeeActions
            // reddens it.
            gasTokenExists();
            const data = await run(true, repeat(xexec, 3), '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 3);
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D10 spam collapse widened to the EXECUTE floor (BATCH_COST_WEIGHTING)', function () {
        it('gate ON: no GAS token as-of this block means the floor is UNKNOWN, never a collapse', async function () {
            // Deliberately does NOT call gasTokenExists(). execute.js charges nothing when the
            // gas token has no valid issuance, so an EXECUTE really can be valid on an empty
            // balance and quoting a positive fee would be an over-estimate.
            const data = await run(true, repeat(exec, 3), '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 3);
        });

        it('gate ON: an EXECUTE beside an unpriceable sub-command still lets the batch through', async function () {
            // SEND's cost is not knowable here, and one unknown is enough to bail: the collapse fires
            // only when EVERY sub-command is provably fee-bearing.
            gasTokenExists();
            const data = await run(true, [exec(0), 'SEND|0|TEST|10|' + SOURCE], '0.00000000');

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 2);
        });

        it('gate ON: the EXECUTE floor sets the bar when it is the cheapest class', async function () {
            // A child ISSUE costs 0.5 and the EXECUTE floor 0.01. A source holding 0.01 can land
            // the EXECUTE, so collapsing the batch would destroy work that would have succeeded.
            gasTokenExists();
            const data = await run(true, ['ISSUE|0|JDOG.1', exec(0)], EXECUTE_FEE);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 2);

            const broke = await run(true, ['ISSUE|0|JDOG.1', exec(0)], '0.00999999');
            assert.strictEqual(broke['STATUS'], 'invalid: GAS (insufficient)');
        });

        it('gate ON: a full batch of EXECUTEs pays for ONE token probe, not one per sub-command', async function () {
            // The floor is a schedule constant, identical for every sub-command, so the one read
            // it needs is memoized for the whole batch. Without that, the pre-check would buy a
            // database read per sub-command - precisely the O(commands x reads) work it exists
            // to avoid.
            //
            // EIGHT, not 250, and the number moved for a REASON worth recording: at this same
            // flag the VM cost weight is 30, so 8 is the largest all-EXECUTE batch that clears
            // the budget at all. A 250-EXECUTE fixture now dies at the budget check before this
            // pre-check is ever reached, which would leave the memoization untested rather than
            // proven. "A full batch" still means exactly that, it is just a smaller full batch.
            gasTokenExists();
            await run(true, repeat(exec, 8), '0.00000000');

            assert.strictEqual(indexer.indexerDb.getTokenInfo.callCount, 1,
                'one GAS-token probe for the whole batch');
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 1,
                'one balance read for the whole batch');
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D10 spam collapse widened to the EXECUTE floor (BATCH_COST_WEIGHTING)', function () {
        it('gate ON: an emitted transaction never reaches the floor at all', async function () {
            // execute.js sets skipFee for IS_EMISSION, so an emitted EXECUTE pays nothing. The
            // predicate bails on IS_EMISSION at the TRANSACTION level, and batch.js dispatches
            // every sub-command off that one data object, so the flag can never differ per
            // sub-command and the skipFee case cannot be mispriced.
            gasTokenExists();
            const data = await run(true, repeat(exec, 3), '0.00000000', { IS_EMISSION: true });

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0);
        });

        it('gate ON: native-coin fee mode stays out of scope for the VM floor too', async function () {
            gasTokenExists();
            stubGates(true);
            const data = createBaseData({
                ACTION:     'BATCH',
                FORMAT:     0,
                SOURCE,
                TX_DATA:    'BATCH|0|' + repeat(exec, 3).join(';'),
                TX_OUTPUTS: [{ address: indexer.config['ADDRESS']['FEE_DESTINATION'], value: '0.001' }],
            });
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressBalances.resolves({});

            await handler.parse(['0'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0,
                'no gas read at all in native mode');
        });

        it('gate ON: an earlier verdict still short-circuits the VM floor', async function () {
            gasTokenExists();
            const data = await run(true, repeat(exec, 251), '0.00000000');

            assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            assert.strictEqual(indexer.indexerDb.getTokenInfo.callCount, 0);
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0);
        });

        // The floor's ONE database read is the fork seam. nominalExecuteFee catches so a
        // deterministic failure degrades to the unwidened null verdict instead of halting the
        // block loop, but null is also what a transient DB fault produces, and null short-
        // circuits the predicate to false: the faulted node writes 'valid' and dispatches every
        // sub-command while a healthy peer writes one collapsed invalid record. That is a
        // validator-local verdict committed into the block, the exact class consensus/fault_guard.js is
        // for, and the sibling ISSUE probe already avoids it by calling probeTokenInfo unwrapped.
        describe('the EXECUTE floor probe must not swallow an infrastructure fault', function () {
            it('a deadlock (1213) propagates instead of becoming a node-local valid verdict', async function () {
                gasTokenThrows(dbError(1213));
                await assert.rejects(() => run(true, repeat(exec, 3), '0.00000000'), /1213/);
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D10 spam collapse widened to the EXECUTE floor (BATCH_COST_WEIGHTING)', function () {
        describe('the EXECUTE floor probe must not swallow an infrastructure fault', function () {
            it('a lock-wait timeout (1205) propagates too', async function () {
                gasTokenThrows(dbError(1205));
                await assert.rejects(() => run(true, repeat(exec, 3), '0.00000000'), /1205/);
            });

            it('an executor host fault propagates on its code, not an errno', async function () {
                const e = new Error('executor unavailable');
                e.code = 'EXECUTOR_UNAVAILABLE';
                gasTokenThrows(e);
                await assert.rejects(() => run(true, repeat(exec, 3), '0.00000000'), /executor unavailable/);
            });

            it('the benign older-schema gaps (1146, 1054) are still absorbed as UNKNOWN', async function () {
                // faultGuard leaves these two to the caller: a missing table or column is an
                // older-schema gap, not a transient fault, so every node on that schema answers
                // the same way and the unwidened null verdict stays deterministic.
                for(const errno of [1146, 1054]){
                    gasTokenThrows(dbError(errno));
                    const data = await run(true, repeat(exec, 3), '0.00000000');
                    assert.strictEqual(data['STATUS'], 'valid', 'errno ' + errno + ' must not collapse the batch');
                }
            });

            it('an errno-less deterministic throw is still absorbed, so the block loop cannot halt on it', async function () {
                // The property the original catch existed for, and the one the guard must not
                // take away: contract-shaped failures carry no errno and no fault code.
                gasTokenThrows(new Error('deterministic failure with no errno'));
                const data = await run(true, repeat(exec, 3), '0.00000000');

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 3);
            });
        });
    });
});
