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

    it('applies the same rule to a CAPABILITY bond, which is locked too', function(){
        // These were briefly asymmetric while only the contract half was fixed. The operator
        // decided to roll testnet back and reparse forward, which removed the only reason to
        // keep the capability path minting - so one rule now covers both.
        const loop = loopAround("createCredit(creditIndex, gas");
        assert.ok(/createCredit\(creditIndex, gas/.test(loop), 'the capability release changed shape');
        assert.ok(/createEscrow\(creditIndex, gas,[\s\S]{0,160}bcsub\(0, row\.amount, 64\), row\.source_address\)/.test(loop),
            'the capability release credits without releasing escrow: it mints a bond that was never destroyed');
    });

    it('pairs the capability stake debit with an escrow row', function(){
        const i = stakeSrc.indexOf('let credits = []');
        const cap = stakeSrc.slice(i, stakeSrc.indexOf('processTransactionLedgerChanges', i) + 200);
        assert.ok(/debits\.push\(\[gas, data\['AMOUNT'\], data\['SOURCE'\]\]\)/.test(cap),
            'the capability stake no longer debits the staker');
        assert.ok(/escrows\.push\(\[gas, data\['AMOUNT'\], data\['SOURCE'\]\]\)/.test(cap),
            'the capability stake debits without escrowing: the bond leaves the supply equation');
        assert.ok(/processTransactionLedgerChanges\(this\.indexerDb, data, credits, debits, escrows\)/.test(cap),
            'the capability escrows array is never passed to the ledger writer');
    });

    // A SLASH DISPOSES OF LOCKED TOKENS, SO IT MUST UNLOCK THEM. Redirecting without
    // releasing is a pure mint, and it strands the burned bond in the staker's escrow.
    // Whole-ledger deltas live in actions/slash.test.js; these are the cross-file shapes.
    const slashSrc   = fs.readFileSync(path.join(SRC, 'actions/slash.js'), 'utf8');
    const executeSrc = fs.readFileSync(path.join(SRC, 'actions/execute.js'), 'utf8');

    it('the capability slash releases the bond per OWNER and hands the array to the writer', function(){
        const i = slashSrc.indexOf('let credits = [], debits = []');
        const block = slashSrc.slice(i, slashSrc.indexOf('processTransactionLedgerChanges', i) + 200);
        assert.ok(/escrows\.push\(\[gas, this\.util\.bcsub\(0, r\.amount, 64\), r\.address\]\)/.test(block),
            'the capability slash credits bounty/treasury without releasing the escrow it burns');
        assert.ok(/processTransactionLedgerChanges\(this\.indexerDb, data, credits, debits, escrows\)/.test(block),
            'the slash escrows array is never passed to the ledger writer');
        // The old model's claim, in the file's own words. Its presence means a path still
        // believes the bond was destroyed at STAKE time.
        assert.ok(!/there is NO debit here/.test(slashSrc),
            'slash.js still states the pre-lock model; one of its paths has not been converted');
    });

    it('the contract slash releases the escrow it burns, keyed to the staker', function(){
        const i = executeSrc.indexOf('_processSlashEmission');
        const fn = executeSrc.slice(i, executeSrc.indexOf('createSlashEvent', i));
        assert.ok(/createEscrow\(data\['ACTION_INDEX'\], token, this\.util\.bcsub\(0, r\.amount, 64\), r\.address\)/.test(fn),
            'the VM slash credits the destination without releasing the staker escrow: a mint');
        // Ordering matters for readability only, but the release must be inside the same
        // guarded path as the credit - i.e. after the zero-slashed early return.
        assert.ok(fn.indexOf('createEscrow(') < fn.indexOf('createCredit('),
            'the release must be written alongside the redirect, not somewhere else');
    });

    it('classifies both slash sites in the escrow journal, or the writer halts on them', function(){
        const i = journalSrc.indexOf('const SELF_ATTRIBUTING');
        const set = journalSrc.slice(i, journalSrc.indexOf(']);', i));
        assert.ok(/'SLASH'/.test(set),
            'the capability slash writes escrow rows but has no attribution rule');
        // EXECUTE is deliberately NOT in the blanket set: it is the VM's generic entry point,
        // so it gets a resolver that verifies the row really is a contract-slash release.
        assert.ok(!/'EXECUTE'/.test(set),
            'EXECUTE must not be blanket self-attributing: a future VM escrow site would be absorbed silently');
        assert.ok(/EXECUTE: async function/.test(journalSrc),
            'EXECUTE writes escrow rows but has no attribution rule');
    });
});
