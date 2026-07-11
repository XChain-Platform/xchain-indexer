/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/db.state-key-collation.test.js
 *
 * Contract-state `state_key` binary-collation flag-day (see
 * src/state_key_collation_activation.js). contract_state is utf8_general_ci
 * (case/accent-folding), so the legacy GROUP BY/ORDER BY on state_key treat
 * distinct keys ("Key" vs "key") as EQUAL: the consensus contract_hash
 * preimage silently drops one key's value, and getContractState() drops one
 * of the keys on VM reload. The fix pins `state_key COLLATE utf8_bin`, gated
 * per chain height because it changes the hash preimage of already-valid
 * blocks. These tests are mock-based (doQuery stubbed) and lock:
 *   - the GATE: folding SQL below activation / unarmed chains, utf8_bin at/after;
 *   - regtest armed from genesis, mainnet/testnet armed at the 2026-07-10 heights;
 *   - getContractState only gates when the caller supplies the block context.
 * The byte-identical xchain-sync twin (BlockHasher/getBlockLeafRows) is locked
 * by the sync repo's cross-repo twin guard (rollback-coverage.test.js).
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const skc               = require('../../src/state_key_collation_activation');

// Build a Database with an injected config + a captured doQuery.
function dbFor(network, coin) {
    const config  = getTestConfig();
    config.NETWORK = network;
    config.COIN    = coin || 'BTC';
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake((query, args) => { calls.push({ query, args }); return Promise.resolve([]); });
    db._calls = calls;
    return db;
}

// The per-block contract-state gather inside getBlockHashes.
async function blockHashesStateQuery(db, blockIndex) {
    // getBlockHashes chains into previous-block reads that may not survive
    // all-empty stubs; the contract-state gather happens before any such
    // failure matters, so tolerate a late throw and inspect the capture.
    try { await db.getBlockHashes(blockIndex); } catch (e) { /* post-gather steps may throw on stubbed rows */ }
    const hit = db._calls.find(c => /FROM contract_state cs/.test(c.query) && /block_index=\?/.test(c.query));
    assert.ok(hit, 'getBlockHashes did not emit its contract-state gather query');
    return hit.query.replace(/\s+/g, ' ');
}

async function contractStateQuery(db, contractIndex, blockIndex) {
    await db.getContractState(contractIndex, blockIndex);
    const hit = db._calls.find(c => /FROM contract_state cs/.test(c.query) && /contract_index = \?/.test(c.query));
    assert.ok(hit, 'getContractState did not emit its reload query');
    return hit.query.replace(/\s+/g, ' ');
}

afterEach(function () { sinon.restore(); });

describe('state_key binary-collation gate (contract_hash preimage + VM reload) @regression @tier1', function () {

    describe('getBlockHashes contract-state gather', function () {

        it('regtest (armed from genesis) pins COLLATE utf8_bin in GROUP BY and ORDER BY', async function () {
            const q = await blockHashesStateQuery(dbFor('regtest'), 5);
            assert.match(q, /GROUP BY contract_index, state_key COLLATE utf8_bin/);
            assert.match(q, /ORDER BY cs\.contract_index ASC, cs\.state_key COLLATE utf8_bin ASC/);
        });

        it('mainnet below the armed height keeps the legacy folding collation', async function () {
            const q = await blockHashesStateQuery(dbFor('mainnet'), 900000);
            assert.doesNotMatch(q, /COLLATE utf8_bin/);
            assert.match(q, /GROUP BY contract_index, state_key \)/);
            assert.match(q, /ORDER BY cs\.contract_index ASC, cs\.state_key ASC/);
        });

        it('testnet below the armed height keeps the legacy folding collation', async function () {
            const q = await blockHashesStateQuery(dbFor('testnet'), 140000);
            assert.doesNotMatch(q, /COLLATE utf8_bin/);
        });
    });

    describe('getContractState VM reload', function () {

        it('gates GROUP BY state_key_bin (index-backed utf8_bin shadow) at/after activation (regtest)', async function () {
            const q = await contractStateQuery(dbFor('regtest'), 42, 5);
            assert.match(q, /GROUP BY state_key_bin/);
            assert.doesNotMatch(q, /GROUP BY state_key COLLATE/);
        });

        it('keeps the legacy folding form below the armed mainnet height', async function () {
            const q = await contractStateQuery(dbFor('mainnet'), 42, 900000);
            assert.doesNotMatch(q, /COLLATE utf8_bin/);
            assert.doesNotMatch(q, /state_key_bin/);
        });

        it('keeps the legacy folding form when no block context is supplied (historical replay safety)', async function () {
            const q = await contractStateQuery(dbFor('regtest'), 42, undefined);
            assert.doesNotMatch(q, /COLLATE utf8_bin/);
        });
    });

    describe('activation-module predicate', function () {

        it('regtest is armed from genesis; unknown network/coin is off', function () {
            assert.strictEqual(skc.isStateKeyBinCollationActive(0, 'regtest', 'BTC'), true);
            assert.strictEqual(skc.isStateKeyBinCollationActive(0, 'regtest', undefined), true, 'bare network key covers every regtest coin');
            assert.strictEqual(skc.isStateKeyBinCollationActive(100, 'stagenet', 'BTC'), false);
            assert.strictEqual(skc.isStateKeyBinCollationActive('x', 'regtest', 'BTC'), false);
        });

        it('every mainnet/testnet chain is armed at its coordinated 2026-07-10 height', function () {
            const ARMED = {
                'BTC:mainnet': 962500, 'LTC:mainnet': 3160000, 'DOGE:mainnet': 6335000,
                'BTC:testnet': 146000, 'LTC:testnet': 4890000, 'DOGE:testnet': 67500000,
            };
            for (const [key, height] of Object.entries(ARMED)) {
                assert.strictEqual(skc.STATE_KEY_COLLATION_ACTIVATION[key], height,
                    key + ' must carry the coordinated armed height (twin-mirrored to xchain-sync)');
                const [coin, network] = key.split(':');
                assert.strictEqual(skc.isStateKeyBinCollationActive(height - 1, network, coin), false,
                    key + ' must stay legacy below the armed height');
                assert.strictEqual(skc.isStateKeyBinCollationActive(height, network, coin), true,
                    key + ' must flip binary at the armed height');
            }
        });

        it('bare mainnet/testnet lookups (no coin) are inert', function () {
            assert.strictEqual(skc.isStateKeyBinCollationActive(1e9, 'mainnet', undefined), false);
            assert.strictEqual(skc.isStateKeyBinCollationActive(1e9, 'testnet', undefined), false);
        });
    });
});
