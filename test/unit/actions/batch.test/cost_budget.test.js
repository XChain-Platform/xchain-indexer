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
// BATCH R7 weighted cost budget: the arithmetic, fan-out weights and the
// weight >= 1 invariant. Part of the Batch suite; see ../batch.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const { SOURCE, useBatchHarness } = require('./helpers/batch_harness.js');

const Batch = require('../../../../src/actions/batch/index.js');

// The harness under test. useBatchHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, handler;
const bind = (h) => { ({ indexer, actionsCtx, handler } = h); };

const ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

// Every site that reads the BATCH_COST_WEIGHTING verdict in batch.js sits inside an
// `if(limitsActive)`, so the weighting gate is a strict refinement of
// BATCH_ISSUANCE_LIMITS and the reachable states are both off, limits only, and both
// on. `weightsOn` implying `limitsOn` mirrors that nesting rather than testing a
// window the handler cannot enter. (The registered instants no longer state the
// ordering on mainnet, where the 2026-09-09 genesis arm put weighting at 0 below the
// issuance gate's 2026-08-16; test/unit/batch_cost_weighting_gate.test.js drives the
// nesting through this handler for exactly that reason.)
function stubGates(limitsOn, weightsOn) {
    const known = ['BATCH', 'SEND', 'MESSAGE', 'ADDRESS', 'AIRDROP', 'BROADCAST', 'ISSUE', 'MINT', 'DEPLOY'];
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
        if (name === 'BATCH_SUBACTION_NORMALIZATION') return true;
        if (name === 'BATCH_ISSUANCE_LIMITS') return limitsOn;
        if (name === 'BATCH_COST_WEIGHTING') return weightsOn;
        return known.includes(name);
    });
    handler = new Batch(actionsCtx);
}

// SEND is uncapped by every per-ACTION rule, so only the global bound can reject these.
function sends(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push('SEND|0|TEST|' + (i + 1) + '|' + ADDR);
    return out;
}

async function run(limitsOn, weightsOn, commands, weights) {
    stubGates(limitsOn, weightsOn);
    // Weights are assigned by later rows, one class at a time. Injecting them here is
    // how this suite exercises the ARITHMETIC without depending on which classes have
    // been ratified yet, so it keeps testing the same property as the table fills in.
    if (weights) Object.assign(handler.commandWeights, weights);
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

// AIRDROP and DIVIDEND write a row PER RECIPIENT. They are weighed FLAT rather than
// per-recipient because the filtered recipient count cannot be obtained here without
// re-running each handler's own resolution, which would both duplicate consensus
// logic and perform the very work the budget exists to bound. See the table's own
// comment in batch.js for the full reasoning.

function airdrops(n, name) {
    const out = [];
    for (let i = 0; i < n; i++) out.push((name || 'AIRDROP') + '|0|TEST|10|' + (i + 1) + '|memo');
    return out;
}

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('R7 weighted cost budget (BATCH_COST_WEIGHTING)', function () {
        describe('the empty table is arithmetically the count cap it replaces', function () {
            // This is the design's own proof, stated in unit form: with every
            // weight at the default 1, the SUM over a batch IS its command count, so the budget
            // check cannot decide any ordinary batch differently from the cap it replaces.

            it('exactly 250 commands: valid, every command dispatched', async function () {
                const data = await run(true, true, sends(250));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 250);
            });

            it('251 commands: one invalid record, no sub-command runs', async function () {
                const data = await run(true, true, sends(251));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
                assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1, 'one whole-batch record');
                assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0);
            });

            it('empty elements still count, so a trailing ";" tips 250 over', async function () {
                const data = await run(true, true, sends(250).concat(['']));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });

            it('the verdict AND the error string are identical with the budget on and off', async function () {
                // The stronger form of the same claim: not "both reject" but "both reject
                // identically". A weighting that changed the string would break every client
                // that reads it, and the string is consensus.
                for (const commands of [sends(1), sends(249), sends(250), sends(251), sends(400)]) {
                    const off = await run(true, false, commands);
                    const on  = await run(true, true,  commands);
                    assert.strictEqual(on['STATUS'], off['STATUS'],
                        commands.length + ' commands decided differently by the budget');
                }
            });

            it('below BATCH_ISSUANCE_LIMITS nothing bounds the batch, budget or not', async function () {
                // The pre-flag path must stay byte-identical: an unbounded batch was legal then
                // and a replay of that era has to reproduce it.
                const data = await run(false, false, sends(400));

                assert.strictEqual(data['STATUS'], 'valid');
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('R7 weighted cost budget (BATCH_COST_WEIGHTING)', function () {
        describe('a weighted action spends the budget faster', function () {
            it('10 sub-commands at weight 25 exactly fill the budget', async function () {
                const data = await run(true, true, sends(10), { SEND: 25 });

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 10);
            });

            it('11 sub-commands at weight 25 exceed it, as one record', async function () {
                const data = await run(true, true, sends(11), { SEND: 25 });

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
                assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1);
            });

            it('the same batch is fine when the weight is not in force', async function () {
                // Pins that the rejection above comes from the WEIGHT and not from the count:
                // 11 commands is far under the cap, so without the table entry it is valid.
                const data = await run(true, true, sends(11));

                assert.strictEqual(data['STATUS'], 'valid');
            });

            it('weights are summed across mixed classes, not taken per class', async function () {
                // 5 at weight 25 plus 126 at the default is 251, one over. Neither class
                // breaches anything on its own, which is the point of a BUDGET.
                const commands = sends(5).concat(
                    Array.from({ length: 126 }, (_, i) => 'MESSAGE|0|m' + i));
                const data = await run(true, true, commands, { SEND: 25 });

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });
        });

        describe('fan-out actions carry a flat weight (operator decision 2026-08-14)', function () {
            it('10 AIRDROPs exactly fill the budget at weight 25', async function () {
                const data = await run(true, true, airdrops(10));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 10);
            });

            it('11 AIRDROPs exceed it, as one record rather than eleven', async function () {
                const data = await run(true, true, airdrops(11));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
                assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1);
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('R7 weighted cost budget (BATCH_COST_WEIGHTING)', function () {
        describe('fan-out actions carry a flat weight (operator decision 2026-08-14)', function () {
            it('DIVIDEND is weighed the same', async function () {
                const commands = [];
                for (let i = 0; i < 11; i++) commands.push('DIVIDEND|0|TEST|PAYT|1|memo');
                const data = await run(true, true, commands);

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });

            it('one fan-out plus ordinary commands is bounded by the SUM, not by either alone', async function () {
                // 25 + 226 = 251. Neither the single AIRDROP nor the 226 SENDs breaches
                // anything on its own, which is the entire point of a budget.
                const data = await run(true, true, airdrops(1).concat(sends(226)));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });

            it('one fan-out plus 225 ordinary commands still fits', async function () {
                const data = await run(true, true, airdrops(1).concat(sends(225)));

                assert.strictEqual(data['STATUS'], 'valid');
            });

            it('the DROP alias cannot dodge the weight', async function () {
                // normalizeSubAction rewrites DROP to AIRDROP, and the weight scan must read the
                // canonical name. If it read the raw one, an alias would weigh the default 1 and
                // buy 250 fan-outs in a batch for the price of 250 sends.
                const data = await run(true, true, airdrops(11, 'DROP'));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });
        });

        describe('fan-out actions carry a flat weight (operator decision 2026-08-14)', function () {
            it('below the weighting flag the same fan-out batch is unaffected', async function () {
                // The pre-flag verdict has to be reproducible byte for byte by a replay, and 11
                // AIRDROPs were never anywhere near the flat 250-command cap.
                const data = await run(true, false, airdrops(11));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 11);
            });
        });

        describe('the weight >= 1 invariant, which the count pre-filter depends on', function () {
            it('an action absent from the table weighs the default 1', async function () {
                stubGates(true, true);
                assert.strictEqual(await handler.subCommandWeight('SEND', 'SEND|0|T|1|' + ADDR, {}, true), 1);
                assert.strictEqual(await handler.subCommandWeight('NOSUCHACTION', 'NOSUCHACTION|0', {}, true), 1);
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('R7 weighted cost budget (BATCH_COST_WEIGHTING)', function () {
        describe('the weight >= 1 invariant, which the count pre-filter depends on', function () {
            it('a nonsense table entry falls back to 1 rather than admitting free work', async function () {
                // A weight of 0 or a negative would let a batch carry unbounded sub-commands of
                // that action, which is the exact failure the budget exists to prevent, and a
                // fractional one would make the sum depend on float arithmetic across nodes.
                stubGates(true, true);
                for (const bad of [0, -5, 1.5, '25', null, NaN, Infinity]) {
                    handler.commandWeights['SEND'] = bad;
                    assert.strictEqual(
                        await handler.subCommandWeight('SEND', 'SEND|0|T|1|' + ADDR, {}, true), 1,
                        'weight ' + String(bad) + ' must fall back to 1');
                }
            });

            it('an oversized batch is refused WITHOUT weighing anything', async function () {
                // Not an optimization: weighing the fan-out classes costs an as-of read per
                // sub-command, so without this filter the envelope lane's ~35,000 sub-commands
                // would each buy a database read before anything bounded them.
                stubGates(true, true);
                const spy = sinon.spy(handler, 'batchWeight');
                const data = createBaseData({
                    ACTION: 'BATCH', FORMAT: 0, SOURCE,
                    TX_DATA: 'BATCH|0|' + sends(5000).join(';'),
                });
                indexer.indexerDb.isActionAllowed.resolves(true);
                await handler.parse(['0'], data, null);

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.strictEqual(spy.callCount, 0, 'the batch was weighed despite failing the count pre-filter');
            });

            it('a batch inside the count is weighed exactly once', async function () {
                stubGates(true, true);
                const spy = sinon.spy(handler, 'batchWeight');
                const data = createBaseData({
                    ACTION: 'BATCH', FORMAT: 0, SOURCE,
                    TX_DATA: 'BATCH|0|' + sends(10).join(';'),
                });
                indexer.indexerDb.isActionAllowed.resolves(true);
                await handler.parse(['0'], data, null);

                assert.strictEqual(spy.callCount, 1);
            });
        });
    });
});
