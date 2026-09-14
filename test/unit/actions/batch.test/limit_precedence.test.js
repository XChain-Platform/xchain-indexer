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
// BATCH R2b: which broken per-ACTION cap names the error (first appearance).
// Part of the Batch suite; see ../batch.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const { SOURCE, useBatchHarness } = require('./helpers/batch_harness.js');

const Batch = require('../../../../src/actions/batch.js');

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

const TABLE = { JDOG: 614, PEPE: 700 };

const issues = ['ISSUE|0|AAA', 'ISSUE|0|BBB'];
const repeatMints = mints(['JDOG', 'JDOG']);

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D5 DEPLOY cap and D7 per-token MINT cap (BATCH_ISSUANCE_LIMITS)', function () {
        /*
         * Among per-ACTION caps, the error names the action whose FIRST sub-command appears
         * EARLIEST in the command list.
         *
         * The status string is consensus, so which of two broken caps names it is a rule and not
         * a formatting choice. Left implicit, it is settled by whatever order `for...in` hands back the
         * tally, which happens to be first appearance; these tests own it, so a future refactor
         * to a Map, a sort, or a second counting pass fails HERE instead of forking a chain.
         *
         * Every pair is stated in BOTH directions on purpose. One direction alone is satisfied
         * just as well by alphabetical order, by descending count, or by key insertion, so a
         * one-sided test would go on passing under any of the wrong rules.
         */
        describe('R2b: per-ACTION error precedence is FIRST APPEARANCE', function () {
            beforeEach(function () {
                stubTickerTable(TABLE);
                indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
            });

            it('DEPLOY first, ISSUE second → the DEPLOY limit', async function () {
                const data = await run(true, deploys(2).concat(issues));

                assert.strictEqual(data['STATUS'], 'invalid: DEPLOY (limit)');
            });

            it('ISSUE first, DEPLOY second → the ISSUE limit', async function () {
                const data = await run(true, issues.concat(deploys(2)));

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('INTERLEAVED: the action that appears first wins, not the cap completed first', async function () {
                // DEPLOY's second command is LAST in the list, so a rule keyed on which cap was
                // completed first would report ISSUE here.
                const d = deploys(2);
                const onDeploy = await run(true, [d[0], issues[0], issues[1], d[1]]);
                assert.strictEqual(onDeploy['STATUS'], 'invalid: DEPLOY (limit)');

                const onIssue = await run(true, [issues[0], d[0], d[1], issues[1]]);
                assert.strictEqual(onIssue['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('a LARGER overage does not jump the queue', async function () {
                // DEPLOY exceeds its cap by two and ISSUE by one; ISSUE leads, so ISSUE reports.
                const data = await run(true, issues.concat(deploys(3)));

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D5 DEPLOY cap and D7 per-token MINT cap (BATCH_ISSUANCE_LIMITS)', function () {
        describe('R2b: per-ACTION error precedence is FIRST APPEARANCE', function () {
            beforeEach(function () {
                stubTickerTable(TABLE);
                indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
            });

            it('MINT takes its turn by first appearance despite its substituted count', async function () {
                // MINT is the one cap compared against a per-DISTINCT-TOKEN maximum rather than
                // the raw occurrence count; the substitution must not move its place.
                const onMint = await run(true, repeatMints.concat(issues));
                assert.strictEqual(onMint['STATUS'], 'invalid: MINT (limit)');

                const onIssue = await run(true, issues.concat(repeatMints));
                assert.strictEqual(onIssue['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('MINT before DEPLOY reports MINT, which alphabetical order would reverse', async function () {
                const onMint = await run(true, repeatMints.concat(deploys(2)));
                assert.strictEqual(onMint['STATUS'], 'invalid: MINT (limit)');

                const onDeploy = await run(true, deploys(2).concat(repeatMints));
                assert.strictEqual(onDeploy['STATUS'], 'invalid: DEPLOY (limit)');
            });
        });

        describe('R2b: per-ACTION error precedence is FIRST APPEARANCE', function () {
            beforeEach(function () {
                stubTickerTable(TABLE);
                indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
            });

            it('uncapped and child-exempt commands take no turn in the queue', async function () {
                const d = deploys(2);
                const data = await run(true, [sends(1)[0], 'ISSUE|0|JDOG.1']
                    .concat([d[0], issues[0], issues[1], d[1]]));

                assert.strictEqual(data['STATUS'], 'invalid: DEPLOY (limit)');
            });

            it('three broken caps: the leader names the error, both directions', async function () {
                const first = await run(true, repeatMints.concat(deploys(2), issues));
                assert.strictEqual(first['STATUS'], 'invalid: MINT (limit)');

                const second = await run(true, issues.concat(deploys(2), repeatMints));
                assert.strictEqual(second['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('an unknown ACTION still outranks the leading per-action cap (R2/F7 unchanged)', async function () {
                const data = await run(true, issues.concat(deploys(2), ['NOPE|0|x']));

                assert.strictEqual(data['STATUS'], 'invalid: ACTION (unknown)');
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D5 DEPLOY cap and D7 per-token MINT cap (BATCH_ISSUANCE_LIMITS)', function () {
        describe('R2b: per-ACTION error precedence is FIRST APPEARANCE', function () {
            beforeEach(function () {
                stubTickerTable(TABLE);
                indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
            });

            it('the 250-command cap still outranks the leading per-action cap', async function () {
                const data = await run(true, issues.concat(deploys(2), sends(247)));
                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });

            it('gate OFF: the same ordering rule decides the pre-flag caps', async function () {
                // Below the flag DEPLOY is uncapped, so the pair that can still collide is
                // MINT against ISSUE. The ordering code is shared across the flag and this is
                // what says so.
                const onMint = await run(false, repeatMints.concat(issues));
                assert.strictEqual(onMint['STATUS'], 'invalid: MINT (limit)');

                const onIssue = await run(false, issues.concat(repeatMints));
                assert.strictEqual(onIssue['STATUS'], 'invalid: ISSUE (limit)');
            });
        });
    });
});
