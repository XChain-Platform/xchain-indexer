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
// BATCH D5 DEPLOY cap and D7 one-MINT-per-distinct-token cap. Part of the Batch
// suite; see ../batch.test.js.

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

// Per-name gate. Normalization is ON throughout (the v2 gate is registered at or after
// it); `limitsOn` is the only variable, so every OFF run pins the pre-flag verdict for
// the identical input. DEPLOY is a known ACTION here, which is what makes the pre-flag
// "unlimited DEPLOYs are accepted" runs below real rather than an activation artefact.
function stubGates(limitsOn) {
    const known = ['BATCH', 'SEND', 'ISSUE', 'MINT', 'DEPLOY', 'ISSUANCE_FEE', 'UNIFIED_FEES'];
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
        if (name === 'BATCH_SUBACTION_NORMALIZATION') return true;
        if (name === 'BATCH_ISSUANCE_LIMITS') return limitsOn;
        return known.includes(name);
    });
    handler = new Batch(actionsCtx);
}

// Stand in for db.js getTickerId over a fixed ticker table: NAME lookups are
// case-insensitive, and a ^<id> reference resolves to that id only when a row backs it,
// which is what makes `JDOG` and `^614` two spellings of ONE token here.
function stubTickerTable(table) {
    const ids = Object.values(table);
    indexer.indexerDb.getTickerId.callsFake(async (tick) => {
        const str = String(tick);
        if (str.charAt(0) === '^') {
            const id = Number(str.substring(1));
            return ids.includes(id) ? id : null;
        }
        const hit = table[str.toUpperCase()];
        return (hit === undefined) ? null : hit;
    });
}

function mints(ticks) {
    return ticks.map((t) => 'MINT|0|' + t + '|10');
}

function deploys(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push('DEPLOY|0|base64|100000|' + i);
    return out;
}

function sends(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push('SEND|0|TEST|' + (i + 1) + '|' + ADDR);
    return out;
}

async function run(limitsOn, commands) {
    stubGates(limitsOn);
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

// Twelve real tokens, plus JDOG at id 614 for the caret-alias tests.
const TABLE = { JDOG: 614 };
const TWELVE = [];
for (let i = 1; i <= 12; i++) {
    TABLE['TKN' + i] = 100 + i;
    TWELVE.push('TKN' + i);
}

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D5 DEPLOY cap and D7 per-token MINT cap (BATCH_ISSUANCE_LIMITS)', function () {
        describe('D5: DEPLOY capped at 1', function () {
            it('gate ON: one DEPLOY in a batch is accepted', async function () {
                const data = await run(true, deploys(1).concat(sends(2)));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 3);
            });

            it('gate ON: two DEPLOYs → invalid: DEPLOY (limit), no sub-command runs', async function () {
                const data = await run(true, deploys(2));

                assert.strictEqual(data['STATUS'], 'invalid: DEPLOY (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
                assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1, 'one whole-batch record');
                assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0);
            });

            it('gate ON: the cap is a VM-cost rule, so even 250 DEPLOYs (within the command cap) reject', async function () {
                const data = await run(true, deploys(250));

                assert.strictEqual(data['STATUS'], 'invalid: DEPLOY (limit)');
            });

            it('gate ON: the 250-command cap still wins over the DEPLOY limit', async function () {
                const data = await run(true, deploys(251));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });

            it('gate ON: the gated cap is merged into a COPY, never into the stored table', async function () {
                // A cap written into this.actionLimits would apply below the flag too and fork
                // a replay, so the pre-flag table must still be free of DEPLOY afterwards.
                await run(true, deploys(2));

                assert.strictEqual(handler.actionLimits['DEPLOY'], undefined, 'pre-flag table untouched');
                assert.strictEqual(handler.gatedActionLimits['DEPLOY'], 1, 'gated table carries the cap');
            });

            it('gate OFF: unlimited DEPLOYs are accepted and all dispatch (pre-flag verdict)', async function () {
                const data = await run(false, deploys(50));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 50);
            });

            it('gate OFF: two DEPLOYs stay valid (pre-flag verdict)', async function () {
                const data = await run(false, deploys(2));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 2);
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D5 DEPLOY cap and D7 per-token MINT cap (BATCH_ISSUANCE_LIMITS)', function () {
        describe('D7: one MINT per DISTINCT token', function () {
            beforeEach(function () {
                stubTickerTable(TABLE);
            });

            it('gate ON: twelve DISTINCT ticks are accepted and all dispatch', async function () {
                const data = await run(true, mints(TWELVE));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 12);
                assert.strictEqual(indexer.indexerDb.getTickerId.callCount, 12, 'one resolution per distinct tick');
            });

            it('gate ON: two MINTs of the SAME tick → invalid: MINT (limit)', async function () {
                const data = await run(true, mints(['TKN1', 'TKN1']));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
            });

            it('gate ON: eleven distinct ticks plus ONE repeat still reject', async function () {
                const data = await run(true, mints(TWELVE.concat(['TKN7'])));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate ON: THE CARET ALIAS - JDOG and ^614 are one token, so the pair rejects', async function () {
                // The bypass this rule exists to stop: spell one scarce tick both ways and take
                // two bites at it. Judged on the RESOLVED id, the two spellings are one token.
                const data = await run(true, mints(['JDOG', '^614']));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
            });

            it('gate ON: the caret alias rejects in either order and in either case', async function () {
                const reversed = await run(true, mints(['^614', 'JDOG']));
                assert.strictEqual(reversed['STATUS'], 'invalid: MINT (limit)');

                const cased = await run(true, mints(['jdog', '^614']));
                assert.strictEqual(cased['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate ON: a caret naming a DIFFERENT token is genuinely distinct', async function () {
                const data = await run(true, mints(['JDOG', '^101']));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 2);
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D5 DEPLOY cap and D7 per-token MINT cap (BATCH_ISSUANCE_LIMITS)', function () {
        describe('D7: one MINT per DISTINCT token', function () {
            beforeEach(function () {
                stubTickerTable(TABLE);
            });

            it('gate ON: one MINT of an UNRESOLVABLE tick is accepted', async function () {
                const data = await run(true, mints(['NOSUCHTICK']));

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 1);
            });

            it('gate ON: unresolvable ticks share ONE bucket, so two of them reject', async function () {
                // No id means no evidence of distinctness. Both MINTs are invalid at execution
                // anyway, so nothing that could have landed is lost, and the bucket is what
                // stops two spellings of one REAL token slipping through when neither resolves.
                const data = await run(true, mints(['NOSUCHTICK', 'ALSOUNKNOWN']));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate ON: the intra-batch alias case (mint a tick this batch is about to ISSUE) rejects', async function () {
                // Resolution is as-of the state BEFORE the first sub-command, so FOO and the id
                // its ISSUE is about to take both resolve to nothing here, yet they would name
                // ONE token by execution time. The shared unresolved bucket is what catches it.
                const data = await run(true, ['ISSUE|0|FOO'].concat(mints(['FOO', '^9001'])));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate ON: a TICK-less MINT falls in the unresolved bucket without a read', async function () {
                const one = await run(true, ['MINT|0']);
                assert.strictEqual(one['STATUS'], 'valid');
                assert.strictEqual(indexer.indexerDb.getTickerId.callCount, 0, 'no tick, no resolution');

                const two = await run(true, ['MINT|0', 'MINT|0']);
                assert.strictEqual(two['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate ON: legacy (no VERSION) MINT params resolve TICK off the NORMALIZED shape', async function () {
                // MINT's single format is VERSION|TICK|AMOUNT|DESTINATION|MEMO, so an
                // un-normalized legacy MINT carries TICK at params[0]. Reading the raw shape
                // would compare the AMOUNT instead and let one token be minted twice.
                const data = await run(true, ['MINT|JDOG|10', 'MINT|0|^614|10']);

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D5 DEPLOY cap and D7 per-token MINT cap (BATCH_ISSUANCE_LIMITS)', function () {
        describe('D7: one MINT per DISTINCT token', function () {
            beforeEach(function () {
                stubTickerTable(TABLE);
            });

            it('gate ON: 250 MINTs of ONE tick cost exactly ONE resolution (memoized)', async function () {
                const data = await run(true, mints(new Array(250).fill('TKN1')));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
                assert.strictEqual(indexer.indexerDb.getTickerId.callCount, 1, 'memoized per tick string');
            });

            it('gate ON: resolution runs intern-suppressed and restores the prior value', async function () {
                const seen = [];
                indexer.indexerDb.suppressIndexIdCreation = false;
                indexer.indexerDb.getTickerId.callsFake(async () => {
                    seen.push(indexer.indexerDb.suppressIndexIdCreation);
                    return null;
                });

                await run(true, mints(['AAA', 'BBB']));

                assert.deepStrictEqual(seen, [true, true], 'every resolution ran resolve-only');
                assert.strictEqual(indexer.indexerDb.suppressIndexIdCreation, false, 'prior value restored');
            });

            it('gate ON: the 250-command cap wins, and costs no resolutions at all', async function () {
                const data = await run(true, mints(new Array(251).fill('TKN1')));

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
                assert.strictEqual(indexer.indexerDb.getTickerId.callCount, 0, 'no reads behind an earlier verdict');
            });

            it('gate ON: an earlier ISSUE verdict short-circuits the MINT resolution', async function () {
                const data = await run(true, ['ISSUE|0|AAA', 'ISSUE|0|BBB'].concat(mints(['TKN1', 'TKN1'])));

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
                assert.strictEqual(indexer.indexerDb.getTickerId.callCount, 0, 'no reads behind an earlier verdict');
            });

            it('gate OFF: twelve distinct ticks keep the pre-flag reject', async function () {
                const data = await run(false, mints(TWELVE));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
                assert.strictEqual(indexer.indexerDb.getTickerId.callCount, 0, 'no resolution below the flag');
            });

            it('gate OFF: the caret pair keeps the pre-flag reject', async function () {
                const data = await run(false, mints(['JDOG', '^614']));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D5 DEPLOY cap and D7 per-token MINT cap (BATCH_ISSUANCE_LIMITS)', function () {
        describe('D7: one MINT per DISTINCT token', function () {
            beforeEach(function () {
                stubTickerTable(TABLE);
            });

            it('gate OFF: two unresolvable ticks keep the pre-flag reject', async function () {
                const data = await run(false, mints(['NOSUCHTICK', 'ALSOUNKNOWN']));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate OFF: a lone MINT stays valid, resolvable or not (unchanged either side)', async function () {
                const known = await run(false, mints(['TKN1']));
                assert.strictEqual(known['STATUS'], 'valid');

                const unknown = await run(false, mints(['NOSUCHTICK']));
                assert.strictEqual(unknown['STATUS'], 'valid');

                const none = await run(false, ['MINT|0']);
                assert.strictEqual(none['STATUS'], 'valid');
            });

            it('gate OFF: the intra-batch alias batch reports the pre-flag verdict', async function () {
                const data = await run(false, ['ISSUE|0|FOO'].concat(mints(['FOO', '^9001'])));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });
        });
    });
});
