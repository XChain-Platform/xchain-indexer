'use strict';

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
// OWNER_WITHDRAW_OPT_IN: a contract deployed at/after the flag day refuses its
// owner's WITHDRAW unless its stored meta declares ownerWithdraw: true, and a
// contract deployed before it keeps the owner's withdraw. Part of the WITHDRAW
// suite; see ../withdraw.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { SOURCE, CONTRACT_INDEX, TICK, BLOCK, CONTRACT_ADDRESS, OPTED_IN_META, makeData, makeWithdrawContext } = require('./helpers/withdraw_context.js');

const REFUSED = 'invalid: CONTRACT_ACTION_INDEX (owner withdraw not enabled)';
const DEPLOY_BLOCK = 90;

let indexer, actionsCtx, handler;

// Each test starts from its own mock indexer and WITHDRAW handler.
function freshWithdraw() {
    ({ indexer, actionsCtx, handler } = makeWithdrawContext());
}

// Point the default contract at a stored meta_json and deploy block.
function contractWithMeta(metaJson) {
    indexer.indexerDb.getContract.resolves({ source_id: 42, block_index: DEPLOY_BLOCK, meta_json: metaJson });
}

// Run a 5-token WITHDRAW and hand back its status and the ledger legs it wrote.
async function withdraw() {
    const ledgerSpy = sinon.spy(indexer.util, 'processTransactionLedgerChanges');
    const data = makeData({ FORMAT: 0 });
    await handler.parse(['0', CONTRACT_INDEX, TICK, '5'], data, null);
    const [, , credits, debits] = ledgerSpy.firstCall.args;
    return { status: data.STATUS, credits, debits };
}

describe('Withdraw handler @regression @tier2', function () {
    beforeEach(freshWithdraw);
    afterEach(() => sinon.restore());

    describe('OWNER_WITHDRAW_OPT_IN', function () {

        it('an opted-in contract lets its owner withdraw and moves custody', async function () {
            contractWithMeta(OPTED_IN_META);
            const r = await withdraw();
            assert.strictEqual(r.status, 'valid');
            assert.ok(r.debits.find(d => d[2] === CONTRACT_ADDRESS));
            assert.ok(r.credits.find(c => c[2] === SOURCE));
        });

        it('a contract that does not declare ownerWithdraw refuses its owner and writes no ledger legs', async function () {
            contractWithMeta(JSON.stringify({ name: 'AMM', description: 'Pool', version: '1.0.0' }));
            const r = await withdraw();
            assert.strictEqual(r.status, REFUSED);
            assert.strictEqual(r.credits.length, 0);
            assert.strictEqual(r.debits.length, 0);
            assert.ok(indexer.indexerDb.createWithdrawal.calledOnce, 'the refused withdrawal is still recorded');
        });

        it('judges the flag day at the contract DEPLOY block, not the WITHDRAW block', async function () {
            contractWithMeta(JSON.stringify({ name: 'AMM', description: 'Pool' }));
            await withdraw();
            const call = actionsCtx.protocolChanges.isEnabled.getCalls().find(c => c.args[0] === 'OWNER_WITHDRAW_OPT_IN');
            assert.ok(call, 'OWNER_WITHDRAW_OPT_IN was consulted');
            assert.strictEqual(call.args[1], DEPLOY_BLOCK);
            assert.notStrictEqual(call.args[1], BLOCK);
        });
    });
});

describe('Withdraw handler @regression @tier2', function () {
    beforeEach(freshWithdraw);
    afterEach(() => sinon.restore());

    describe('OWNER_WITHDRAW_OPT_IN edges', function () {

        it('a contract deployed before the flag day keeps the owner withdraw without declaring it', async function () {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => {
                return name !== 'OWNER_WITHDRAW_OPT_IN' && name !== 'CONTROLLER_CUSTODY_GUARD';
            });
            contractWithMeta(null);
            const r = await withdraw();
            assert.strictEqual(r.status, 'valid');
        });

        it('only the boolean true opts in', async function () {
            const refused = [
                JSON.stringify({ name: 'X', description: 'Y', ownerWithdraw: false }),
                JSON.stringify({ name: 'X', description: 'Y', ownerWithdraw: 'true' }),
                JSON.stringify({ name: 'X', description: 'Y', ownerWithdraw: 1 }),
                JSON.stringify({ name: 'X', description: 'Y', ownerWithdraw: null }),
                JSON.stringify([{ ownerWithdraw: true }]),
                '{"name":"X",',
                null,
            ];
            for (const metaJson of refused) {
                freshWithdraw();
                contractWithMeta(metaJson);
                const r = await withdraw();
                assert.strictEqual(r.status, REFUSED, 'meta_json ' + metaJson + ' must not opt in');
            }
        });

        it('a non-owner still reads the owner verdict, which is judged first', async function () {
            contractWithMeta(JSON.stringify({ name: 'AMM', description: 'Pool' }));
            indexer.indexerDb.getAddressId.resolves(7);
            const r = await withdraw();
            assert.strictEqual(r.status, 'invalid: SOURCE (not contract owner)');
        });
    });
});
