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
 * Declared-cap ISSUE boundaries and gate registration coverage. One part of
 * uncapped_max_supply.test.js; the shared fixtures are in
 * helpers/uncapped_max_supply_suite.js.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');

const Issue = require('../../../../../src/actions/issue/index.js');

const ProtocolChanges = require('../../../../../src/protocol_changes.js');
const {
    LOW_BLOCK, SOURCE, makeActionsCtx, makeIssueParams,
} = require('./helpers/uncapped_max_supply_suite.js');

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

function cappedIssueCases() {
    it('gate ON: a DECLARED cap still rejects an over-cap MINT_SUPPLY', async function () {
        const { handler } = makeIssue({ gateOn: true });
        assert.strictEqual(
            await runIssue(handler, makeIssueParams({ MAX_SUPPLY: '1000', MINT_SUPPLY: '1001' })),
            'invalid: MINT_SUPPLY > MAX_SUPPLY');
    });

    it('gate ON: a DECLARED cap still rejects MINT_ADDRESS_MAX above it', async function () {
        const { handler } = makeIssue({ gateOn: true });
        assert.strictEqual(
            await runIssue(handler, makeIssueParams({ MAX_SUPPLY: '1000', MAX_MINT: '100', MINT_ADDRESS_MAX: '2000' })),
            'invalid: MINT_ADDRESS_MAX > MAX_SUPPLY');
    });

    it('gate ON: LOCK_MAX_SUPPLY is UNTOUCHED - locking a cap that does not exist still fails', async function () {
        // Scope boundary from the operator ruling: the exemption covers the ceiling
        // comparisons, never the lock. There is nothing to freeze on an uncapped token.
        const { handler } = makeIssue({ gateOn: true });
        assert.strictEqual(
            await runIssue(handler, makeIssueParams({ MAX_SUPPLY: '0', LOCK_MAX_SUPPLY: '1' })),
            'invalid: LOCK_MAX_SUPPLY (no max supply)');
    });
}

// ---------------------------------------------------------------------
// The gate registration itself
// ---------------------------------------------------------------------
function registrationCases() {
    function pcFor(network) {
        const indexer = createMockIndexer();
        indexer.config.NETWORK = network;
        return { pc: new ProtocolChanges(indexer, '0.2.0'), indexer };
    }

    it('is a 2.0.0 time-keyed change, genesis-active on testnet and regtest', function () {
        const change = pcFor('regtest').pc.changes['UNCAPPED_MAX_SUPPLY_ZERO'];
        assert.ok(change, 'UNCAPPED_MAX_SUPPLY_ZERO must be registered');
        assert.strictEqual(change.version_major, 0);
        assert.strictEqual(change.version_minor, 2);
        assert.strictEqual(change.version_revision, 0);
        // Time-keyed: MINT/ISSUE run on BTC, LTC and DOGE, whose heights diverge.
        assert.strictEqual(change.mainnet_block, 0);
        assert.strictEqual(change.testnet_block, 0);
        assert.strictEqual(change.regtest_block, 0);
        assert.strictEqual(change.testnet_time, 0);
        assert.strictEqual(change.regtest_time, 0);
    });

    it('mainnet is still UNARMED: the operator owes the flag day, so no guessed height ships', function () {
        const sentinel = ProtocolChanges.UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME;
        assert.strictEqual(typeof sentinel, 'number', 'the sentinel must be exported');
        const change = pcFor('mainnet').pc.changes['UNCAPPED_MAX_SUPPLY_ZERO'];
        assert.strictEqual(change.mainnet_time, sentinel);
        // Far-future by construction. A value inside any plausible chain lifetime means
        // somebody armed this loosening without the operator's flag day.
        assert.ok(sentinel > 4102444800,
            'the mainnet arm must be a far-future UNARMED sentinel until the operator sets the flag day');
    });

    it('regtest: enabled from genesis', async function () {
        const { pc, indexer } = pcFor('regtest');
        indexer.decoderDb.getBlockTime.resolves(1);
        assert.strictEqual(await pc.isEnabled('UNCAPPED_MAX_SUPPLY_ZERO', 0), true);
    });

    it('mainnet: inert at every plausible block time (the loosening cannot fire early)', async function () {
        const { pc, indexer } = pcFor('mainnet');
        indexer.decoderDb.getBlockTime.resolves(4102444800); // 2100-01-01
        assert.strictEqual(await pc.isEnabled('UNCAPPED_MAX_SUPPLY_ZERO', 1000000), false);
    });
}

describe('MAX_SUPPLY=0 is the uncapped sentinel @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    describe('ISSUE cross-checks against MAX_SUPPLY', cappedIssueCases);
    describe('UNCAPPED_MAX_SUPPLY_ZERO registration', registrationCases);
});
