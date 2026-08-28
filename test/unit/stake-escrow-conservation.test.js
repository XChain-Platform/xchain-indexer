/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * A CONTRACT STAKE LOCKS TOKENS; IT DOES NOT DESTROY THEM.
 *
 * The stake path used to push a debit with no counterpart, and the cooldown
 * completion a credit with no counterpart - so a stake silently shrank total
 * supply and a maturing unstake silently grew it. The staked tokens existed
 * only in contract_stakes: in no balance, in no escrow, and outside the supply
 * equation entirely.
 *
 * THE PER-BLOCK sanityCheck COULD NOT CATCH IT, which is why it survived. That
 * check compares tokens.supply against (credits - debits + escrows) and against
 * (balances + escrows). But tokens.supply is not independent: getTokenSupply
 * COMPUTES it as credits - debits + escrows, and every handler calls
 * updateTokens right after pushing its debits. So an uncountered debit shrank
 * the ledger, supply followed it down, balances fell by the same debit, and all
 * three sides agreed while the tokens left the system.
 *
 * These tests therefore assert the LEDGER SHAPE - that a lock is a debit paired
 * with an escrow row, and a release a credit paired with a negative one - rather
 * than asserting the sanity check passes, which it did throughout the defect.
 *
 * The invariant each pair protects:  credits - debits + escrows == 0 for the
 * action, hence supply unchanged.
 *********************************************************************/

'use strict';
process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const SRC = path.resolve(__dirname, '../../src');

describe('a contract stake locks tokens rather than destroying them', function(){

    // Read the shipped sources. These are ledger-shape invariants spread across three
    // files that must agree with each other; a stub-driven unit test of any one of them
    // in isolation would pass while the trio disagreed.
    const stakeSrc   = fs.readFileSync(path.join(SRC, 'actions/stake.js'), 'utf8');
    const utilSrc    = fs.readFileSync(path.join(SRC, 'utility.js'), 'utf8');
    const journalSrc = fs.readFileSync(path.join(SRC, 'escrowJournalWriter.js'), 'utf8');

    // The contract-stake handler's ledger block: from its `let credits` through the
    // processTransactionLedgerChanges call that consumes it.
    const contractBlock = (() => {
        const i = stakeSrc.lastIndexOf('let credits = []');
        const j = stakeSrc.indexOf('processTransactionLedgerChanges', i);
        return stakeSrc.slice(i, j + 200);
    })();

    it('pairs the stake debit with an escrow row for the same tick, amount and address', function(){
        assert.ok(/debits\.push\(\[data\['TICK'\], data\['AMOUNT'\], data\['SOURCE'\]\]\)/.test(contractBlock),
            'the contract stake no longer debits the staker');
        assert.ok(/escrows\.push\(\[data\['TICK'\], data\['AMOUNT'\], data\['SOURCE'\]\]\)/.test(contractBlock),
            'the contract stake debits without escrowing: the tokens leave the supply equation');
    });

    it('hands the escrows array to the ledger writer, not just builds it', function(){
        // Building `escrows` and forgetting the fifth argument would leave the rows
        // unwritten and the leak intact, while the file still greps as if it were fixed.
        assert.ok(/processTransactionLedgerChanges\(this\.indexerDb, data, credits, debits, escrows\)/
            .test(contractBlock), 'the escrows array is never passed to the ledger writer');
    });

    it('keeps the controller-guard gas a lone debit, because that really is a burn', function(){
        // The guard fee is destroyed, so supply SHOULD fall for it. Escrowing it would be
        // the mirror-image error of the one being fixed.
        const guard = contractBlock.slice(contractBlock.indexOf('guardFee'));
        assert.ok(/debits\.push\(\[this\.config\['GAS'\], guardFee/.test(guard),
            'the guard fee stopped being debited');
        assert.ok(!/escrows\.push\(\[this\.config\['GAS'\], guardFee/.test(guard),
            'the guard fee is escrowed, but it is burned - supply must fall for it');
    });

    // Each release loop is anchored on its OWN credit call. An earlier version anchored on
    // `sweep.contractRows`, which also matches the outer if() guarding BOTH loops, so the
    // slice spanned the capability loop too and the tests answered about the wrong code.
    const loopAround = needle => {
        const i = utilSrc.indexOf(needle);
        assert.ok(i > 0, 'release loop moved or was renamed: ' + needle);
        // Wide enough to contain the whole loop body: an earlier 700-char window cut the
        // release call off mid-argument, so the test failed on its own truncation.
        return utilSrc.slice(i - 400, i + 1400);
    };

    it('releases the escrow at cooldown maturity instead of minting the tokens back', function(){
        const loop = loopAround("createCredit(creditIndex, row.tick");
        assert.ok(/createCredit\(creditIndex, row\.tick/.test(loop),
            'the release stopped crediting the staker');
        assert.ok(/createEscrow\(creditIndex, row\.tick,[\s\S]{0,160}bcsub\(0, row\.amount, 64\), row\.source_address\)/
            .test(loop),
            'the release credits without releasing escrow: it mints tokens that were never destroyed');
    });

    it('classifies STAKE and UNSTAKE in the escrow journal, or the writer halts on them', function(){
        // Not a style point. escrowJournalWriter throws on an escrow-writing action type it
        // cannot attribute, and on a live indexer that is a STOP, not a bad row - so the
        // classification has to land in the same change as the rows themselves.
        const i = journalSrc.indexOf('const SELF_ATTRIBUTING');
        const set = journalSrc.slice(i, journalSrc.indexOf(']);', i));
        assert.ok(/'STAKE'/.test(set),  'STAKE writes escrow rows but has no attribution rule');
        assert.ok(/'UNSTAKE'/.test(set), 'the UNSTAKE v2 release writes escrow rows but has no attribution rule');
    });

    it('leaves the capability path alone, which is where live history exists', function(){
        // Deliberate asymmetry, and the test states it so nobody "tidies" it. Testnet
        // already carries capability stakes; escrowing them retroactively would change
        // balances_root for blocks that are already mined.
        const loop = loopAround("createCredit(creditIndex, gas");
        assert.ok(/createCredit\(creditIndex, gas/.test(loop), 'the capability release changed shape');
        assert.ok(!/createEscrow/.test(loop),
            'the capability release now escrows: that rewrites history for stakes already on testnet');
    });
});
