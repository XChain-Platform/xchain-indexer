// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { stubGate } = require('../../../../helpers/gate_modules.js');
const { SOURCE, useBatchHarness } = require('./helpers/batch_harness.js');

const Batch = require('../../../../../src/actions/batch/index.js');

let indexer, actionsCtx, handler;
const bind = (h) => { ({ indexer, actionsCtx, handler } = h); };

const ADDR = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
// Regtest arms the per-leg weight from genesis, so these flat-weight cases hold it off.
const LEG_WEIGHT_GATE = 'batch_airdrop_leg_weight_activation.BATCH_AIRDROP_LEG_WEIGHT_ACTIVATION';

function airdrop(format, legs) {
    let command;
    if (format === 0) {
        command = ['AIRDROP', '0', 'TEST0', '1', '1', 'memo'];
    } else if (format === 1) {
        command = ['AIRDROP', '1', '1'];
        for (let i = 0; i < legs; i++) command.push('TEST' + i, String(i + 1));
        command.push('memo');
    } else if (format === 2) {
        command = ['AIRDROP', '2'];
        for (let i = 0; i < legs; i++) command.push('TEST' + i, String(i + 1), String(i + 1));
        command.push('memo');
    } else {
        command = ['AIRDROP', '3'];
        for (let i = 0; i < legs; i++) command.push('TEST' + i, String(i + 1), String(i + 1), 'memo' + i);
    }
    return command.join('|');
}

function sends(n) {
    return Array.from({ length: n }, (_, i) => 'SEND|0|TEST|' + (i + 1) + '|' + ADDR);
}

function stubGates() {
    stubGate(sinon, LEG_WEIGHT_GATE, false);
    const known = ['BATCH', 'SEND', 'AIRDROP', 'DIVIDEND'];
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
        if (name === 'BATCH_SUBACTION_NORMALIZATION') return true;
        if (name === 'BATCH_ISSUANCE_LIMITS') return true;
        if (name === 'BATCH_COST_WEIGHTING') return true;
        return known.includes(name);
    });
    handler = new Batch(actionsCtx);
}

async function run(commands) {
    stubGates();
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

describe('Batch @regression @tier3', function () {
    useBatchHarness(bind);

    describe('AIRDROP leg count below the weighting gate', function () {
        it('pins weight 25 across every AIRDROP format and representative leg counts', async function () {
            stubGates();
            const cases = [[0, 1], [1, 1], [1, 3], [1, 40], [2, 4], [2, 40], [3, 5], [3, 40]];

            for (const [format, legs] of cases) {
                assert.strictEqual(
                    await handler.subCommandWeight('AIRDROP', airdrop(format, legs), {}, true),
                    25,
                    'format ' + format + ' with ' + legs + ' leg(s)');
            }
        });

        it('weighs a one-leg and a 100-leg AIRDROP identically', async function () {
            stubGates();

            assert.strictEqual(
                await handler.subCommandWeight('AIRDROP', airdrop(1, 1), {}, true),
                await handler.subCommandWeight('AIRDROP', airdrop(1, 100), {}, true));
        });

        it('pins AIRDROP and DIVIDEND to 25 in commandWeights', function () {
            stubGates();

            assert.strictEqual(handler.commandWeights['AIRDROP'], 25);
            assert.strictEqual(handler.commandWeights['DIVIDEND'], 25);
        });

        it('weighing fan-out commands reads neither token info nor balances', async function () {
            stubGates();
            indexer.indexerDb.getTokenInfo.resetHistory();
            indexer.indexerDb.getAddressBalances.resetHistory();

            assert.strictEqual(await handler.batchWeight([
                airdrop(3, 100),
                'DIVIDEND|0|TEST|PAYT|1|memo',
            ], {}, true), 50);
            assert.strictEqual(indexer.indexerDb.getTokenInfo.callCount, 0);
            assert.strictEqual(indexer.indexerDb.getAddressBalances.callCount, 0);
        });

        it('weighs DIVIDEND and the DROP alias as fan-out commands through batchWeight', async function () {
            stubGates();

            assert.strictEqual(
                await handler.batchWeight(['DIVIDEND|0|TEST|PAYT|1|memo'], {}, true), 25);
            assert.strictEqual(
                await handler.batchWeight([airdrop(2, 4).replace('AIRDROP', 'DROP')], {}, true), 25);
        });

        it('sums four mixed-format AIRDROPs and five SENDs to 105', async function () {
            stubGates();
            const commands = [
                airdrop(0, 1),
                airdrop(1, 3),
                airdrop(2, 4),
                airdrop(3, 5),
            ].concat(sends(5));

            assert.strictEqual(await handler.batchWeight(commands, {}, true), 105);
        });

        it('dispatches all ten 40-leg AIRDROPs at the budget boundary', async function () {
            const commands = Array.from({ length: 10 }, () => airdrop(1, 40));
            const data = await run(commands);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 10);
        });

        it('refuses eleven 40-leg AIRDROPs as one batch before dispatch', async function () {
            const commands = Array.from({ length: 11 }, () => airdrop(2, 40));
            const data = await run(commands);

            assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1);
            assert.strictEqual(actionsCtx.processAction.callCount, 0);
        });

        it('admits one 60-leg AIRDROP with 225 SENDs', async function () {
            const data = await run([airdrop(3, 60)].concat(sends(225)));

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(actionsCtx.processAction.callCount, 226);
        });

        it('refuses one 60-leg AIRDROP with 226 SENDs', async function () {
            const data = await run([airdrop(3, 60)].concat(sends(226)));

            assert.strictEqual(data['STATUS'], 'invalid: COMMAND (limit)');
            assert.strictEqual(indexer.indexerDb.createBatch.callCount, 1);
            assert.strictEqual(actionsCtx.processAction.callCount, 0);
        });
    });
});
