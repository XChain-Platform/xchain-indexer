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
 * test/unit/db.swq-source-cap.test.js
 *
 * SWQ-TRUNC-1 liveness half (source-cap flag-day). The source-keyed stake-weight
 * query feeds the hashed stakes_root. Below SWQ_SOURCE_CAP_ACTIVATION it uses the
 * legacy uncapped key-row LIMIT; at/after it uses a windowed cap on DISTINCT
 * staking SOURCES (+ a per-source key bound) so one key-spamming source can no
 * longer evict honest sources. These are mock-based (doQuery stubbed) and lock:
 *   - the GATE: which query shape is emitted below vs at/after the activation height;
 *   - the ARG shape: the over-fetch bounds (maxSources+1, maxKeys) vs the legacy LIMIT;
 *   - the TRUNCATION semantics: truncated ONLY when a source beyond maxSources
 *     returns; a bounded key-spammer does NOT set truncated.
 * The SQL itself (window functions against real rows) is proven by the real-MariaDB
 * drill; unit tests here stub doQuery.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const swqCap            = require('../../src/swq_source_cap_activation');

const MAX_SOURCES = swqCap.STAKE_WEIGHT_MAX_SOURCES;      // 1000
const MAX_KEYS    = swqCap.STAKE_WEIGHT_MAX_KEYS_PER_SOURCE; // 64

// Build a Database with an injected config + a captured doQuery. `network`/`block`
// drive the gate; `rows` is what doQuery returns.
function dbFor(network, rows) {
    const config  = getTestConfig();
    config.NETWORK = network;
    config.COIN    = 'BTC';
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'getStatusId').resolves(1);
    sinon.stub(db, 'doQuery').callsFake((query, args) => { calls.push({ query, args }); return Promise.resolve(rows || []); });
    db._calls = calls;
    return db;
}

afterEach(function () { sinon.restore(); });

describe('SWQ source-cap gate + truncation (SWQ-TRUNC-1 liveness) @regression @tier1', function () {

    describe('gate: which query is emitted', function () {

        it('below activation (BTC:mainnet block < 960000) emits the legacy uncapped key-row LIMIT', async function () {
            const db = dbFor('mainnet', []);
            await db.getStakeWeightsByCapability('price', 900000, '0');
            const { query, args } = db._calls[0];
            assert.match(query, /ORDER BY source, pubkey\s+LIMIT \?/, 'legacy uncapped LIMIT shape');
            assert.doesNotMatch(query, /DENSE_RANK/, 'no window cap below the height');
            assert.strictEqual(args[args.length - 1], db.config['VALIDATOR_QUERY_LIMIT'], 'LIMIT bound to VALIDATOR_QUERY_LIMIT');
        });

        it('at/after activation (BTC:mainnet block >= 960000) emits the windowed source-cap', async function () {
            const db = dbFor('mainnet', []);
            await db.getStakeWeightsByCapability('price', 960000, '0');
            const { query, args } = db._calls[0];
            assert.match(query, /DENSE_RANK\(\) OVER \(ORDER BY b\.source\)/, 'ranks DISTINCT sources');
            assert.match(query, /ROW_NUMBER\(\) OVER \(PARTITION BY b\.source ORDER BY b\.pubkey\)/, 'bounds keys per source');
            assert.match(query, /WHERE r\._sr <= \? AND r\._kr <= \?/, 'applies both caps');
            assert.strictEqual(args[args.length - 2], MAX_SOURCES + 1, 'over-fetches one extra source for truncation detect');
            assert.strictEqual(args[args.length - 1], MAX_KEYS, 'per-source key bound is the last arg');
        });

        it('regtest is capped from genesis (activation 0)', async function () {
            const db = dbFor('regtest', []);
            await db.getStakeWeightsByCapability('price', 5, '0');
            assert.match(db._calls[0].query, /DENSE_RANK/, 'regtest exercises the capped path from block 0');
        });

        it('getActiveStakeWeights is gated identically', async function () {
            const below = dbFor('mainnet', []);
            await below.getActiveStakeWeights(900000);
            assert.doesNotMatch(below._calls[0].query, /DENSE_RANK/, 'legacy below the height');

            const at = dbFor('mainnet', []);
            await at.getActiveStakeWeights(960000);
            assert.match(at._calls[0].query, /DENSE_RANK/, 'capped at/after the height');
        });
    });

    describe('truncation semantics (capped path)', function () {

        it('flags truncated and drops the overflow when a source beyond maxSources returns', async function () {
            const rows = [
                { pubkey: 'a', source: 's-0001', weight: '5', _sr: 1 },
                { pubkey: 'b', source: 's-0500', weight: '7', _sr: 500 },
                { pubkey: 'z', source: 's-1001', weight: '9', _sr: MAX_SOURCES + 1 },  // overflow source
            ];
            const db = dbFor('regtest', rows);
            const out = await db.getStakeWeightsByCapability('price', 5, '0');
            assert.strictEqual(out.truncated, true, 'a >maxSources federation is truncated (primitive then fails closed)');
            assert.deepStrictEqual(out.map(r => r.source), ['s-0001', 's-0500'], 'the overflow source is dropped');
            assert.ok(out.every(r => r.pubkey && r.source && r.weight), 'rows narrowed to {pubkey,source,weight}');
        });

        it('does NOT flag truncated for a bounded key-spamming source (key cap != source cap)', async function () {
            // A single source at the exact key bound: many rows, one source, all _sr=1.
            const rows = Array.from({ length: MAX_KEYS }, (_, i) => ({ pubkey: 'k' + i, source: 's-solo', weight: '3', _sr: 1 }));
            const db = dbFor('regtest', rows);
            const out = await db.getStakeWeightsByCapability('price', 5, '0');
            assert.strictEqual(out.truncated, false, 'bounding a key-spammer never sets truncated (its weight is unchanged)');
            assert.strictEqual(out.length, MAX_KEYS, 'all bounded keys pass through');
        });

        it('sub-cap set passes through unchanged (boundary is inert for honest data)', async function () {
            const rows = [
                { pubkey: 'a', source: 's1', weight: '5', _sr: 1 },
                { pubkey: 'b', source: 's2', weight: '6', _sr: 2 },
            ];
            const db = dbFor('regtest', rows);
            const out = await db.getStakeWeightsByCapability('price', 5, '0');
            assert.strictEqual(out.truncated, false);
            assert.deepStrictEqual([...out], [
                { pubkey: 'a', source: 's1', weight: '5' },
                { pubkey: 'b', source: 's2', weight: '6' },
            ]);
        });
    });
});
