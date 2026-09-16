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
// MINT with a DESTINATION: the credit and transfer legs, a DESTINATION equal
// to SOURCE, a malformed address and a token list that refuses it.
// Part of the MINT suite; see ../mint.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { SOURCE, DESTINATION, BLOCK, makeData, makeMintContext } = require('./helpers/mint_context.js');

let indexer, actionsCtx, handler;

// Each test starts from its own mock indexer and MINT handler.
function freshMint() {
    ({ indexer, actionsCtx, handler } = makeMintContext());
}

// -----------------------------------------------------------------------
// DESTINATION
// -----------------------------------------------------------------------

describe('Mint handler @regression @tier1', function () {
    beforeEach(freshMint);
    afterEach(() => sinon.restore());

    describe('DESTINATION', function () {
        it('valid DESTINATION → credit goes to DESTINATION, debit from SOURCE', async function () {
            const ledgerSpy = sinon.spy(indexer.util, 'processTransactionLedgerChanges');

            const params = ['0', 'TEST', '50', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            const [,, credits, debits] = ledgerSpy.firstCall.args;

            // SOURCE should receive initial credit
            const sourceCredit = credits.find(c => c[2] === SOURCE);
            assert.ok(sourceCredit, 'SOURCE should receive initial credit');

            // DESTINATION should receive transfer credit
            const destCredit = credits.find(c => c[2] === DESTINATION);
            assert.ok(destCredit, 'DESTINATION should receive transfer credit');

            // SOURCE should receive debit for the transfer
            const sourceDebit = debits.find(d => d[2] === SOURCE);
            assert.ok(sourceDebit, 'SOURCE should be debited for transfer');
        });

        it('DESTINATION same as SOURCE → DESTINATION discarded, only SOURCE credited', async function () {
            const ledgerSpy = sinon.spy(indexer.util, 'processTransactionLedgerChanges');

            const params = ['0', 'TEST', '50', SOURCE, '']; // DESTINATION = SOURCE
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            const [,, credits, debits] = ledgerSpy.firstCall.args;

            // Only one credit (to SOURCE), no debit
            assert.strictEqual(credits.length, 1);
            assert.strictEqual(debits.length, 0);
        });

        it('invalid DESTINATION format → invalid', async function () {
            const params = ['0', 'TEST', '50', 'not-a-valid-address', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

describe('Mint handler @regression @tier1', function () {
    beforeEach(freshMint);
    afterEach(() => sinon.restore());

    describe('DESTINATION', function () {
        it('DESTINATION not authorized by token list → invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .onFirstCall().resolves(true)   // SOURCE sleeping check
                .onSecondCall().resolves(true)   // TICK sleeping check
                .onThirdCall().resolves(true)    // SOURCE authorization
                .onCall(3).resolves(false)        // DESTINATION authorization
                .resolves(true);

            const params = ['0', 'TEST', '50', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});
