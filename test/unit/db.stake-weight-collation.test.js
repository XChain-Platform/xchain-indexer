/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/db.stake-weight-collation.test.js
 *
 * Stake-weight snapshot binary-collation flag-day (see
 * src/stake_weight_collation_activation.js). The window caps in
 * _cappedStakeWeightsSql truncate on an ORDER over index_addresses.address /
 * index_pubkeys.pubkey, both declared utf8_general_ci (folding), so the
 * collation decides WHICH sources and keys survive into the hashed
 * stakes_root while every sibling consensus read of those columns already
 * pins utf8_bin.
 *
 * These lock:
 *   - the gate: below the height the emitted SQL carries no COLLATE at all,
 *     and BOTH regimes (capped and legacy LIMIT) move together;
 *   - the gate ships inert on every chain with history;
 *   - the drift predicate, including the utf8 / utf8mb3 rename that would
 *     otherwise halt a correctly-configured fleet.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const swc               = require('../../src/stake_weight_collation_activation');
const swqCap            = require('../../src/swq_source_cap_activation');

function dbFor(network, coin) {
    const config   = getTestConfig();
    config.NETWORK = network;
    config.COIN    = coin === undefined ? 'BTC' : coin;
    const util     = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake((query, args) => { calls.push({ query, args }); return Promise.resolve([]); });
    db._calls = calls;
    return db;
}

afterEach(function () { sinon.restore(); });

describe('stake-weight ordering collation gate @regression @tier1', function () {

    describe('emitted SQL', function () {

        it('an unpinned chain emits no COLLATE in either regime', async function () {
            // Pick block heights on both sides of the source cap so BOTH the capped
            // branch and the legacy LIMIT branch are exercised on an unpinned chain.
            const capHeight = swqCap.SWQ_SOURCE_CAP_ACTIVATION['BTC:mainnet'];
            assert.ok(Number.isFinite(capHeight), 'expected a pinned source-cap height to straddle');
            for (const height of [capHeight - 1, capHeight + 1]) {
                const db = dbFor('mainnet');
                await db._stakeWeightsWithCap(1, height, '0', 'test');
                const q = db._calls.map(c => c.query).join('\n');
                assert.ok(q.length > 0, 'no query was emitted at height ' + height);
                assert.doesNotMatch(q, /COLLATE/,
                    'a COLLATE leaked onto an unpinned chain at height ' + height +
                    '; below the gate the ordering must be byte-identical to what shipped');
                sinon.restore();
            }
        });

        it('regtest is armed and pins utf8_bin at every ordering site', async function () {
            const db = dbFor('regtest');
            await db._stakeWeightsWithCap(1, 10, '0', 'test');
            const q = db._calls.map(c => c.query).join('\n').replace(/\s+/g, ' ');
            assert.match(q, /DENSE_RANK\(\) OVER \(ORDER BY b\.source COLLATE utf8_bin\)/,
                'the source rank decides which sources survive the cap');
            assert.match(q, /ROW_NUMBER\(\) OVER \(PARTITION BY b\.source COLLATE utf8_bin ORDER BY b\.pubkey COLLATE utf8_bin\)/,
                'the key rank decides which keys of a source survive the cap');
            assert.match(q, /ORDER BY r\.source COLLATE utf8_bin, r\.pubkey COLLATE utf8_bin/);
        });

        it('the legacy pre-source-cap branch moves with the same gate', async function () {
            // Below SWQ_SOURCE_CAP_ACTIVATION the snapshot truncates with a raw LIMIT,
            // which truncates on THAT branch's ORDER BY. Pinning only the capped branch
            // would leave the older regime collation-dependent.
            const db = dbFor('regtest');
            const capHeight = swqCap.SWQ_SOURCE_CAP_ACTIVATION.regtest;
            assert.strictEqual(capHeight, 0, 'regtest source cap is expected genesis-armed');
            // Force the legacy branch by stubbing the source-cap gate off.
            sinon.stub(swqCap, 'isSwqSourceCapActive').returns(false);
            await db._stakeWeightsWithCap(1, 10, '0', 'test');
            const q = db._calls.map(c => c.query).join('\n').replace(/\s+/g, ' ');
            assert.match(q, /ORDER BY source COLLATE utf8_bin, pubkey COLLATE utf8_bin LIMIT \?/,
                'the legacy LIMIT branch must pin the same collation the capped branch does');
        });

        it('only the ordering changed: the gate adds COLLATE and nothing else', async function () {
            const off = dbFor('mainnet');
            await off._stakeWeightsWithCap(1, 5000000, '0', 'test');
            const offQ = off._calls[0].query;
            sinon.restore();
            const on = dbFor('regtest');
            await on._stakeWeightsWithCap(1, 5000000, '0', 'test');
            const onQ = on._calls[0].query;
            assert.strictEqual(onQ.split(' COLLATE utf8_bin').join(''), offQ,
                'stripping the COLLATE suffixes must reproduce the unpinned query exactly; ' +
                'anything else means the gate widened past the ordering');
        });
    });

    describe('activation map', function () {

        it('ships inert on every chain with history', function () {
            for (const [key, height] of Object.entries(swc.STAKE_WEIGHT_COLLATION_ACTIVATION)) {
                if (key === 'regtest') { assert.strictEqual(height, 0); continue; }
                assert.strictEqual(height, null,
                    key + ' carries a pinned height. Arming this needs BOTH fleets deployed first: ' +
                    'a one-sided pin re-orders the cap survivors and forks stakes_root');
            }
        });

        it('is inert for unknown networks and unparseable heights', function () {
            assert.strictEqual(swc.isStakeWeightBinCollationActive(0, 'devnet', 'BTC'), false);
            assert.strictEqual(swc.isStakeWeightBinCollationActive(0, null, null), false);
            for (const bad of [null, undefined, '', 'abc', NaN])
                assert.strictEqual(swc.isStakeWeightBinCollationActive(bad, 'regtest', 'BTC'), false);
        });

        it('resolves the coin-qualified key ahead of the bare network key', function () {
            assert.strictEqual(swc.isStakeWeightBinCollationActive(1e9, 'mainnet', 'BTC'), false);
            assert.strictEqual(swc.isStakeWeightBinCollationActive(0, 'regtest', 'BTC'), true);
        });
    });

    describe('schema-drift predicate (fail-closed startup check)', function () {

        const addressSpec = swc.STAKE_WEIGHT_ORDERING_COLUMNS
            .find(s => s.table === 'index_addresses');

        it('accepts the utf8mb3 spelling a modern server reports for a CORRECT schema', function () {
            // Verified against MariaDB 11.4.12: a column declared
            // `CHARSET=utf8 COLLATE=utf8_general_ci` reports utf8mb3 / utf8mb3_general_ci.
            // Comparing the raw names would halt every node in the fleet.
            assert.strictEqual(
                swc.collationDriftReason(addressSpec,
                    { CHARACTER_SET_NAME: 'utf8mb3', COLLATION_NAME: 'utf8mb3_general_ci' }),
                null);
        });

        it('accepts the legacy utf8 spelling too', function () {
            assert.strictEqual(
                swc.collationDriftReason(addressSpec,
                    { CHARACTER_SET_NAME: 'utf8', COLLATION_NAME: 'utf8_general_ci' }),
                null);
        });

        it('refuses a drifted CHARSET, naming the column', function () {
            // This is the state that makes the armed query throw errno 1253 outright.
            const reason = swc.collationDriftReason(addressSpec,
                { CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_general_ci' });
            assert.ok(reason, 'a utf8mb4 column must be refused');
            assert.match(reason, /index_addresses\.address/);
        });

        it('refuses a drifted COLLATION on the right charset', function () {
            const reason = swc.collationDriftReason(addressSpec,
                { CHARACTER_SET_NAME: 'utf8mb3', COLLATION_NAME: 'utf8mb3_bin' });
            assert.ok(reason, 'a column already pinned to a different collation must be refused: ' +
                'the fleet would sort it differently from every peer');
        });

        it('does not halt on an answer it could not read', function () {
            assert.strictEqual(swc.collationDriftReason(addressSpec, null), null);
            assert.strictEqual(swc.collationDriftReason(addressSpec,
                { CHARACTER_SET_NAME: null, COLLATION_NAME: null }), null);
        });
    });

    describe('the startup assertion', function () {

        function dbWithSchemaRows(rows) {
            const config   = getTestConfig();
            config.NETWORK = 'regtest';
            config.COIN    = 'BTC';
            const util     = new Utility();
            sinon.stub(util, 'logError');
            const db = new Database('127.0.0.1', 3306, 'somedb', 'u', 'p', { config, util });
            db.transactionConnection = null;
            sinon.stub(db, 'getConnection').resolves({
                query: async () => rows,
                release: async () => {}
            });
            return db;
        }

        it('passes on a correct schema', async function () {
            const db = dbWithSchemaRows([{ CHARACTER_SET_NAME: 'utf8mb3', COLLATION_NAME: 'utf8mb3_general_ci' }]);
            await db._assertStakeWeightOrderingCollation();
        });

        it('passes when the table is not there yet', async function () {
            const db = dbWithSchemaRows([]);
            await db._assertStakeWeightOrderingCollation();
        });

        it('throws on drift, naming the column', async function () {
            const db = dbWithSchemaRows([{ CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_general_ci' }]);
            await assert.rejects(() => db._assertStakeWeightOrderingCollation(), /index_addresses\.address/);
        });
    });
});
