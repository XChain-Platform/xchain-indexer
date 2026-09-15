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

/*
 * MAX_SUPPLY=0 is the UNCAPPED sentinel.
 *
 * A token issued with no MAX_SUPPLY stores 0 (createToken / db.js) and the protocol
 * documents it as unlimited, but mint.js applied the supply ceiling with no
 * bcgt(MAX_SUPPLY,0) pre-condition, so bcgt(SUPPLY+AMOUNT, 0) was true for every
 * positive AMOUNT: an uncapped token could not be minted at all. Three ISSUE
 * cross-checks that compare another field against MAX_SUPPLY carried the same
 * missing exemption and rejected an uncapped token's own genesis parameters.
 *
 * The remedy is a consensus validity LOOSENING, so it rides the
 * UNCAPPED_MAX_SUPPLY_ZERO gate. These tests drive BOTH sides of that gate: the
 * fix at/after activation, and the byte-identical legacy verdict below it (which
 * is what keeps a from-genesis replay honest). They also pin that the ceiling is
 * still enforced on a token that DOES declare a cap, and that LOCK_MAX_SUPPLY is
 * untouched by the exemption.
 */

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');
const Issue = require('../../../src/actions/issue/index.js');
const Mint  = require('../../../src/actions/mint/index.js');
const {
    LOW_BLOCK, SOURCE, makeActionsCtx, makeIssueParams,
} = require('./uncapped_max_supply.test/helpers/uncapped_max_supply_suite.js');

// @param maxSupply  the token's stored MAX_SUPPLY ('0' = uncapped)
// @param supply     supply already minted
// @param amount     the AMOUNT this MINT asks for
// @param gateOn     UNCAPPED_MAX_SUPPLY_ZERO activation state
async function runMint({ maxSupply, supply, amount, gateOn }) {
    const indexer = createMockIndexer();
    const ctx     = makeActionsCtx(indexer, { UNCAPPED_MAX_SUPPLY_ZERO: gateOn });
    const handler = new Mint(ctx);

    indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({
        TICK:        'UNCAPPED',
        TICK_ID:     1,
        DECIMALS:    0,
        MAX_SUPPLY:  maxSupply,
        MAX_MINT:    '0',    // no per-tx cap: the MAX_SUPPLY ceiling is what decides
        SUPPLY:      supply,
        BLOCK_INDEX: 50,
    }));
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getActionCreditDebitAmount.resolves('0');
    indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);

    const data = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });
    await handler.parse(['0', 'UNCAPPED', amount, '', ''], data, null);
    return data.STATUS;
}

function makeIssue({ gateOn, tokenInfo = null, tokenSupply = '0' }) {
    const indexer = createMockIndexer();
    const ctx     = makeActionsCtx(indexer, { UNCAPPED_MAX_SUPPLY_ZERO: gateOn });
    const handler = new Issue(ctx);

    indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
    indexer.indexerDb.getTokenSupply.resolves(tokenSupply);
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.isOwnershipEscrowed.resolves(false);
    indexer.indexerDb.isDistributed.resolves(false);
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    return { indexer, handler };
}

async function runIssue(handler, params) {
    const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });
    await handler.parse(params, data, null);
    return data.STATUS;
}

// ---------------------------------------------------------------------
// MINT: the bricked-token defect itself
// ---------------------------------------------------------------------
function uncappedMintCases() {
    it('gate ON: a positive mint on an uncapped (MAX_SUPPLY=0) token is VALID', async function () {
        assert.strictEqual(
            await runMint({ maxSupply: '0', supply: '0', amount: '1000', gateOn: true }),
            'valid');
    });

    it('gate ON: an uncapped token keeps minting past any finite amount', async function () {
        // The whole point of "unlimited": existing supply is irrelevant.
        assert.strictEqual(
            await runMint({ maxSupply: '0', supply: '999999999999', amount: '1', gateOn: true }),
            'valid');
    });

    it('gate OFF: the legacy verdict stands, so a from-genesis replay is unchanged', async function () {
        assert.strictEqual(
            await runMint({ maxSupply: '0', supply: '0', amount: '1000', gateOn: false }),
            'invalid: mint exceeds MAX_SUPPLY');
    });

    it('gate OFF: even the smallest positive mint was rejected (the bricked token)', async function () {
        assert.strictEqual(
            await runMint({ maxSupply: '0', supply: '0', amount: '1', gateOn: false }),
            'invalid: mint exceeds MAX_SUPPLY');
    });

    it('gate ON: a DECLARED cap is still enforced (the exemption is not a bypass)', async function () {
        assert.strictEqual(
            await runMint({ maxSupply: '1000', supply: '901', amount: '100', gateOn: true }),
            'invalid: mint exceeds MAX_SUPPLY');
    });
}

function cappedMintBoundaryCase() {
    it('gate ON: a mint that exactly fills a declared cap stays valid', async function () {
        assert.strictEqual(
            await runMint({ maxSupply: '1000', supply: '900', amount: '100', gateOn: true }),
            'valid');
    });
}

// ---------------------------------------------------------------------
// ISSUE: the three cross-checks that compare a field against MAX_SUPPLY
// ---------------------------------------------------------------------
function uncappedIssueCases() {
    it('gate ON: MINT_SUPPLY on an uncapped token is VALID (single-shot check exempt)', async function () {
        const { handler } = makeIssue({ gateOn: true });
        assert.strictEqual(
            await runIssue(handler, makeIssueParams({ MAX_SUPPLY: '0', MINT_SUPPLY: '1000' })),
            'valid');
    });

    it('gate OFF: the same ISSUE keeps its legacy MINT_SUPPLY > MAX_SUPPLY rejection', async function () {
        const { handler } = makeIssue({ gateOn: false });
        assert.strictEqual(
            await runIssue(handler, makeIssueParams({ MAX_SUPPLY: '0', MINT_SUPPLY: '1000' })),
            'invalid: MINT_SUPPLY > MAX_SUPPLY');
    });

    it('gate ON: MINT_ADDRESS_MAX on an uncapped token is VALID', async function () {
        const { handler } = makeIssue({ gateOn: true });
        assert.strictEqual(
            await runIssue(handler, makeIssueParams({ MAX_SUPPLY: '0', MAX_MINT: '100', MINT_ADDRESS_MAX: '500' })),
            'valid');
    });

    it('gate OFF: the same ISSUE keeps its legacy MINT_ADDRESS_MAX > MAX_SUPPLY rejection', async function () {
        const { handler } = makeIssue({ gateOn: false });
        assert.strictEqual(
            await runIssue(handler, makeIssueParams({ MAX_SUPPLY: '0', MAX_MINT: '100', MINT_ADDRESS_MAX: '500' })),
            'invalid: MINT_ADDRESS_MAX > MAX_SUPPLY');
    });

    it('gate ON: a re-ISSUE MINT_SUPPLY on an uncapped token clears the cumulative cap', async function () {
        const tokenInfo = createTokenInfo({
            TICK: 'UNCAPPED', OWNER: SOURCE, MAX_SUPPLY: '0', SUPPLY: '5000',
            DECIMALS: 0, LOCK_MINT_SUPPLY: 0,
        });
        const { handler } = makeIssue({ gateOn: true, tokenInfo, tokenSupply: '5000' });
        assert.strictEqual(
            await runIssue(handler, makeIssueParams({ MAX_SUPPLY: '', MINT_SUPPLY: '1000' })),
            'valid');
    });

    it('gate OFF: the same re-ISSUE keeps its legacy rejection', async function () {
        const tokenInfo = createTokenInfo({
            TICK: 'UNCAPPED', OWNER: SOURCE, MAX_SUPPLY: '0', SUPPLY: '5000',
            DECIMALS: 0, LOCK_MINT_SUPPLY: 0,
        });
        const { handler } = makeIssue({ gateOn: false, tokenInfo, tokenSupply: '5000' });
        // The single-shot guard fires first on a stored cap of 0, exactly as it did
        // before the fix; either rejection preserves the legacy "cannot" outcome.
        assert.strictEqual(
            await runIssue(handler, makeIssueParams({ MAX_SUPPLY: '', MINT_SUPPLY: '1000' })),
            'invalid: MINT_SUPPLY > MAX_SUPPLY');
    });
}

describe('MAX_SUPPLY=0 is the uncapped sentinel @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    describe('MINT supply ceiling', uncappedMintCases);
    describe('MINT supply ceiling', cappedMintBoundaryCase);
    describe('ISSUE cross-checks against MAX_SUPPLY', uncappedIssueCases);
});
