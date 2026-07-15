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
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * GAS-tick OPEN MINT policy. XCHAIN is the platform gas token and its supply
 * is distributed by an open mint: any address may MINT it on every network
 * (the former mainnet GAS-address-only backstop was removed). Minting is bounded
 * entirely by the token's own genesis parameters:
 *   - MINT_START_BLOCK gates the launch window (pinned to a far-future sentinel at
 *     genesis, lowered by the operator via a GAS-signed ISSUE when the mint opens),
 *   - MAX_SUPPLY caps the total, MAX_MINT bounds the per-transaction amount.
 * ISSUE of XCHAIN remains GAS-only + BTC-only (issue.js); only the subsequent
 * minting is public.
 *
 * Drives Mint.parse() with the real utility and a stubbed DB layer, so it runs
 * on any Node version.
 ********************************************************************/

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Mint    = require('../../src/actions/mint.js');
const Utility = require('../../src/utility.js');

const GAS_ADDR = 'mgassdEpzH2AuKGK9W5FZh8drWYKrpXk6D'; // matches configs/BTC.js testnet GAS address shape
const DEV_ADDR = 'mDevAddrXXXXXXXXXXXXXXXXXXXXXXXXXXX';

async function runMint({ network, source, amount, tick, mintStartBlock = 0, blockIndex = 100,
                         maxMint = 100000, supply = 0 }){

    const util = new Utility();

    util.processTransactionLedgerChanges = async () => {};

    // An unlocked, open-mint token mirroring the XCHAIN genesis: 8 decimals, a
    // 100,000,000 MAX_SUPPLY, a per-tx MAX_MINT cap, and a configurable MINT_START_BLOCK.
    // A different BLOCK_INDEX (1) so the same-block re-check branch is skipped. maxMint = 0
    // disables the per-tx cap so the MAX_SUPPLY ceiling can be exercised in isolation.
    const tokenInfo = {
        BLOCK_INDEX: 1, SUPPLY: supply, DECIMALS: 8, MAX_SUPPLY: 100000000,
        MAX_MINT: maxMint, MINT_ADDRESS_MAX: 0, MINT_START_BLOCK: mintStartBlock,
        MINT_STOP_BLOCK: 0, LOCK_MINT: 0
    };

    let captured = {};
    const indexerDb = {
        getTokenInfo:                async () => tokenInfo,
        resolveAddressRef:           async (v) => v,
        getActionCreditDebitAmount:  async () => 0,
        getSelfMintedAmount:         async () => 0,
        validTickerBeforeTxIndex:    async () => true,
        isActionAllowed:             async () => true,
        createMint:                  async (m) => { captured.status = m['STATUS']; },
        updateBalances:              async () => {},
        updateTokens:                async () => {},
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
        mapper: { createMappings: async () => {} },
        protocolChanges: { isEnabled: async () => true }
    };

    const mint = new Mint(action);

    const params = ('0|' + tick + '|' + amount).split('|');
    const data = {
        FORMAT: util.getFormatVersion(params[0]),
        SOURCE: source,
        BLOCK_INDEX: blockIndex,
        ACTION_INDEX: 100
    };

    await mint.parse(params, data, null);
    return captured.status;
}

describe('GAS-tick open mint @regression @security', function () {

    describe('open mint : any address may mint the GAS tick on every network', function () {
        it('allows a non-GAS address to mint the GAS tick on mainnet (open mint)', async function () {
            assert.strictEqual(
                await runMint({ network: 'mainnet', source: DEV_ADDR, amount: '5', tick: 'XCHAIN' }), 'valid');
        });
        it('allows the GAS address to mint the GAS tick on mainnet', async function () {
            assert.strictEqual(
                await runMint({ network: 'mainnet', source: GAS_ADDR, amount: '5', tick: 'XCHAIN' }), 'valid');
        });
        it('allows a non-GAS address to mint the GAS tick on testnet', async function () {
            assert.strictEqual(
                await runMint({ network: 'testnet', source: DEV_ADDR, amount: '5', tick: 'XCHAIN' }), 'valid');
        });
        it('allows a non-GAS address to mint the GAS tick on regtest', async function () {
            assert.strictEqual(
                await runMint({ network: 'regtest', source: DEV_ADDR, amount: '90000', tick: 'XCHAIN' }), 'valid');
        });
    });

    describe('MINT_START_BLOCK gates the launch window', function () {
        it('rejects a mint before MINT_START_BLOCK (mint disabled until the operator opens it)', async function () {
            assert.strictEqual(
                await runMint({ network: 'mainnet', source: DEV_ADDR, amount: '5', tick: 'XCHAIN',
                    mintStartBlock: 999999999, blockIndex: 950001 }),
                'invalid: MINT_START_BLOCK');
        });
        it('allows a mint at/after MINT_START_BLOCK (launch window open)', async function () {
            assert.strictEqual(
                await runMint({ network: 'mainnet', source: DEV_ADDR, amount: '5', tick: 'XCHAIN',
                    mintStartBlock: 1000000, blockIndex: 1000000 }),
                'valid');
        });
    });

    describe('supply bounds still enforced', function () {
        it('rejects a per-tx amount above MAX_MINT', async function () {
            assert.strictEqual(
                await runMint({ network: 'mainnet', source: DEV_ADDR, amount: '100001', tick: 'XCHAIN' }),
                'invalid: AMOUNT > MAX_MINT');
        });
        it('rejects a mint that would exceed MAX_SUPPLY', async function () {
            // Disable the per-tx cap (maxMint = 0) so the MAX_SUPPLY = 100,000,000 ceiling is
            // what rejects: a 100,000,001 mint from a zero starting supply.
            assert.strictEqual(
                await runMint({ network: 'mainnet', source: DEV_ADDR, amount: '100000001', tick: 'XCHAIN', maxMint: 0 }),
                'invalid: mint exceeds MAX_SUPPLY');
        });
    });

    describe('subtokens are unaffected', function () {
        it('mints XCHAIN.FOO normally (a subtoken is not the GAS tick)', async function () {
            assert.strictEqual(await runMint({ network: 'mainnet', source: DEV_ADDR, amount: '5', tick: 'XCHAIN.FOO' }), 'valid');
        });
    });
});
