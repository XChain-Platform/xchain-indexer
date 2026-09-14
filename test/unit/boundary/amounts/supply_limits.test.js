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
// ISSUE supply limits live here. MINT supply boundaries (to MAX_SUPPLY, one over,
// 18-decimal precision and the per-address cap) live beside it in
// supply_limits.test/mint_supply.test.js, and SEND balance and DESTROY supply
// boundaries in send_and_destroy.test.js. Every file opens the same
// 'Supply & amount boundary tests @regression @tier1' describe, so each full test
// title stays under one suite name; supply_limits.test/helpers/supply_context.js
// holds the actions context and addresses they share.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../../fixtures/mocks');
const { makeActionsCtx, LOW_BLOCK, SOURCE } = require('./supply_limits.test/helpers/supply_context.js');

// Import action handlers
const Issue   = require('../../../../src/actions/issue/index.js');

// ---------------------------------------------------------------------------
// Issue format 0 param builder
// Fields: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|
//         TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|
//         LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|
//         ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|
//         LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
// ---------------------------------------------------------------------------
function makeIssueParams(overrides = {}) {
    const defaults = {
        VERSION: '0', TICK: 'NEWTOKEN', MAX_SUPPLY: '1000', MAX_MINT: '100',
        DECIMALS: '0', DESCRIPTION: 'Test', MINT_SUPPLY: '', TRANSFER: '',
        TRANSFER_SUPPLY: '', LOCK_MAX_SUPPLY: '', LOCK_MAX_MINT: '',
        LOCK_DESCRIPTION: '', LOCK_SLEEP: '', LOCK_CALLBACK: '',
        CALLBACK_BLOCK: '', CALLBACK_TICK: '', CALLBACK_AMOUNT: '',
        ALLOW_LIST: '', BLOCK_LIST: '', MINT_ADDRESS_MAX: '',
        MINT_START_BLOCK: '', MINT_STOP_BLOCK: '', LOCK_MINT: '',
        LOCK_MINT_SUPPLY: '', MEMO: '',
    };
    const m = Object.assign({}, defaults, overrides);
    return [m.VERSION, m.TICK, m.MAX_SUPPLY, m.MAX_MINT, m.DECIMALS,
        m.DESCRIPTION, m.MINT_SUPPLY, m.TRANSFER, m.TRANSFER_SUPPLY,
        m.LOCK_MAX_SUPPLY, m.LOCK_MAX_MINT, m.LOCK_DESCRIPTION,
        m.LOCK_SLEEP, m.LOCK_CALLBACK, m.CALLBACK_BLOCK, m.CALLBACK_TICK,
        m.CALLBACK_AMOUNT, m.ALLOW_LIST, m.BLOCK_LIST, m.MINT_ADDRESS_MAX,
        m.MINT_START_BLOCK, m.MINT_STOP_BLOCK, m.LOCK_MINT, m.LOCK_MINT_SUPPLY,
        m.MEMO];
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Supply & amount boundary tests @regression @tier1', function () {
    // -----------------------------------------------------------------------
    // ISSUE supply limits: minimum, maximum, over-maximum and zero supply
    // -----------------------------------------------------------------------

    describe('AMT-01: Issue token with minimum supply', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Issue(actionsCtx);

            // New token (not previously issued)
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        });

        afterEach(function () {
            sinon.restore();
        });

        it('MAX_SUPPLY = MIN_TOKEN_SUPPLY (10^-18) with DECIMALS=18 → valid', async function () {
            const params = makeIssueParams({
                TICK:       'MINTOK',
                MAX_SUPPLY: '0.000000000000000001',
                MAX_MINT:   '0.000000000000000001',
                DECIMALS:   '18',
            });
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

describe('Supply & amount boundary tests @regression @tier1', function () {
    describe('AMT-02: Issue token with maximum supply', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Issue(actionsCtx);

            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        });

        afterEach(function () {
            sinon.restore();
        });

        it('MAX_SUPPLY = MAX_TOKEN_SUPPLY (10^21) with DECIMALS=0 → valid', async function () {
            const params = makeIssueParams({
                TICK:       'MAXTOK',
                MAX_SUPPLY: '1000000000000000000000',
                MAX_MINT:   '1000000000000000000000',
                DECIMALS:   '0',
            });
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

describe('Supply & amount boundary tests @regression @tier1', function () {
    describe('AMT-03: Issue token exceeding maximum supply', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Issue(actionsCtx);

            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        });

        afterEach(function () {
            sinon.restore();
        });

        // 10^21 + 1 exceeds MAX_TOKEN_SUPPLY (10^21) and must be rejected. This previously
        // slipped through: the overflow guard bcgt(MAX_SUPPLY, MAX_TOKEN_SUPPLY) used mathjs's
        // comparison epsilon (~1e-12 relative), which treated 10^21+1 as equal to 10^21 (NOT a
        // bignumber storage limit (bignumber stores it exactly), a comparison-epsilon bug. The
        // bc* comparators now use decimal.js's exact .gt/.lt, so the overflow is correctly caught.
        it('MAX_SUPPLY = 10^21 + 1 exceeds MAX_TOKEN_SUPPLY → invalid', async function () {
            const params = makeIssueParams({
                TICK:       'OVERTOK',
                MAX_SUPPLY: '1000000000000000000001',
                MAX_MINT:   '1000000000000000000001',
                DECIMALS:   '0',
            });
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'invalid: MAX_SUPPLY (min/max)');
        });
    });
});

describe('Supply & amount boundary tests @regression @tier1', function () {
    describe('AMT-04: Issue token with zero supply', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Issue(actionsCtx);

            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        });

        afterEach(function () {
            sinon.restore();
        });

        // NOTE: The MAX_SUPPLY min/max guard in issue.js uses `bcgt(MAX_SUPPLY, 0)` as a pre-condition,
        // so MAX_SUPPLY=0 bypasses the MIN_TOKEN_SUPPLY check entirely. Zero is treated as a no-op
        // (null-equivalent) rather than a below-minimum value, and the issuance is accepted.
        // This test documents the current behavior.
        it('MAX_SUPPLY = 0 bypasses MIN_TOKEN_SUPPLY check (bcgt guard short-circuits) → valid', async function () {
            const params = makeIssueParams({
                TICK:       'ZEROTOK',
                MAX_SUPPLY: '0',
                MAX_MINT:   '0',
                DECIMALS:   '0',
            });
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            // bcgt(0, 0) is false → min/max guard skipped → handler accepts zero supply as valid
            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});
