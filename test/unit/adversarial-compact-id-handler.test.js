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
 *********************************************************************/

/*********************************************************************
 * test/unit/adversarial-compact-id-handler.test.js
 *
 * ADVERSARIAL SUITE (^<id> compaction test brief). HEADLINE FINDING.
 *
 * The SDK compacts single-value address reference fields to the `^<id>`
 * wire form by default (addressResolver.js: compactAddresses !== false;
 * SDK_COMPACTABLE includes MINT.DESTINATION, MESSAGE/SWEEP.DESTINATION,
 * DISPENSER.GET_ADDRESS/ORACLE_ADDRESS, ORDER/SWAP.GET_ADDRESS,
 * DEPLOY.SLASH_DESTINATION).
 *
 * But every indexer handler validates that field with util.isCryptoAddress(),
 * which returns FALSE for any `^<id>` string (a caret is not base58/bech32),
 * and NOTHING expands `^<id>` back to the canonical address before the handler
 * runs (processAction -> assignActionAddressIds -> handler.parse; the pre-pass
 * only assigns ids to NEW non-caret addresses and never rewrites data fields).
 *
 * Consequence: an action carrying a compacted address is marked INVALID by the
 * indexer. This is deterministic across nodes (so not a fork), but it BREAKS the
 * address half of the compaction feature end-to-end: in production, where the
 * explorer can resolve a destination to an id, the SDK emits `^<id>` and the
 * resulting MINT/MESSAGE/etc. is rejected -> tokens not delivered.
 *
 * There is currently NO e2e/integration test that submits a compacted address
 * action and asserts validity, which is why this slipped through.
 *
 * This test drives the real Mint.parse() with a stubbed DB (runs on any Node)
 * and proves the rejection. It is written GREEN against current behaviour: the
 * assertion is "compacted destination -> invalid format", i.e. it documents the
 * bug. When the resolution/validation is fixed (expand ^<id> before the
 * isCryptoAddress check, or accept a valid caret-id), flip the first assertion
 * to expect 'valid' and this becomes the regression guard for the fix.
 *********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Mint    = require('../../src/actions/mint.js');
const Utility = require('../../src/utility.js');

const SRC_ADDR  = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef'; // valid regtest p2pkh (verified isCryptoAddress)
const REAL_DEST = 'n4VQ5YdHf7hLQ2gWQYYrcxoE5B7nWuDFNF'; // valid regtest p2pkh
const ID_DEST   = '^123';                                // compacted reference (what the SDK emits)

// Drive Mint.parse() for one MINT and return its STATUS. Mirrors the harness in
// gas-mint-network-gate.test.js.
async function runMint({ destination }) {
    const util = new Utility();
    util.processTransactionLedgerChanges = async () => {};

    const tokenInfo = {
        BLOCK_INDEX: 1, SUPPLY: 0, DECIMALS: 0, MAX_SUPPLY: 100000000,
        MAX_MINT: 100000, MINT_ADDRESS_MAX: 0, MINT_START_BLOCK: 0,
        MINT_STOP_BLOCK: 0, LOCK_MINT: 0
    };

    let captured = {};
    const indexerDb = {
        getTokenInfo:                async () => tokenInfo,
        getActionCreditDebitAmount:  async () => 0,
        getSelfMintedAmount:         async () => 0,
        validTickerBeforeTxIndex:    async () => true,
        isActionAllowed:             async () => true,
        createMint:                  async (m) => { captured.status = m['STATUS']; },
        updateBalances:              async () => {},
        updateTokens:                async () => {},
        getAddressBalances:                  async () => [],
        getTickerId:                         async () => null,
        getEffectiveTokenControllerForGuard: async () => null,
        // Mirrors the real db.resolveAddressRef contract: a canonical ^<digits>
        // reference that EXISTS resolves to its canonical address; anything else
        // (dangling, malformed, or a full address) is returned unchanged.
        resolveAddressRef: async (v) => (v === '^123' ? REAL_DEST : v)
    };

    const action = {
        config: { GAS: 'XCHAIN', NETWORK: 'regtest', ADDRESS: { GAS: SRC_ADDR }, MAX_MEMO_LENGTH: 255 },
        decoderDb: null, indexerDb, util,
        mapper: { createMappings: async () => {} },
        protocolChanges: { isEnabled: async () => true }
    };

    const mint   = new Mint(action);
    const params = ('0|XCHAIN|5|' + destination).split('|');
    const data   = { FORMAT: util.getFormatVersion(params[0]), SOURCE: SRC_ADDR, BLOCK_INDEX: 100, ACTION_INDEX: 100 };
    await mint.parse(params, data, null);
    return captured.status;
}

describe('Compacted ^<id> address resolves and validates through the handler (fix regression guard) @adversarial @tier1', function () {

    it('control: a full real destination address MINTs valid', async function () {
        assert.strictEqual(await runMint({ destination: REAL_DEST }), 'valid',
            'a real base58/bech32 destination must mint valid (harness sanity)');
    });

    it('FIX: a resolvable compacted ^<id> destination now MINTs valid', async function () {
        // Before the fix this returned "invalid: DESTINATION (format)" (isCryptoAddress(^id)
        // is false and nothing expanded the reference). The handler now calls
        // resolveAddressRef first, so the SDK's default ^<id> wire form validates and
        // credits identically to the full address.
        assert.strictEqual(await runMint({ destination: ID_DEST }), 'valid');
    });

    it('a DANGLING ^<id> destination (no such id) is still rejected as invalid format', async function () {
        // resolveAddressRef leaves a non-resolvable reference unchanged so the existing
        // isCryptoAddress check rejects it (rather than silently dropping the destination).
        assert.strictEqual(await runMint({ destination: '^999999' }), 'invalid: DESTINATION (format)');
    });

    it('a MALFORMED caret id (^1.5 float) is rejected as invalid format (never reaches the FK)', async function () {
        assert.strictEqual(await runMint({ destination: '^1.5' }), 'invalid: DESTINATION (format)');
    });
});
