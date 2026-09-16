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
// BATCH sub-action normalization: aliased and legacy sub-actions either side of
// BATCH_SUBACTION_NORMALIZATION. Part of the Batch suite; see ../batch.test.js.

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

// Per-name isEnabled fake: the normalization gate flips with `gateOn`;
// canonical ACTION names are activated; anything else (raw alias names,
// garbage) is unknown, matching the real registry.
function stubGate(gateOn) {
    const known = ['BATCH', 'SEND', 'MESSAGE', 'ADDRESS', 'AIRDROP', 'BROADCAST', 'ISSUE', 'MINT'];
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
        if (name === 'BATCH_SUBACTION_NORMALIZATION') return gateOn;
        return known.includes(name);
    });
    handler = new Batch(actionsCtx);
}

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('sub-action normalization (BATCH_SUBACTION_NORMALIZATION)', function () {
        it('gate ON: aliased sub-action (MSG) is rewritten and dispatched as MESSAGE', async function () {
            stubGate(true);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|MSG|2|' + ADDR + '|deadbeef',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            await handler.parse(['0'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 1);
            assert.strictEqual(actionsCtx.processAction.firstCall.args[0], 'MESSAGE');
            assert.strictEqual(data['SIBLING_ACTIONS'][0].action, 'MESSAGE');
        });

        it('gate ON: legacy SEND sub-action (no VERSION) gets VERSION 0 injected and FORMAT 0', async function () {
            stubGate(true);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|SEND|LEGACYTICK|10|' + ADDR,
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            let seen = null;
            actionsCtx.processAction = sinon.stub().callsFake(async (action, params, d) => {
                seen = { action, params: params.slice(), format: d['FORMAT'] };
            });
            handler = new Batch(actionsCtx);

            await handler.parse(['0'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(seen.action, 'SEND');
            assert.strictEqual(String(seen.params[0]), '0', 'VERSION 0 injected as first param');
            assert.strictEqual(String(seen.params[1]), 'LEGACYTICK');
            assert.strictEqual(seen.format, 0, 'FORMAT derived from injected VERSION');
            assert.strictEqual(String(data['SIBLING_ACTIONS'][0].params[0]), '0', 'sibling pre-parse also injected');
        });
    });
});

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('sub-action normalization (BATCH_SUBACTION_NORMALIZATION)', function () {
        it('gate ON: aliased TRANSFER counts toward SEND in the limit scan and dispatches as SEND', async function () {
            stubGate(true);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|TRANSFER|0|TEST|5|' + ADDR,
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            await handler.parse(['0'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.firstCall.args[0], 'SEND');
        });

        it('gate OFF: aliased sub-action keeps the historic reject (invalid: ACTION (unknown))', async function () {
            stubGate(false);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|MSG|2|' + ADDR + '|deadbeef',
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            await handler.parse(['0'], data, null);

            assert.ok(String(data['STATUS']).includes('invalid: ACTION (unknown)'));
            assert.strictEqual(actionsCtx.processAction.callCount, 0);
        });

        it('gate OFF: legacy SEND sub-action keeps the historic misparse (no VERSION injected)', async function () {
            stubGate(false);
            const data = createBaseData({
                ACTION:  'BATCH',
                FORMAT:  0,
                SOURCE,
                TX_DATA: 'BATCH|0|SEND|LEGACYTICK|10|' + ADDR,
            });
            indexer.indexerDb.isActionAllowed.resolves(true);

            let seen = null;
            actionsCtx.processAction = sinon.stub().callsFake(async (action, params) => {
                seen = { action, params: params.slice() };
            });
            handler = new Batch(actionsCtx);

            await handler.parse(['0'], data, null);

            assert.strictEqual(seen.action, 'SEND');
            assert.strictEqual(String(seen.params[0]), 'LEGACYTICK', 'pre-activation params untouched');
        });
    });
});
