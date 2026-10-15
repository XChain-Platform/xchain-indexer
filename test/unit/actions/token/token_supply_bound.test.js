'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC, https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

/*
 * The MAX_TOKEN_SUPPLY bound on every supply-raising ISSUE and MINT under
 * token_supply_representation_activation. Armed, an ISSUE (first issue or a format-2
 * reissue) whose MINT_SUPPLY, or a MINT whose AMOUNT, would carry the token's total supply
 * past MAX_TOKEN_SUPPLY (1e21) is refused whether or not the token declares MAX_SUPPLY, so
 * no supply or balance reaches the 42 integer digits the DECIMAL(60,18) ledger sums hold.
 * Unarmed (mainnet and testnet, and regtest while its variable is unset) the same actions
 * keep their legacy verdicts.
 */

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const gateRegistry = require('../../../../src/consensus/gate_registry');
const Issue = require('../../../../src/actions/issue/index.js');
const Mint  = require('../../../../src/actions/mint/index.js');
const {
    LOW_BLOCK, SOURCE, makeActionsCtx, makeIssueParams,
} = require('./uncapped_max_supply.test/helpers/uncapped_max_supply_suite.js');

const ENV   = 'XC_TOKEN_SUPPLY_REPRESENTATION_REGTEST_ACTIVATION';
const KEY   = 'token_supply_representation_activation.TOKEN_SUPPLY_REPRESENTATION_ACTIVATION';
const BOUND = '1000000000000000000000';
const BOUND_LESS_5 = '999999999999999999995';
const BOUND_LESS_1 = '999999999999999999999';
const OVER_BOUND   = '1000000000000000000001';
const NINES_42     = '9'.repeat(42);

// A MINT of `amount` against a token holding `supply` under the cap `maxSupply` ('0' = uncapped).
async function runMint({ maxSupply, supply, amount, decimals = 0 }) {
    const indexer = createMockIndexer();
    const handler = new Mint(makeActionsCtx(indexer));
    indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({
        TICK: 'WIDE', TICK_ID: 1, DECIMALS: decimals, MAX_SUPPLY: maxSupply, MAX_MINT: '0',
        SUPPLY: supply, BLOCK_INDEX: 50,
    }));
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getActionCreditDebitAmount.resolves('0');
    indexer.indexerDb.getSelfMintedAmount.resolves('0');
    indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);
    const data = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });
    await handler.parse(['0', 'WIDE', amount, '', ''], data, null);
    return data.STATUS;
}

// An ISSUE against `tokenInfo` (null for a first issue) whose ledger supply reads `tokenSupply`.
async function runIssue(params, { tokenInfo = null, tokenSupply = '0', gates = {} } = {}) {
    const indexer = createMockIndexer();
    const handler = new Issue(makeActionsCtx(indexer, gates));
    indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
    indexer.indexerDb.getTokenSupply.resolves(tokenSupply);
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.isOwnershipEscrowed.resolves(false);
    indexer.indexerDb.isDistributed.resolves(false);
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    const format = Number(params[0]);
    const data = createBaseData({ ACTION: 'ISSUE', FORMAT: format, BLOCK_INDEX: LOW_BLOCK, SOURCE });
    await handler.parse(params, data, null);
    return data.STATUS;
}

// Format 2 (edit MINT params): VERSION|TICK|MAX_MINT|MINT_SUPPLY|TRANSFER_SUPPLY|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|MEMO
function reissueParams(mintSupply) {
    return ['2', 'WIDE', '', mintSupply, '', '', '', '', ''];
}

function existingToken(maxSupply, supply, decimals = 0) {
    return createTokenInfo({
        TICK: 'WIDE', OWNER: SOURCE, MAX_SUPPLY: maxSupply, SUPPLY: supply,
        DECIMALS: decimals, LOCK_MINT_SUPPLY: 0,
    });
}

function firstIssueCases() {
    it('refuses a first ISSUE of an uncapped token whose MINT_SUPPLY passes the bound', async function () {
        assert.strictEqual(await runIssue(makeIssueParams({ TICK: 'WIDE', MAX_SUPPLY: '', MAX_MINT: '', MINT_SUPPLY: OVER_BOUND })),
            'invalid: MINT_SUPPLY exceeds MAX_TOKEN_SUPPLY');
        assert.strictEqual(await runIssue(makeIssueParams({ TICK: 'WIDE', MAX_SUPPLY: '', MAX_MINT: '', MINT_SUPPLY: NINES_42 })),
            'invalid: MINT_SUPPLY exceeds MAX_TOKEN_SUPPLY');
    });

    it('accepts a first ISSUE of an uncapped token minting exactly the bound, and one unit below it', async function () {
        assert.strictEqual(await runIssue(makeIssueParams({ TICK: 'WIDE', MAX_SUPPLY: '', MAX_MINT: '', MINT_SUPPLY: BOUND })), 'valid');
        assert.strictEqual(await runIssue(makeIssueParams({ TICK: 'WIDE', MAX_SUPPLY: '', MAX_MINT: '', MINT_SUPPLY: BOUND_LESS_1 })), 'valid');
    });

    it('refuses one smallest unit past the bound at 18 decimals', async function () {
        assert.strictEqual(await runIssue(makeIssueParams({ TICK: 'WIDE', MAX_SUPPLY: '', MAX_MINT: '', DECIMALS: '18', MINT_SUPPLY: BOUND + '.000000000000000001' })),
            'invalid: MINT_SUPPLY exceeds MAX_TOKEN_SUPPLY');
        assert.strictEqual(await runIssue(makeIssueParams({ TICK: 'WIDE', MAX_SUPPLY: '', MAX_MINT: '', DECIMALS: '18', MINT_SUPPLY: BOUND_LESS_1 + '.999999999999999999' })),
            'valid');
    });
}

function reissueCases() {
    it('refuses a format-2 reissue on an uncapped token that would carry supply past the bound', async function () {
        assert.strictEqual(await runIssue(reissueParams('6'), { tokenInfo: existingToken('0', BOUND_LESS_5), tokenSupply: BOUND_LESS_5 }),
            'invalid: MINT_SUPPLY exceeds MAX_TOKEN_SUPPLY');
        assert.strictEqual(await runIssue(reissueParams(NINES_42), { tokenInfo: existingToken('0', NINES_42), tokenSupply: NINES_42 }),
            'invalid: MINT_SUPPLY exceeds MAX_TOKEN_SUPPLY');
    });

    it('accepts a format-2 reissue on an uncapped token that lands exactly on the bound', async function () {
        assert.strictEqual(await runIssue(reissueParams('5'), { tokenInfo: existingToken('0', BOUND_LESS_5), tokenSupply: BOUND_LESS_5 }), 'valid');
    });

    it('applies the bound to a capped token too, even with the cumulative MAX_SUPPLY cap off', async function () {
        const gates = { ISSUE_MINT_SUPPLY_CUMULATIVE_CAP: false };
        assert.strictEqual(await runIssue(reissueParams('1'), { tokenInfo: existingToken(BOUND, BOUND), tokenSupply: BOUND, gates }),
            'invalid: MINT_SUPPLY exceeds MAX_TOKEN_SUPPLY');
        assert.strictEqual(await runIssue(reissueParams('5'), { tokenInfo: existingToken(BOUND, BOUND_LESS_5), tokenSupply: BOUND_LESS_5, gates }),
            'valid');
    });

    it('keeps the cumulative MAX_SUPPLY refusal first on a capped token', async function () {
        assert.strictEqual(await runIssue(reissueParams('1'), { tokenInfo: existingToken(BOUND, BOUND), tokenSupply: BOUND }),
            'invalid: MINT_SUPPLY exceeds MAX_SUPPLY');
    });
}

function mintCases() {
    it('refuses a MINT on an uncapped token that would carry supply past the bound', async function () {
        assert.strictEqual(await runMint({ maxSupply: '0', supply: BOUND_LESS_1, amount: '2' }), 'invalid: mint exceeds MAX_TOKEN_SUPPLY');
        assert.strictEqual(await runMint({ maxSupply: '0', supply: '0', amount: NINES_42 }), 'invalid: mint exceeds MAX_TOKEN_SUPPLY');
    });

    it('accepts a MINT on an uncapped token that lands exactly on the bound', async function () {
        assert.strictEqual(await runMint({ maxSupply: '0', supply: BOUND_LESS_1, amount: '1' }), 'valid');
    });

    it('keeps the MAX_SUPPLY refusal on a capped token at the bound', async function () {
        assert.strictEqual(await runMint({ maxSupply: BOUND, supply: BOUND, amount: '1' }), 'invalid: mint exceeds MAX_SUPPLY');
    });
}

function unarmedCases() {
    it('is UNARMED on mainnet and testnet and UNPINNED on regtest, armed only by the variable', function () {
        for (const net of ['mainnet', 'testnet', 'regtest'])
            assert.strictEqual(gateRegistry.activeAt(KEY, net, 'BTC', 5000000, null), false, net);
        process.env[ENV] = 'armed';
        assert.strictEqual(gateRegistry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
        for (const net of ['mainnet', 'testnet'])
            assert.strictEqual(gateRegistry.activeAt(KEY, net, 'BTC', 5000000, null), false, net);
    });

    it('keeps the legacy verdicts for over-bound ISSUE, reissue and MINT', async function () {
        assert.strictEqual(await runIssue(makeIssueParams({ TICK: 'WIDE', MAX_SUPPLY: '', MAX_MINT: '', MINT_SUPPLY: NINES_42 })), 'valid');
        assert.strictEqual(await runIssue(reissueParams(NINES_42), { tokenInfo: existingToken('0', NINES_42), tokenSupply: NINES_42 }), 'valid');
        assert.strictEqual(await runMint({ maxSupply: '0', supply: NINES_42, amount: NINES_42 }), 'valid');
    });
}

describe('token_supply_representation_activation: the MAX_TOKEN_SUPPLY bound @regression @tier1', function () {
    beforeEach(function () { process.env[ENV] = 'armed'; });
    afterEach(function () { delete process.env[ENV]; sinon.restore(); });

    describe('armed: first ISSUE', firstIssueCases);
    describe('armed: reissue', reissueCases);
    describe('armed: MINT', mintCases);
});

describe('token_supply_representation_activation: unarmed @regression @tier1', function () {
    beforeEach(function () { delete process.env[ENV]; });
    afterEach(function () { delete process.env[ENV]; sinon.restore(); });

    describe('unarmed', unarmedCases);
});
