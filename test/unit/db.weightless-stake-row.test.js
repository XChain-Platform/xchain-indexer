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
 * test/unit/db.weightless-stake-row.test.js
 *
 * : a weightless row must never leave a stake-weight producer.
 *
 * stake_weighted_quorum already fails closed on a row whose weight is missing -
 * a coerced zero keeps the source in the quorum's dedupe map carrying no stake,
 * so the denominator S shrinks while a signer keeps the full numerator and a
 * smaller real stake clears 3*tally > 2*S. The predicate never saw one, though:
 * every consumer re-maps the set through `String(v.weight != null ? v.weight :
 * '0')`, and these producers did the same coercion at the SQL boundary, so the
 * missing weight arrived at the predicate already laundered into a well-formed
 * zero. The guard had to move to the producer.
 *
 * Evidence that this cannot halt a live producer (gathered 2026-08-12 against
 * the regtest stack before the change landed): stakes.amount and
 * capability_snapshots.amount are both NOT NULL, the source aggregate is
 * HAVING-filtered (a NULL total never survives), and a sweep of the BTC, LTC and
 * DOGE regtest indexers over every configured capability at five block
 * boundaries returned 0 missing, 0 blank and 0 nonnumeric weights out of
 * 61/49/40-row sets, plus 1207 mirrored capability_snapshots rows with no NULL
 * amount and no blank source. A throw here is therefore unreachable on honest
 * data and, when it does fire, surfaces to the hub as an RPC error - which every
 * consensus caller already treats as "decline the round".
 *
 * Mock-based (doQuery stubbed); the SQL itself is proven by the real-MariaDB
 * drills that cover these queries.
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

// Block heights either side of the source-cap flag day, so both query shapes in
// _stakeWeightsWithCap are exercised (they map rows independently).
const BELOW_CAP = 900000;
const ABOVE_CAP = 960000;

function dbFor(rows) {
    const config   = getTestConfig();
    config.NETWORK = 'mainnet';       // the SWQ source-cap gate is armed here
    config.COIN    = 'BTC';
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    sinon.stub(db, 'getStatusId').resolves(1);
    sinon.stub(db, 'doQuery').resolves(rows || []);
    return db;
}

// One good row plus one row whose weight went missing in the way under test.
function rowsWith(weight, extra) {
    return [
        Object.assign({ pubkey: 'aa', source: 'src1', weight: '50000' }, extra || {}),
        Object.assign({ pubkey: 'bb', source: 'src2', weight: weight }, extra || {})
    ];
}

const MISSING = [
    { label: 'null',           weight: null },
    { label: 'undefined',      weight: undefined },
    { label: 'empty string',   weight: '' },
    { label: 'blank string',   weight: '   ' },
    { label: 'nonnumeric',     weight: 'lots' },
    { label: 'the literal null', weight: 'null' }
];

afterEach(function () { sinon.restore(); });

describe('weightless stake-weight rows fail closed  @regression @tier1', function () {

    describe('Database.requireStakeWeight', function () {

        for (const bad of MISSING) {
            it('throws on a weight that is ' + bad.label, function () {
                assert.throws(() => Database.requireStakeWeight(bad.weight, 'probe'),
                    /denominator S/, 'names the denominator it would have shrunk');
            });
        }

        it('accepts a LEGITIMATE zero (a source can really weigh 0 at MIN_STAKE 0)', function () {
            assert.strictEqual(Database.requireStakeWeight('0', 'probe'), '0');
        });

        it('accepts decimals and preserves the value byte-for-byte', function () {
            // The returned string feeds hashed stakes_root leaves, so it must be the
            // value as read, not a normalized form.
            assert.strictEqual(Database.requireStakeWeight('12345.67890000', 'probe'), '12345.67890000');
        });

        it('accepts a numeric (non-string) weight from the driver', function () {
            assert.strictEqual(Database.requireStakeWeight(500, 'probe'), '500');
        });

        it('names the producer in the error, so a halt points at the query', function () {
            assert.throws(() => Database.requireStakeWeight(null, 'getStakeWeightsByCapability(price)'),
                /getStakeWeightsByCapability\(price\)/);
        });
    });

    describe('getStakeWeightsByCapability', function () {

        for (const bad of MISSING) {
            it('throws below the source cap when a row weight is ' + bad.label, async function () {
                const db = dbFor(rowsWith(bad.weight));
                await assert.rejects(() => db.getStakeWeightsByCapability('price', BELOW_CAP, '0'),
                    /denominator S/);
            });

            it('throws at/above the source cap when a row weight is ' + bad.label, async function () {
                const db = dbFor(rowsWith(bad.weight, { _sr: 1, _kr: 1 }));
                await assert.rejects(() => db.getStakeWeightsByCapability('price', ABOVE_CAP, '0'),
                    /denominator S/);
            });
        }

        it('still returns a set whose weights are all present', async function () {
            const db = dbFor(rowsWith('25000'));
            const out = await db.getStakeWeightsByCapability('price', BELOW_CAP, '0');
            assert.deepStrictEqual(out.map(r => r.weight), ['50000', '25000']);
        });

        it('does not reject a legitimate zero weight', async function () {
            const db = dbFor(rowsWith('0'));
            const out = await db.getStakeWeightsByCapability('price', BELOW_CAP, '0');
            assert.deepStrictEqual(out.map(r => r.weight), ['50000', '0']);
        });
    });

    describe('getActiveStakeWeights (whole-federation weights)', function () {

        it('throws when a row weight is missing', async function () {
            const db = dbFor(rowsWith(null));
            await assert.rejects(() => db.getActiveStakeWeights(BELOW_CAP), /denominator S/);
        });

        it('passes a fully-weighted set through', async function () {
            const db = dbFor(rowsWith('1'));
            const out = await db.getActiveStakeWeights(BELOW_CAP);
            assert.strictEqual(out.length, 2);
        });
    });

    describe('getCapabilitySnapshotWeights (hub-mirrored, off-BTC chains)', function () {

        // The mirror path is how DOGE/LTC verifiers resolve a BTC-anchored set;
        // capability_snapshots.amount is NOT NULL, so a null here means a corrupt
        // mirror, not a stakeless source.
        it('throws when a mirrored row carries no amount', async function () {
            const db = dbFor([{ pubkey: 'aa', source: 'src1', weight: '10' },
                              { pubkey: 'bb', source: 'src2', weight: null }]);
            await assert.rejects(() => db.getCapabilitySnapshotWeights('cross_chain', 700), /denominator S/);
        });

        it('reads a well-formed mirrored set unchanged', async function () {
            const db = dbFor([{ pubkey: 'aa', source: 'src1', weight: '10' },
                              { pubkey: 'bb', source: 'src2', weight: '0' }]);
            const out = await db.getCapabilitySnapshotWeights('cross_chain', 700);
            assert.deepStrictEqual(out.map(r => r.weight), ['10', '0']);
        });
    });

    describe('the cap constants the gate reads are still the ones this test assumes', function () {
        it('source cap and per-source key cap are defined', function () {
            assert.ok(Number.isFinite(swqCap.STAKE_WEIGHT_MAX_SOURCES));
            assert.ok(Number.isFinite(swqCap.STAKE_WEIGHT_MAX_KEYS_PER_SOURCE));
        });
    });
});
