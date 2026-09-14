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
// BATCH R7 weighted cost budget for the VM actions (weight 30). Part of the
// Batch suite; see ../batch.test.js.

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

const ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

// SEND is uncapped by every per-ACTION rule, so only the global bound can reject these.
function sends(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push('SEND|0|TEST|' + (i + 1) + '|' + ADDR);
    return out;
}

// A funded source with the GAS token seeded. At/after this same flag the widened spam
// collapse prices EXECUTE at its acceptance floor, so an unfunded all-EXECUTE batch
// would collapse to one invalid record for a reason that has nothing to do with the
// budget. Paying its way is what makes "valid" here mean "the WEIGHT admitted it".
function fundedForVm() {
    indexer.indexerDb.getTokenInfo
        .withArgs('XCHAIN', sinon.match.any, sinon.match.any)
        .resolves(createTokenInfo({ TICK: 'XCHAIN', TICK_ID: 1, DECIMALS: 8 }));
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
}

// The weighted-budget helper's gate stub does not know the VM actions, and an unknown ACTION
// reports 'invalid: ACTION (unknown)' instead of the budget string. This block needs
// them known, so a VALID verdict is a real verdict rather than an activation artefact.
function stubVmGates(weightsOn) {
    const known = ['BATCH', 'SEND', 'DEPLOY', 'EXECUTE', 'XEXEC', 'ISSUANCE_FEE', 'UNIFIED_FEES'];
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
        if (name === 'BATCH_SUBACTION_NORMALIZATION') return true;
        if (name === 'BATCH_ISSUANCE_LIMITS') return true;
        if (name === 'BATCH_COST_WEIGHTING') return weightsOn;
        return known.includes(name);
    });
    handler = new Batch(actionsCtx);
}

async function runVm(weightsOn, commands) {
    stubVmGates(weightsOn);
    fundedForVm();
    const data = createBaseData({
        ACTION:  'BATCH',
        FORMAT:  0,
        SOURCE,
        TX_DATA: 'BATCH|0|' + commands.join(';'),
    });
    indexer.indexerDb.isActionAllowed.resolves(true);
    await handler.parse(['0'], data, null);
    return data;
}

const execs   = (n) => Array.from({ length: n }, (_, i) => 'EXECUTE|0|7|m' + i + '|');
const deploys = (n) => Array.from({ length: n }, (_, i) => 'DEPLOY|0|base64|100000|' + i);
// DEPLOY, EXECUTE and XEXEC run contract code, which is the one class whose
// per-sub-command cost is not bounded by a row count. 30 is the operator-ratified
// consensus constant, derived in bin/measure-batch-execute-cost.js: it is the
// smallest round weight at which a full batch of worst-case VM sub-commands stays
// under the status-quo bound of 250 ordinary ones at EVERY ratio measured (8 admitted
// x 27.4 = 219 ordinary-equivalents; weight 25 would admit 10, i.e. 274).
//
// 250 / 30 = 8.33, so 8 fit (240) and 9 do not (270). Those two numbers are written
// out below rather than computed from the table, so a retune of the weight reddens
// these tests instead of silently re-deriving whatever the code now believes.

const VM_WEIGHT = 30;
const xexecs  = (n) => Array.from({ length: n }, (_, i) => 'XEXEC|0|7|m' + i + '|');

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('R7 weighted cost budget (BATCH_COST_WEIGHTING)', function () {
        describe('VM actions carry the ratified weight of 30 (D8, operator 2026-08-15)', function () {
            it('the table pins 30 for DEPLOY, EXECUTE and XEXEC', async function () {
                // The constant itself, asserted once. It decides verdicts, so moving it is a
                // consensus change and must be a deliberate edit rather than a side effect.
                stubVmGates(true);
                for (const action of ['DEPLOY', 'EXECUTE', 'XEXEC'])
                    assert.strictEqual(
                        await handler.subCommandWeight(action, action + '|0|7|m|', {}, true), VM_WEIGHT,
                        action + ' must weigh the ratified ' + VM_WEIGHT);
            });

            it('a chunk-carrier DEPLOY (format 4) weighs 1; every constructor format keeps 30', async function () {
                // Format 4 never reaches the VM: deploy.js short-circuits it into
                // DeployChunk.parse() before the constructor path, so its real cost is a row
                // write. The format is read with the same util.getFormatVersion(params[0])
                // derivation the dispatcher uses, so the scan and the handler cannot disagree.
                stubVmGates(true);
                assert.strictEqual(
                    await handler.subCommandWeight('DEPLOY', 'DEPLOY|4|deadbeef|0|2|aGVsbG8=', {}, true), 1,
                    'a chunk carrier must take the default row-write weight');
                for (const fmt of [0, 1, 2, 3])
                    assert.strictEqual(
                        await handler.subCommandWeight('DEPLOY', 'DEPLOY|' + fmt + '|base64|100000|', {}, true), VM_WEIGHT,
                        'format ' + fmt + ' must keep the VM weight');
                assert.strictEqual(
                    await handler.subCommandWeight('DEPLOY', 'DEPLOY', {}, true), VM_WEIGHT,
                    'an unparseable DEPLOY must fall through to the full weight (format 0 default)');
            });

            it('the discount decides companions: 249 fit beside a chunk carrier, 221 overflow a constructor DEPLOY', async function () {
                const RCPT = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
                const sends = (n) => Array.from({ length: n }, () => 'SEND|0|T|1|' + RCPT);

                // 1 + 249 = 250: exactly the budget, so the whole batch dispatches.
                let data = await runVm(true, ['DEPLOY|4|deadbeef|0|2|aGVsbG8='].concat(sends(249)));
                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 250);

                // 30 + 221 = 251: one over, refused as ONE record before any dispatch.
                actionsCtx.processAction.resetHistory();
                data = await runVm(true, ['DEPLOY|0|base64|100000|'].concat(sends(221)));
                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
            });
        });

        describe('VM actions carry the ratified weight of 30 (D8, operator 2026-08-15)', function () {
            it('8 EXECUTEs fit the budget exactly and all of them dispatch', async function () {
                const data = await runVm(true, execs(8));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 8);
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('R7 weighted cost budget (BATCH_COST_WEIGHTING)', function () {
        describe('VM actions carry the ratified weight of 30 (D8, operator 2026-08-15)', function () {
            it('9 EXECUTEs exceed it, as ONE record rather than nine', async function () {
                // The hole the VM weight closes: without it 250 EXECUTEs are admitted, each of which
                // may emit up to 50 fee-exempt VM-originated ISSUEs.
                const data = await runVm(true, execs(9));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
                assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1, 'one whole-batch record');
                assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0);
            });

            it('XEXEC cannot dodge the bound by being the other spelling', async function () {
                // XEXEC runs the same contract code an EXECUTE does, so leaving it at the default
                // 1 would bound the VM class for one spelling and leave it unbounded for the
                // other. This is deliberately the OPPOSITE of its treatment in the spam-collapse fee
                // predicate, where XEXEC is fee-less and pricing it would over-charge.
                const data = await runVm(true, xexecs(9));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
            });

            it('the two VM spellings are summed together, not bounded per action', async function () {
                // 5 EXECUTE + 4 XEXEC = 270. Neither spelling breaches anything on its own,
                // which is the entire point of a budget rather than a pair of caps.
                const data = await runVm(true, execs(5).concat(xexecs(4)));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });

            it('8 EXECUTEs from a paying source are admitted, so the WEIGHT is what rejects 9', async function () {
                // Paired with the 9 case above on purpose: one test alone cannot tell "the budget
                // stopped it" from "the spam collapse stopped it", and both are live at this flag.
                const data = await runVm(true, execs(8));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1);
            });

            it('one DEPLOY may still carry companions, up to 220 of them', async function () {
                // 30 + 220 = 250. The COST half of the DEPLOY rule: a DEPLOY is not free to sit beside
                // 249 sub-commands, but it is nowhere near the solo-batch action that weighing it
                // at the whole budget would have made it.
                const data = await runVm(true, deploys(1).concat(sends(220)));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 221);
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('R7 weighted cost budget (BATCH_COST_WEIGHTING)', function () {
        describe('VM actions carry the ratified weight of 30 (D8, operator 2026-08-15)', function () {
            it('one DEPLOY plus 221 companions is one over', async function () {
                const data = await runVm(true, deploys(1).concat(sends(221)));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });

            it('A3: two DEPLOYs still reject as "invalid: DEPLOY (limit)", weights and all', async function () {
                // The case that tests whether the weight subsumes the DEPLOY cap.
                // Two DEPLOYs weigh 60, well inside the budget, so the verdict still comes from
                // the per-action cap loop and the consensus STRING does not move. That is why
                // gatedActionLimits['DEPLOY'] stays: no weight can reproduce a conjunction of
                // caps (2w > 250 needs w >= 126, while "1 DEPLOY + 249 SENDs" valid needs w <= 1).
                const data = await runVm(true, deploys(2));

                assert.strictEqual(data['STATUS'], 'invalid: DEPLOY (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
                assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1);
            });

            it('9 DEPLOYs report the budget, not the cap, and that string move is deliberate', async function () {
                // 9 x 30 = 270, and the budget check runs FIRST because it is the only bound on
                // the O(N) scans behind it. So a batch that is invalid under BOTH rules reports
                // 'COMMAND (limit)' at/after this flag where it reported 'DEPLOY (limit)' before.
                // The VERDICT is unchanged in every case; only the reason moves, and only for
                // batches carrying enough VM weight to blow the budget outright.
                const data = await runVm(true, deploys(9));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');

                const off = await runVm(false, deploys(9));
                assert.strictEqual(off['STATUS'], 'invalid: DEPLOY (limit)');
            });

            it('below the weighting flag every one of these batches keeps its old verdict', async function () {
                // The byte-identity half. A replay of the pre-flag era has to reproduce all of
                // this, including the 250 EXECUTEs the flat cap admitted.
                const nine = await runVm(false, execs(9));
                assert.strictEqual(nine['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 9);

                const wide = await runVm(false, deploys(1).concat(sends(249)));
                assert.strictEqual(wide['STATUS'], 'valid');

                const many = await runVm(false, execs(250));
                assert.strictEqual(many['STATUS'], 'valid');
            });
        });
    });
});
