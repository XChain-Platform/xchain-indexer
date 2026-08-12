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

const Issue = require('../../../src/actions/issue.js');
const Mint  = require('../../../src/actions/mint.js');

const ProtocolChanges = require('../../../src/protocol_changes.js');

// BLOCK_INDEX < 862633 -> no issuance fee required (ISSUANCE_FEE is block-gated)
const LOW_BLOCK = 100;

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

// Actions context whose protocol gate answers `true` for everything except
// ISSUANCE_FEE (mirrors its 862633 mainnet block gate) and except the named
// gate, which the caller drives. That is the seam these tests need: one gate
// off, everything else in its normal regtest genesis-active state.
function makeActionsCtx(indexer, gateOverrides = {}) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().callsFake(async (name, block) => {
                if (Object.prototype.hasOwnProperty.call(gateOverrides, name))
                    return gateOverrides[name];
                if (name === 'ISSUANCE_FEE') return Number(block) >= 862633;
                return true;
            }),
        },
        processAction: sinon.stub().resolves(),
    };
}

// ISSUE format 0: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|
// TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|
// LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|
// MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
function makeIssueParams(overrides = {}) {
    const defaults = {
        VERSION: '0', TICK: 'UNCAPPED', MAX_SUPPLY: '0', MAX_MINT: '100',
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

describe('MAX_SUPPLY=0 is the uncapped sentinel @regression @tier1', function () {

    afterEach(function () {
        sinon.restore();
    });

    // ---------------------------------------------------------------------
    // MINT: the bricked-token defect itself
    // ---------------------------------------------------------------------
    describe('MINT supply ceiling', function () {

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

        it('gate ON: a mint that exactly fills a declared cap stays valid', async function () {
            assert.strictEqual(
                await runMint({ maxSupply: '1000', supply: '900', amount: '100', gateOn: true }),
                'valid');
        });
    });

    // ---------------------------------------------------------------------
    // ISSUE: the three cross-checks that compare a field against MAX_SUPPLY
    // ---------------------------------------------------------------------
    describe('ISSUE cross-checks against MAX_SUPPLY', function () {

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
    });

    // ---------------------------------------------------------------------
    // The gate registration itself
    // ---------------------------------------------------------------------
    describe('UNCAPPED_MAX_SUPPLY_ZERO registration', function () {

        function pcFor(network) {
            const indexer = createMockIndexer();
            indexer.config.NETWORK = network;
            return { pc: new ProtocolChanges(indexer, '2.0.0'), indexer };
        }

        it('is a 2.0.0 time-keyed change, genesis-active on testnet and regtest', function () {
            const change = pcFor('regtest').pc.changes['UNCAPPED_MAX_SUPPLY_ZERO'];
            assert.ok(change, 'UNCAPPED_MAX_SUPPLY_ZERO must be registered');
            assert.strictEqual(change.version_major, 2);
            assert.strictEqual(change.version_minor, 0);
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
    });
});
