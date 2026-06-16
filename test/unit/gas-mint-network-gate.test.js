'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * GAS-tick MINT network gate. Pins the airtight backstop that makes an
 * open-mint gas token impossible on mainnet (only the GAS address may mint
 * the GAS tick there) regardless of how the genesis ISSUE was authored, while
 * leaving the GAS tick open-mintable on testnet/regtest so developers can
 * self-mint a little play-money gas. Per-mint amount is bounded by the token's
 * own MAX_MINT (set at genesis ISSUE) — there is no separate cap mechanism.
 *
 * Drives Mint.parse() with the real utility and a stubbed DB layer, so it runs
 * on any Node version.
 ********************************************************************/

// The Utility constructor loads the indexer config from env. The gate under test
// reads the per-case action.config we inject below, not this — these just satisfy
// the constructor so Utility's bignumber/format helpers are available.
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Mint    = require('../../src/actions/mint.js');
const Utility = require('../../src/utility.js');

const GAS_ADDR = 'mgassdEpzH2AuKGK9W5FZh8drWYKrpXk6D'; // matches configs/BTC.js testnet GAS address shape
const DEV_ADDR = 'mDevAddrXXXXXXXXXXXXXXXXXXXXXXXXXXX';

// Build a Mint handler wired to the real utility and a benign stubbed DB, then
// run parse() for a single MINT and return the resulting STATUS.
async function runMint({ network, source, amount, tick }){

    const util = new Utility();

    // The only util method that touches the DB on the valid path — stub to a no-op.
    util.processTransactionLedgerChanges = async () => {};

    // An unlocked, open-mint token with a high MAX_MINT (mirrors the regtest XCHAIN
    // genesis). LOCK_MINT=0 and a different BLOCK_INDEX so the same-block re-check
    // branch is skipped.
    const tokenInfo = {
        BLOCK_INDEX: 1, SUPPLY: 0, DECIMALS: 0, MAX_SUPPLY: 100000000,
        MAX_MINT: 100000, MINT_ADDRESS_MAX: 0, MINT_START_BLOCK: 0,
        MINT_STOP_BLOCK: 0, LOCK_MINT: 0
    };

    let captured = {};
    const indexerDb = {
        getTokenInfo:                async () => tokenInfo,
        getActionCreditDebitAmount:  async () => 0,
        validTickerBeforeTxIndex:    async () => true,
        isActionAllowed:             async () => true,
        createMint:                  async (m) => { captured.status = m['STATUS']; },
        updateBalances:              async () => {},
        updateTokens:                async () => {},
        // Controller-guard context (mint.js now consults a `mint`-class controller). No controller
        // bound in this gas-mint test → a null tickId short-circuits the guard helper immediately.
        getAddressBalances:                  async () => [],
        getTickerId:                         async () => null,
        getEffectiveTokenControllerForGuard: async () => null
    };

    const action = {
        config: {
            GAS: 'XCHAIN',
            NETWORK: network,
            ADDRESS: { GAS: GAS_ADDR },
            MAX_MEMO_LENGTH: 255
        },
        decoderDb: null,
        indexerDb,
        util,
        mapper: { createMappings: async () => {} }
    };

    const mint = new Mint(action);

    const params = ('0|' + tick + '|' + amount).split('|');
    const data = {
        FORMAT: util.getFormatVersion(params[0]),
        SOURCE: source,
        BLOCK_INDEX: 100,
        ACTION_INDEX: 100
    };

    await mint.parse(params, data, null);
    return captured.status;
}

describe('GAS-tick MINT network gate @regression @security', function () {

    describe('mainnet — only the GAS address may mint the GAS tick', function () {
        it('rejects a non-GAS address minting the GAS tick', async function () {
            assert.strictEqual(
                await runMint({ network: 'mainnet', source: DEV_ADDR, amount: '5', tick: 'XCHAIN' }),
                'invalid: GAS Address (mint)');
        });
        it('rejects even a tiny mint from a non-GAS address (no open-mint on mainnet)', async function () {
            assert.strictEqual(
                await runMint({ network: 'mainnet', source: DEV_ADDR, amount: '1', tick: 'XCHAIN' }),
                'invalid: GAS Address (mint)');
        });
        it('allows the GAS address to mint the GAS tick', async function () {
            assert.strictEqual(await runMint({ network: 'mainnet', source: GAS_ADDR, amount: '5', tick: 'XCHAIN' }), 'valid');
        });
        it('does not gate subtokens (XCHAIN.foo is not the GAS tick)', async function () {
            assert.strictEqual(await runMint({ network: 'mainnet', source: DEV_ADDR, amount: '5', tick: 'XCHAIN.FOO' }), 'valid');
        });
    });

    describe('testnet — GAS tick is open-mintable (dev gas), bounded only by MAX_MINT', function () {
        it('any address may mint the GAS tick', async function () {
            assert.strictEqual(await runMint({ network: 'testnet', source: DEV_ADDR, amount: '5',  tick: 'XCHAIN' }), 'valid');
        });
        it('rejects amounts above the token MAX_MINT (the only per-mint bound)', async function () {
            // tokenInfo.MAX_MINT = 100000 → 100001 is rejected by the standard MAX_MINT check.
            assert.strictEqual(
                await runMint({ network: 'testnet', source: DEV_ADDR, amount: '100001', tick: 'XCHAIN' }),
                'invalid: AMOUNT > MAX_MINT');
        });
    });

    describe('regtest — GAS tick is open-mintable (preserves e2e gas seeding)', function () {
        it('any address may mint the GAS tick', async function () {
            assert.strictEqual(await runMint({ network: 'regtest', source: DEV_ADDR, amount: '90000', tick: 'XCHAIN' }), 'valid');
        });
    });
});
