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
// Utility, cooldown completion: the synthetic UNSTAKE completion action carries the
// mappings_actions rows the explorer history feed joins on, for both release halves.
// Part of the Utility suite; see ../utility.test.js.

const assert = require('assert');
const sinon = require('sinon');

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const Utility = require('../../../../src/utility.js');

function fakeDb(){
    let next = 900;
    return {
        config: { GAS: 'XCHAIN' },
        sweepCompletedCooldowns: sinon.stub().resolves({
            credits: [['XCHAIN', '400', 'capSrc'], ['CTK', '3', 'conSrc']],
            capabilityRows: [63], contractRows: [65], completedId: 7,
        }),
        getMaturedUnstakeCreditRows: sinon.stub().resolves([{ action_index: 63, amount: '400', source_address: 'capSrc' }]),
        getMaturedContractUnstakeCreditRows: sinon.stub().resolves([{ action_index: 65, amount: '3', source_address: 'conSrc', tick: 'CTK' }]),
        createActionIndex: sinon.stub().callsFake(async () => next++),
        createCredit: sinon.stub().resolves(),
        createEscrow: sinon.stub().resolves(),
        createActionMapping: sinon.stub().resolves(),
        updateBalances: sinon.stub().resolves(),
        updateTokens: sinon.stub().resolves(),
        markCooldownsCompleted: sinon.stub().resolves(),
    };
}

function actionsWith(active){
    return { protocolChanges: { isEnabled: sinon.stub().resolves(active) } };
}

describe('Utility @regression @tier1', function () {
    describe('processCooldownCompletions() history mapping', function () {

        it('maps each fresh completion action to its source address and released tick', async function () {
            const db = fakeDb();
            await new Utility().processCooldownCompletions(actionsWith(true), db, 18);
            const rows = db.createActionMapping.getCalls().map(c => c.args);
            assert.deepStrictEqual(rows, [
                [900, 'address', 'capSrc'], [900, 'tick', 'XCHAIN'],
                [901, 'address', 'conSrc'], [901, 'tick', 'CTK'],
            ]);
            // The mapping rides the same action_index as the credit it indexes.
            assert.strictEqual(db.createCredit.firstCall.args[0], 900);
            assert.strictEqual(db.createCredit.secondCall.args[0], 901);
        });

        it('writes no mapping on the legacy path, whose credit reuses the already-mapped UNSTAKE index', async function () {
            const db = fakeDb();
            await new Utility().processCooldownCompletions(actionsWith(false), db, 18);
            assert.strictEqual(db.createCredit.firstCall.args[0], 63);
            assert.ok(db.createActionMapping.notCalled, 'legacy completions write no new mapping rows');
        });
    });
});
