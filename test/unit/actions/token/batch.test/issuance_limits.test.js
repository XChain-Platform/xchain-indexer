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
// BATCH issuance limits v2: the R2 global command cap and the R1 dotted-TICK
// exemption, each run with BATCH_ISSUANCE_LIMITS on and off. Part of the Batch
// suite; see ../batch.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { SOURCE, useBatchHarness } = require('./helpers/batch_harness.js');

const Batch = require('../../../../../src/actions/batch/index.js');

// The harness under test. useBatchHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, handler;
const bind = (h) => { ({ indexer, actionsCtx, handler } = h); };

const ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

// Per-name isEnabled fake. Sub-action normalization is ON throughout (the v2 gate
// is registered at or after it, asserted in test/unit/batchIssuanceLimitsGate), so
// `limitsOn` is the only variable: every test below is run twice, once per verdict,
// and the OFF runs pin the pre-flag consensus outcome byte-for-byte.
function stubLimits(limitsOn) {
    const known = ['BATCH', 'SEND', 'MESSAGE', 'ADDRESS', 'AIRDROP', 'BROADCAST', 'ISSUE', 'MINT'];
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
        if (name === 'BATCH_SUBACTION_NORMALIZATION') return true;
        if (name === 'BATCH_ISSUANCE_LIMITS') return limitsOn;
        return known.includes(name);
    });
    handler = new Batch(actionsCtx);
}

// n distinct SEND sub-commands; SEND is uncapped, so only the global cap can reject.
function sends(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push('SEND|0|TEST|' + (i + 1) + '|' + ADDR);
    return out;
}

function batchData(commands) {
    return createBaseData({
        ACTION:  'BATCH',
        FORMAT:  0,
        SOURCE,
        TX_DATA: 'BATCH|0|' + commands.join(';'),
    });
}

async function run(limitsOn, commands) {
    stubLimits(limitsOn);
    const data = batchData(commands);
    indexer.indexerDb.isActionAllowed.resolves(true);
    await handler.parse(['0'], data, null);
    return data;
}

// One parent plus n children, the headline shape: ISSUE JDOG; ISSUE JDOG.<n>.
function parentPlusChildren(n) {
    const out = ['ISSUE|0|JDOG'];
    for (let i = 1; i <= n; i++) out.push('ISSUE|0|JDOG.' + i);
    return out;
}

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('issuance limits v2 (BATCH_ISSUANCE_LIMITS)', function () {
        describe('R2 global command cap', function () {
            it('gate ON: exactly 250 commands → valid, every command dispatched', async function () {
                const data = await run(true, sends(250));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 250);
            });

            it('gate ON: 251 commands → single invalid record, no sub-command runs', async function () {
                const data = await run(true, sends(251));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
                assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1, 'one whole-batch record');
                assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0);
            });

            it('gate ON: empty elements count, so a trailing ";" tips 250 over the cap', async function () {
                // 250 real commands plus the empty tail element = 251 counted commands. The
                // cap error rather than the empty element's ACTION error is what proves the
                // empty was counted AND that the cap runs before the activation scan.
                const data = await run(true, sends(250).concat(['']));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });

            it('gate ON: cap error wins over the ISSUE limit error (precedence pinned)', async function () {
                const commands = ['ISSUE|0|AAA', 'ISSUE|0|BBB'].concat(sends(249));
                assert.strictEqual(commands.length, 251);

                const data = await run(true, commands);

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.ok(!String(data['STATUS']).includes('ISSUE'), 'cap error is distinguishable from the ISSUE limit error');
            });

            it('gate OFF: 251 commands stay valid and all dispatch (pre-flag verdict)', async function () {
                const data = await run(false, sends(251));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 251);
            });

            it('gate OFF: trailing ";" keeps the historic ACTION error, not a cap error', async function () {
                const data = await run(false, sends(250).concat(['']));

                assert.strictEqual(data['STATUS'], 'invalid: ACTION (unknown)');
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('issuance limits v2 (BATCH_ISSUANCE_LIMITS)', function () {
        describe('R2 global command cap', function () {
            it('gate OFF: 251 commands with two undotted ISSUEs report the ISSUE limit', async function () {
                const data = await run(false, ['ISSUE|0|AAA', 'ISSUE|0|BBB'].concat(sends(249)));

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });
        });

        describe('R1 dotted-TICK exemption', function () {
            it('gate ON: one undotted ISSUE plus 50 dotted children → valid, all 51 dispatched', async function () {
                const data = await run(true, parentPlusChildren(50));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 51);
            });

            it('gate ON: two undotted ISSUEs → invalid: ISSUE (limit)', async function () {
                const data = await run(true, ['ISSUE|0|JDOG', 'ISSUE|0|OTHER']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
            });

            it('gate ON: caret TICKs are NEVER exempt even when they contain a dot', async function () {
                const data = await run(true, ['ISSUE|0|^1.5', 'ISSUE|0|^1.6']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('gate ON: a caret-dot TICK consumes the single top-level slot', async function () {
                const data = await run(true, ['ISSUE|0|JDOG', 'ISSUE|0|^1.5']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('gate ON: a lone caret-dot ISSUE is still within the top-level limit', async function () {
                const data = await run(true, ['ISSUE|0|^1.5']);

                assert.strictEqual(data['STATUS'], 'valid');
            });

            it('gate ON: malformed ISSUE with no TICK is not exempt', async function () {
                const data = await run(true, ['ISSUE|0', 'ISSUE|0']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('issuance limits v2 (BATCH_ISSUANCE_LIMITS)', function () {
        describe('R1 dotted-TICK exemption', function () {
            it('gate ON: legacy (no VERSION) dotted ISSUEs classify off the NORMALIZED params', async function () {
                // The classifier must inject the implied VERSION 0 exactly as the dispatch
                // loop does, or TICK would be read at params[0] and JDOG.1 would count as a
                // second top-level issuance.
                const seen = [];
                actionsCtx.processAction = sinon.stub().callsFake(async (action, params) => {
                    seen.push({ action, params: params.slice() });
                });
                const data = await run(true, ['ISSUE|0|JDOG', 'ISSUE|JDOG.1', 'ISSUE|JDOG.2']);

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(seen.length, 3);
                // The classifier works on its own split copy, so the dispatch loop's params
                // are untouched by it and still carry exactly one injected VERSION.
                assert.deepStrictEqual(seen[1].params, [0, 'JDOG.1']);
                assert.deepStrictEqual(seen[2].params, [0, 'JDOG.2']);
            });
        });

        describe('R1 dotted-TICK exemption', function () {
            it('gate ON: MINT is never child-exempt; a dotted TICK counts like any other', async function () {
                // The dotted-TICK exemption is an ISSUE rule (one parent plus its children),
                // never a MINT rule. Two MINTs of ONE dotted tick are still two MINTs of one
                // token; two MINTs of DIFFERENT dotted tokens are two distinct tokens under the MINT cap,
                // and it is the resolved id that says so, not the dot.
                indexer.indexerDb.getTickerId.callsFake(async (tick) =>
                    (String(tick) === 'JDOG.1') ? 11 : (String(tick) === 'JDOG.2') ? 12 : null);

                const same = await run(true, ['MINT|0|JDOG.1|10', 'MINT|0|JDOG.1|10']);
                assert.strictEqual(same['STATUS'], 'invalid: MINT (limit)');

                const distinct = await run(true, ['MINT|0|JDOG.1|10', 'MINT|0|JDOG.2|10']);
                assert.strictEqual(distinct['STATUS'], 'valid');
            });

            it('gate OFF: one undotted plus dotted children keeps the pre-flag reject', async function () {
                const data = await run(false, parentPlusChildren(50));

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
            });

            it('gate OFF: two undotted ISSUEs keep the pre-flag reject', async function () {
                const data = await run(false, ['ISSUE|0|JDOG', 'ISSUE|0|OTHER']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('issuance limits v2 (BATCH_ISSUANCE_LIMITS)', function () {
        describe('R1 dotted-TICK exemption', function () {
            it('gate OFF: caret pair keeps the pre-flag reject', async function () {
                const data = await run(false, ['ISSUE|0|^1.5', 'ISSUE|0|^1.6']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('gate OFF: malformed no-TICK pair keeps the pre-flag reject', async function () {
                const data = await run(false, ['ISSUE|0', 'ISSUE|0']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('gate OFF: legacy dotted ISSUEs keep the pre-flag reject', async function () {
                const data = await run(false, ['ISSUE|0|JDOG', 'ISSUE|JDOG.1', 'ISSUE|JDOG.2']);

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('gate OFF: a lone dotted ISSUE stays valid (unchanged either side of the flag)', async function () {
                const data = await run(false, ['ISSUE|0|JDOG.1']);

                assert.strictEqual(data['STATUS'], 'valid');
            });
        });
    });
});
