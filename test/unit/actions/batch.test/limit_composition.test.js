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
// BATCH limits composed: the ISSUE, MINT and DEPLOY caps satisfied or broken in
// one batch. Part of the Batch suite; see ../batch.test.js.

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

const TABLE = { JDOG: 614 };
const TWELVE = [];
for (let i = 1; i <= 12; i++) {
    TABLE['TKN' + i] = 100 + i;
    TWELVE.push('TKN' + i);
}

// The operator's stated use case: one top-level ISSUE, 100 children, one DEPLOY and
// twelve distinct MINTs, 114 commands, every limit satisfied at once.
function useCase() {
    const out = ['ISSUE|0|JDOG'];
    for (let i = 1; i <= 100; i++) out.push('ISSUE|0|JDOG.' + i);
    out.push('DEPLOY|0|base64|100000|x');
    for (const t of TWELVE) out.push('MINT|0|' + t + '|10');
    return out;
}

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D5 DEPLOY cap and D7 per-token MINT cap (BATCH_ISSUANCE_LIMITS)', function () {
        describe('composition of the ISSUE, MINT and DEPLOY limits', function () {
            beforeEach(function () {
                stubTickerTable(TABLE);
                // Fund the source so the spam collapse's aggregate gas pre-check is not what decides these.
                indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
            });

            it('gate ON: 1 parent + 100 children + 1 DEPLOY + 12 distinct MINTs is VALID', async function () {
                const commands = useCase();
                assert.strictEqual(commands.length, 114);

                const data = await run(true, commands);

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(actionsCtx.processAction.callCount, 114);
            });

            it('gate ON: the same batch with a SECOND DEPLOY reports the DEPLOY limit', async function () {
                const data = await run(true, useCase().concat(['DEPLOY|0|base64|100000|y']));

                assert.strictEqual(data['STATUS'], 'invalid: DEPLOY (limit)');
            });

            it('gate ON: the same batch with a REPEATED MINT reports the MINT limit', async function () {
                const data = await run(true, useCase().concat(['MINT|0|TKN3|10']));

                assert.strictEqual(data['STATUS'], 'invalid: MINT (limit)');
            });

            it('gate ON: the same batch with a second UNDOTTED ISSUE reports the ISSUE limit', async function () {
                const data = await run(true, useCase().concat(['ISSUE|0|OTHER']));

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });

            it('gate ON: padded past 250 commands, the cap beats all three', async function () {
                const commands = useCase().concat(sends(137));
                assert.strictEqual(commands.length, 251);

                const data = await run(true, commands);

                assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            });

            it('gate OFF: the use-case batch keeps the pre-flag reject (children are not exempt)', async function () {
                const data = await run(false, useCase());

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
                assert.strictEqual(actionsCtx.processAction.callCount, 0);
            });
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('D5 DEPLOY cap and D7 per-token MINT cap (BATCH_ISSUANCE_LIMITS)', function () {
        describe('composition of the ISSUE, MINT and DEPLOY limits', function () {
            beforeEach(function () {
                stubTickerTable(TABLE);
                // Fund the source so the spam collapse's aggregate gas pre-check is not what decides these.
                indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
            });

            it('gate OFF: the 251-command padded batch is still just the pre-flag ISSUE reject', async function () {
                const data = await run(false, useCase().concat(sends(137)));

                assert.strictEqual(data['STATUS'], 'invalid: ISSUE (limit)');
            });
        });
    });
});
