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
 * test/unit/caret-ref-strict.test.js
 *
 * : strict `^<id>` address-reference rejection flag-day.
 *
 * db.resolveAddressRef states no verdict on a malformed or dangling reference
 * (it returns the value unchanged), so rejection has always depended on each of
 * the ~10 call sites remembering to format-check the field afterwards. Three
 * sites do not (DISPENSER.ORACLE_ADDRESS off the oracle path,
 * DEPLOY.SLASH_DESTINATION below DEPLOY_SLASH_DEST_ADDRESS_VALID, ISSUE's two
 * transfer fields on the genesis path), which is the same fail-open shape that
 * cost  on SEND.
 *
 * These tests pin, in order:
 *   1. the activation predicate (per-chain heights, coin-less fallback, junk
 *      block index -> inert) and the cohort binding to LIST_EDIT_RESOLUTION;
 *   2. the post-resolution "is this still a reference" predicate;
 *   3. db.resolveAddressRefChecked: identical VALUE in both eras (a sentinel
 *      would rewrite persisted rows, since handlers store their cloned data
 *      even for invalid actions) with the verdict travelling beside it;
 *   4. handler-level proof on MINT and DISPENSER that the flag-day converts a
 *      previously-accepted / format-check-dependent reference into a reject.
 *
 * DB pool is stubbed, so this runs without MariaDB (Node 22).
 *********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

const gate = require('../../src/caret_ref_strict_activation');
const { CARET_REF_STRICT_ACTIVATION, isCaretRefStrictActive, isUnresolvedCaretRef } = gate;

// A real regtest-format address, used as the resolution target.
const REAL_ADDR = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef';

// Build a Database whose pool is stubbed. `onQuery` answers the resolution
// lookup; `overrides` lets a test move the effective network/coin so the
// mainnet/testnet rows of the activation map are reachable without a DB.
function makeDb(onQuery, overrides) {
    const util = new Utility();
    sinon.stub(util, 'logError');
    const config = Object.assign({}, getTestConfig(), overrides || {});
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    db.doQuery = sinon.stub().callsFake(onQuery || (() => []));
    return db;
}

describe(' caret-ref strict activation predicate @regression @tier1', function () {

    it('is off below the per-chain height and on at/above it', function () {
        const h = CARET_REF_STRICT_ACTIVATION['BTC:mainnet'];
        assert.strictEqual(isCaretRefStrictActive(h - 1, 'mainnet', 'BTC'), false);
        assert.strictEqual(isCaretRefStrictActive(h,     'mainnet', 'BTC'), true);
        assert.strictEqual(isCaretRefStrictActive(h + 1, 'mainnet', 'BTC'), true);
    });

    it('resolves the per-chain key before the bare network key', function () {
        const ltc = CARET_REF_STRICT_ACTIVATION['LTC:mainnet'];
        const btc = CARET_REF_STRICT_ACTIVATION['BTC:mainnet'];
        assert.notStrictEqual(ltc, btc, 'the fixture is only meaningful while the two heights differ');
        assert.strictEqual(isCaretRefStrictActive(btc, 'mainnet', 'LTC'), false,
            'a BTC-height block on LTC must not activate LTC early');
        assert.strictEqual(isCaretRefStrictActive(ltc, 'mainnet', 'LTC'), true);
    });

    it('is armed from genesis on regtest, for any coin', function () {
        assert.strictEqual(CARET_REF_STRICT_ACTIVATION.regtest, 0);
        for (const coin of ['BTC', 'LTC', 'DOGE'])
            assert.strictEqual(isCaretRefStrictActive(0, 'regtest', coin), true);
    });

    it('is inert with no/unparseable block context, or an unknown network (fail-safe side)', function () {
        for (const b of [undefined, null, '', 'abc', NaN])
            assert.strictEqual(isCaretRefStrictActive(b, 'mainnet', 'BTC'), false,
                'no block context must fall back to the legacy fail-open behaviour');
        assert.strictEqual(isCaretRefStrictActive(999999999, 'nosuchnet', 'BTC'), false);
    });

    it('a coin-less caller falls through to the bare network key and stays inert on mainnet', function () {
        assert.strictEqual(CARET_REF_STRICT_ACTIVATION.mainnet, undefined,
            'there is deliberately no bare mainnet key; a coin-less mainnet caller must be inert');
        assert.strictEqual(isCaretRefStrictActive(999999999, 'mainnet', null), false);
    });

    it('rides the same train as LIST_EDIT_RESOLUTION_ACTIVATION (value-identical map)', function () {
        // Both are execution-path validity changes on the  pre-freeze train, so
        // a re-pin has to move both or this fails rather than silently splitting the
        // boundary operators were told to reason about.
        const listEdit = require('../../src/list_edit_resolution_activation').LIST_EDIT_RESOLUTION_ACTIVATION;
        assert.deepStrictEqual(CARET_REF_STRICT_ACTIVATION, listEdit);
    });
});

describe(' isUnresolvedCaretRef @regression @tier1', function () {

    it('is true only for a value that still carries the ^ reference prefix', function () {
        for (const v of ['^1', '^abc', '^007', '^0x10', '^', '^-1'])
            assert.strictEqual(isUnresolvedCaretRef(v), true, JSON.stringify(v));
    });

    it('is false for a resolved address, a contract address, and an absent field', function () {
        for (const v of [REAL_ADDR, 'C:BTC:1234', 'BURN', '', null, undefined])
            assert.strictEqual(isUnresolvedCaretRef(v), false, JSON.stringify(v));
    });
});

describe(' db.resolveAddressRefChecked @regression @tier1', function () {

    it('returns the resolved address with no rejection when the reference resolves', async function () {
        const db = makeDb(() => [{ address: REAL_ADDR }]);
        const ref = await db.resolveAddressRefChecked('^123', 0);
        assert.deepStrictEqual(ref, { value: REAL_ADDR, rejected: false });
    });

    it('rejects a MALFORMED reference at/after the flag-day, value still unchanged', async function () {
        const db = makeDb(() => { throw new Error('a non-canonical reference must never query'); });
        for (const bad of ['^abc', '^007', '^0x10', '^1.5', '^-1', '^ 1', '^', '^0', '^1e3']) {
            const ref = await db.resolveAddressRefChecked(bad, 0);   // regtest: armed at 0
            assert.strictEqual(ref.value, bad,
                'the wire bytes must survive verbatim; a sentinel would rewrite the persisted row');
            assert.strictEqual(ref.rejected, true, JSON.stringify(bad) + ' must be a hard reject');
        }
    });

    it('rejects a DANGLING reference at/after the flag-day', async function () {
        const db = makeDb(() => []);   // canonical id, but no backing row
        const ref = await db.resolveAddressRefChecked('^999999', 0);
        assert.deepStrictEqual(ref, { value: '^999999', rejected: true });
    });

    it('does NOT reject below the flag-day, and returns the identical value (replay byte-identity)', async function () {
        // BTC:mainnet is armed well above genesis, so a low block is pre-flag-day.
        const db = makeDb(() => [], { NETWORK: 'mainnet', COIN: 'BTC' });
        const below = CARET_REF_STRICT_ACTIVATION['BTC:mainnet'] - 1;
        for (const bad of ['^abc', '^007', '^999999']) {
            const legacy  = await db.resolveAddressRef(bad);
            const checked = await db.resolveAddressRefChecked(bad, below);
            assert.strictEqual(checked.value, legacy, 'value must match the legacy resolver exactly');
            assert.strictEqual(checked.rejected, false, 'no reject below the flag-day');
        }
    });

    it('never rejects a full address, a null field, or a resolvable reference', async function () {
        const db = makeDb(() => [{ address: REAL_ADDR }]);
        for (const v of [REAL_ADDR, null, '', '^7']) {
            const ref = await db.resolveAddressRefChecked(v, 0);
            assert.strictEqual(ref.rejected, false, JSON.stringify(v) + ' must not be rejected');
        }
    });

    it('with no block context, behaves exactly like the legacy resolver (inert)', async function () {
        const db = makeDb(() => []);
        const ref = await db.resolveAddressRefChecked('^abc', undefined);
        assert.deepStrictEqual(ref, { value: '^abc', rejected: false });
    });
});

describe(' handler-level hard reject @regression @tier1', function () {

    const Mint = require('../../src/actions/mint.js');

    // Drive Mint.parse with the real utility and a stubbed DB layer (same shape as
    // gas-mint-network-gate.test.js), so this runs with no MariaDB. `strict` switches
    // the mock's checked resolver between the two eras: pre-flag-day it never rejects
    // (the handler must fall through to its own format check), post-flag-day an
    // unresolvable caret comes back unchanged AND rejected.
    async function runMint({ destination, strict }){
        const util = new Utility();
        util.processTransactionLedgerChanges = async () => {};

        const tokenInfo = {
            BLOCK_INDEX: 1, SUPPLY: 0, DECIMALS: 0, MAX_SUPPLY: 1000000,
            MAX_MINT: 0, MINT_ADDRESS_MAX: 0, MINT_START_BLOCK: 0,
            MINT_STOP_BLOCK: 0, LOCK_MINT: 0
        };
        const captured = {};
        const indexerDb = {
            getTokenInfo:                async () => tokenInfo,
            resolveAddressRef:           async (v) => v,
            resolveAddressRefChecked:    async (v) => ({ value: v, rejected: strict && isUnresolvedCaretRef(v) }),
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
            config: { GAS: 'XCHAIN', NETWORK: 'regtest', ADDRESS: { GAS: REAL_ADDR }, MAX_MEMO_LENGTH: 255 },
            decoderDb: null, indexerDb, util,
            mapper: { createMappings: async () => {} },
            protocolChanges: { isEnabled: async () => true }
        };
        const mint = new Mint(action);
        const params = ('0|TESTTOKEN|1|' + destination).split('|');
        await mint.parse(params, {
            FORMAT: util.getFormatVersion(params[0]),
            SOURCE: REAL_ADDR, BLOCK_INDEX: 100, ACTION_INDEX: 100
        }, null);
        return captured.status;
    }

    it('MINT: at/after the flag-day a dangling ^<id> DESTINATION is a named unresolvable-reference reject', async function () {
        assert.strictEqual(await runMint({ destination: '^999999', strict: true }),
            'invalid: DESTINATION (unresolvable ^id)');
    });

    it('MINT: at/after the flag-day a MALFORMED ^<id> DESTINATION is rejected the same way', async function () {
        assert.strictEqual(await runMint({ destination: '^007', strict: true }),
            'invalid: DESTINATION (unresolvable ^id)');
    });

    it('MINT: below the flag-day the SAME action keeps its legacy format verdict verbatim', async function () {
        // Replay byte-identity: nothing about the pre-flag-day outcome may move.
        assert.strictEqual(await runMint({ destination: '^999999', strict: false }),
            'invalid: DESTINATION (format)');
    });

    it('MINT: a full DESTINATION address is unaffected in both eras', async function () {
        assert.strictEqual(await runMint({ destination: REAL_ADDR, strict: true }),  'valid');
        assert.strictEqual(await runMint({ destination: REAL_ADDR, strict: false }), 'valid');
    });
});
