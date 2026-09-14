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

// The cumulative MINT_SUPPLY cap on a re-ISSUE, and the LOCK_MINT_SUPPLY
// refusal that holds where the cap has not activated. Split from
// ../issue.test.js by behaviour.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createTokenInfo } = require('../../../fixtures/mocks');

const { makeFormat0Params, makeData, LOW_BLOCK, buildIssue } = require('./helpers/fixture.js');

// Rebuilt by setUp before every test. Module-level so the same-title sibling
// suites below, split only to fit the function-length limit with every full
// test title unchanged, share one fixture.
let indexer, actionsCtx, handler;

function setUp() {
    ({ indexer, actionsCtx, handler } = buildIssue());
}

function tearDown() {
    sinon.restore();
}

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // Cumulative MINT_SUPPLY cap. A re-ISSUE's MINT_SUPPLY mints fresh supply on top
    // of what already exists; the single-shot MINT_SUPPLY>MAX_SUPPLY guard ignores that and would let
    // an owner inflate past MAX_SUPPLY by repeating ISSUE with MINT_SUPPLY. The check is gated on
    // ISSUE_MINT_SUPPLY_CUMULATIVE_CAP.
    describe('ISSUE-1: cumulative MINT_SUPPLY cap @regression @security', function () {

        const source = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

        it('re-ISSUE MINT_SUPPLY that would exceed MAX_SUPPLY is rejected (flag on)', async function () {
            // Existing token at cap: SUPPLY=1000, MAX_SUPPLY=1000, owned by SOURCE, mintable.
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, MAX_SUPPLY: '1000', SUPPLY: '1000', DECIMALS: 0, LOCK_MINT_SUPPLY: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getTokenSupply.resolves('1000'); // current on-ledger supply, at cap

            // MAX_SUPPLY omitted → repopulated to 1000 from tokenInfo; MINT_SUPPLY=1000 stacks past cap.
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '', MINT_SUPPLY: '1000' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'invalid: MINT_SUPPLY exceeds MAX_SUPPLY');
            assert.ok(!indexer.indexerDb.createToken.called, 'createToken must not run for a rejected over-mint');
        });

        it('re-ISSUE MINT_SUPPLY within remaining headroom stays valid (flag on)', async function () {
            // SUPPLY=600 of a 1000 cap: minting 400 more reaches exactly the cap and is allowed.
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, MAX_SUPPLY: '1000', SUPPLY: '600', DECIMALS: 0, LOCK_MINT_SUPPLY: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getTokenSupply.resolves('600');

            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '', MINT_SUPPLY: '400' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('pre-flag-day (flag off) the legacy single-shot behaviour is preserved', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, MAX_SUPPLY: '1000', SUPPLY: '1000', DECIMALS: 0, LOCK_MINT_SUPPLY: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getTokenSupply.resolves('1000');
            // Flag OFF: cumulative check is skipped, so the over-cap re-ISSUE stays valid as before.
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name, block) =>
                name === 'ISSUANCE_FEE' ? Number(block) >= 862633 :
                name === 'ISSUE_MINT_SUPPLY_CUMULATIVE_CAP' ? false : true);

            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '', MINT_SUPPLY: '1000' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

const source = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

/** Every protocol change on EXCEPT the cumulative cap: a pre-flag-day mainnet. */
function disableCumulativeCap() {
    actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name, block) =>
        name === 'ISSUANCE_FEE' ? Number(block) >= 862633 :
        name === 'ISSUE_MINT_SUPPLY_CUMULATIVE_CAP' ? false : true);
}

/**
 * A token record as `getTokenInfo` really returns one.
 *
 * The MINT_SUPPLY delete is not cosmetic. issue.js backfills every empty param from
 * tokenInfo (~line 241), and the real getTokenInfo selects no mint_supply column at
 * all, so on a live chain an edit that leaves MINT_SUPPLY blank stays blank. The
 * shared fixture carries a MINT_SUPPLY key it does not have; left in place it would
 * backfill '0' into every edit and make this lock look like it freezes the whole
 * token, which is the opposite of what the DESCRIPTION control below proves.
 */
function lockedTokenInfo(overrides) {
    const info = createTokenInfo(overrides);
    delete info.MINT_SUPPLY;
    return info;
}

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // the wallet's COLLECTIBLE and MEME wizard templates promise a supply that can
    // never grow. The cumulative MINT_SUPPLY cap keeps that promise, but it is GATED - at genesis on
    // testnet/regtest, on a flag day on mainnet - so a token that leans on it is only fixed
    // where the flag has already flipped. LOCK_MINT_SUPPLY is the token's own version of the
    // same refusal, checked at issue.js ~367, BEFORE the gated cap at ~383. These tests pin
    // that ordering with the gate deliberately OFF: the refusal has to survive a chain where
    // the protocol change has not activated, because that is the whole reason the templates
    // write the flag.
    describe('LOCK_MINT_SUPPLY refuses re-ISSUE inflation without the flag day @regression @security', function () {
        it('a collectible that set LOCK_MINT_SUPPLY refuses the re-ISSUE by the LOCK, not the gate', async function () {
            // The token the wizard's collectible template now creates: 1 of 1, cap frozen,
            // MINT closed, and MINT_SUPPLY locked.
            const tokenInfo = lockedTokenInfo({
                TICK: 'ONEOFONE', OWNER: source, MAX_SUPPLY: '1', SUPPLY: '1', DECIMALS: 0,
                LOCK_MAX_SUPPLY: 1, LOCK_MINT: 1, LOCK_MINT_SUPPLY: 1,
            });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getTokenSupply.resolves('1');
            disableCumulativeCap();

            // The attack restates MAX_SUPPLY at its CURRENT value on purpose: an omitted cap is
            // caught by the older single-shot guard instead, and a changed one by the locked-cap
            // check, so neither would prove anything about MINT_SUPPLY.
            const params = makeFormat0Params({ TICK: 'ONEOFONE', MAX_SUPPLY: '1', MINT_SUPPLY: '1', MAX_MINT: '', DECIMALS: '0', DESCRIPTION: '' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'invalid: MINT_SUPPLY (locked)');
            assert.ok(!indexer.indexerDb.createToken.called, 'a refused re-ISSUE must not touch the token');
        });

        it('the same collectible WITHOUT the lock is inflatable pre-flag-day (what the lock buys)', async function () {
            // Control. Identical token, LOCK_MINT_SUPPLY unset: this is the shape a template composes
            // when it omits the lock, and on a chain whose cumulative cap has not activated the owner
            // mints a second copy onto a "1 of 1".
            const tokenInfo = lockedTokenInfo({
                TICK: 'ONEOFONE', OWNER: source, MAX_SUPPLY: '1', SUPPLY: '1', DECIMALS: 0,
                LOCK_MAX_SUPPLY: 1, LOCK_MINT: 1, LOCK_MINT_SUPPLY: 0,
            });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getTokenSupply.resolves('1');
            disableCumulativeCap();

            const params = makeFormat0Params({ TICK: 'ONEOFONE', MAX_SUPPLY: '1', MINT_SUPPLY: '1', MAX_MINT: '', DECIMALS: '0', DESCRIPTION: '' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('LOCK_MINT_SUPPLY refuses re-ISSUE inflation without the flag day @regression @security', function () {
        it('a meme token that set LOCK_MINT_SUPPLY keeps its fixed supply pre-flag-day', async function () {
            const tokenInfo = lockedTokenInfo({
                TICK: 'DANKCOIN', OWNER: source, MAX_SUPPLY: '21000000', SUPPLY: '21000000', DECIMALS: 0,
                LOCK_MAX_SUPPLY: 1, LOCK_MINT: 1, LOCK_MINT_SUPPLY: 1,
            });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getTokenSupply.resolves('21000000');
            disableCumulativeCap();

            const params = makeFormat0Params({ TICK: 'DANKCOIN', MAX_SUPPLY: '21000000', MINT_SUPPLY: '1000000', MAX_MINT: '', DECIMALS: '0', DESCRIPTION: '' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'invalid: MINT_SUPPLY (locked)');
        });

        it('the lock leaves the fields it does not cover alone: a DESCRIPTION edit is still valid', async function () {
            // Positive control. LOCK_MINT_SUPPLY must refuse the MINT_SUPPLY path and nothing
            // else, or the templates would be quietly freezing metadata they never claimed to.
            const tokenInfo = lockedTokenInfo({
                TICK: 'ONEOFONE', OWNER: source, MAX_SUPPLY: '1', SUPPLY: '1', DECIMALS: 0,
                LOCK_MAX_SUPPLY: 1, LOCK_MINT: 1, LOCK_MINT_SUPPLY: 1,
            });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getTokenSupply.resolves('1');
            disableCumulativeCap();

            const params = makeFormat0Params({ TICK: 'ONEOFONE', MAX_SUPPLY: '', MINT_SUPPLY: '', MAX_MINT: '', DECIMALS: '', DESCRIPTION: 'https://example.com/art.png?v=2' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});
