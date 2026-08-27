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
 * test/unit/db.price-capability-off-btc.test.js
 *
 * The `price` capability could not resolve off BTC at all, so every PRICE action
 * on the chain PRICE is actually published to recorded 'invalid: insufficient
 * signer stake'. Measured 2026-08-26 against the live DOGE regtest stack: a real
 * four-validator federation finalized three PRICE v0 rounds, all fifteen actions
 * (1047-1064, blocks 2722-2744) recorded that status with pair_count 2 /
 * sig_count 4 and four signatures that verify, the DOGE indexer's
 * getcapabilityvalidators answered 'capability not configured: price', and its
 * mirrored capability_snapshots held only cross_chain and oracle_publish rows.
 *
 * Cause: capability staking is BTC-only (coins/DOGE.js:248, coins/LTC.js:243 both
 * declare CAPABILITIES: {}), and the hub-mirrored capability_snapshots redirect in
 * the resolvers was scoped to cross_chain and oracle_publish only, so `price`
 * fell through to a local `stakes` path that is empty off BTC. Weighted quorum is
 * genesis-active on regtest, so the empty set summed to a stake of zero.
 *
 * `price` now redirects unconditionally, exactly like the other two, and ALL FOUR
 * capability reads (validator set, stake weights, active count, per-pubkey
 * membership) go through the one predicate so they cannot disagree about who is
 * capable. What these cases guard is that agreement.
 *
 * Mock-based (doQuery stubbed on both the indexer DB and the hub mirror); the SQL
 * itself is proven by the real-MariaDB drills that cover these queries.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// The BTC-anchored block the round's validator set is locked at. This is the value
// capability_snapshots.snapshot_block carries, and the ONLY height these reads accept.
const SNAP_BLOCK = 961234;

// Mirror rows as capability_snapshots stores them: one row per effective signing
// key, carrying the staking source and that source's aggregate stake.
const MIRROR_ROWS = [
    { pubkey: 'aa11', signing_pubkey: 'aa11', source: 'src1', amount: '5000.00000000', weight: '5000.00000000' },
    { pubkey: 'bb22', signing_pubkey: 'bb22', source: 'src2', amount: '4000.00000000', weight: '4000.00000000' },
    { pubkey: 'cc33', signing_pubkey: 'cc33', source: 'src3', amount: '3000.00000000', weight: '3000.00000000' },
    { pubkey: 'dd44', signing_pubkey: 'dd44', source: 'src4', amount: '2000.00000000', weight: '2000.00000000' },
];

// Local `stakes` rows, shaped for whichever resolver asks. Only BTC ever reaches
// this path; the point of the fixtures is that they are DISTINGUISHABLE from the
// mirror rows above, so a test can tell which source answered.
const LOCAL_ROWS = [
    { pubkey: 'ee55', total: '9000.00000000', source: 'localsrc', weight: '9000.00000000' },
];

// Build a Database wired for `coin` on `network`, with the local-stakes query and
// the hub mirror stubbed separately so each test can prove which one answered.
// The mirror answers COUNT queries with a row shaped like the count resolver reads.
function dbFor(coin, network, localRows) {
    const config   = getTestConfig();
    config.COIN    = coin;
    config.NETWORK = network;
    // Faithful to coins/DOGE.js and coins/LTC.js: a non-BTC chain configures NO
    // capabilities at all, which is why the local path returns an empty set there.
    if (coin !== 'BTC') config.STAKING = Object.assign({}, config.STAKING, { CAPABILITIES: {} });

    const util = new Utility();
    sinon.stub(util, 'logError');

    const db = new Database('127.0.0.1', 3306, 'xchain_test', 'u', 'p', { config, util });
    sinon.stub(db, 'getStatusId').resolves(1);
    const local  = sinon.stub(db, 'doQuery').resolves(localRows || []);
    const mirror = sinon.stub().callsFake(async (sql) => {
        if (/COUNT\(DISTINCT signing_pubkey\)/.test(sql)) return [{ cnt: MIRROR_ROWS.length }];
        if (/SELECT 1 FROM capability_snapshots/.test(sql)) return [{ 1: 1 }];
        return MIRROR_ROWS;
    });
    // _mirrorDb() prefers indexer.hubDb, which is where the mirrored tables live in
    // a distributed deployment.
    db.indexer = { hubDb: { doQuery: mirror } };
    return { db, local, mirror };
}

afterEach(function () { sinon.restore(); });

describe('price capability resolution off BTC @regression', function () {

    describe('the mirrored set answers, on every network', function () {

        ['mainnet', 'testnet', 'regtest'].forEach(function (network) {
            it('getValidatorsByCapability reads capability_snapshots on DOGE ' + network, async function () {
                const { db, local, mirror } = dbFor('DOGE', network);
                const rows = await db.getValidatorsByCapability('price', SNAP_BLOCK);
                assert.deepStrictEqual(rows.map(r => r.pubkey), ['aa11', 'bb22', 'cc33', 'dd44']);
                assert.deepStrictEqual(rows.map(r => r.amount),
                    ['5000.00000000', '4000.00000000', '3000.00000000', '2000.00000000']);
                assert.strictEqual(mirror.callCount, 1);
                assert.deepStrictEqual(mirror.firstCall.args[1], ['price', SNAP_BLOCK]);
                assert.match(mirror.firstCall.args[0], /FROM capability_snapshots/);
                assert.strictEqual(local.callCount, 0, 'the empty local-stakes path must not be touched');
            });
        });

        // LTC carries the identical off-BTC scoping (coins/LTC.js:243 is byte-identical to
        // coins/DOGE.js:248), and the predicate keys on COIN !== 'BTC', never on a specific
        // coin, so LTC is covered by construction. This pins that construction so a later
        // coin-specific "optimization" cannot quietly strand LTC the way prices were stranded.
        it('getValidatorsByCapability reads capability_snapshots on LTC too, the predicate is coin-agnostic', async function () {
            const { db, local, mirror } = dbFor('LTC', 'regtest');
            const rows = await db.getValidatorsByCapability('price', SNAP_BLOCK);
            assert.deepStrictEqual(rows.map(r => r.pubkey), ['aa11', 'bb22', 'cc33', 'dd44']);
            assert.strictEqual(mirror.callCount, 1);
            assert.strictEqual(local.callCount, 0, 'the empty local-stakes path must not be touched');
        });

        it('getStakeWeightsByCapability reads the source-keyed mirrored weights', async function () {
            const { db, local, mirror } = dbFor('DOGE', 'regtest');
            const rows = await db.getStakeWeightsByCapability('price', SNAP_BLOCK);
            assert.deepStrictEqual(rows.map(r => r.pubkey), ['aa11', 'bb22', 'cc33', 'dd44']);
            assert.deepStrictEqual(rows.map(r => r.source), ['src1', 'src2', 'src3', 'src4']);
            assert.deepStrictEqual(rows.map(r => r.weight),
                ['5000.00000000', '4000.00000000', '3000.00000000', '2000.00000000']);
            assert.strictEqual(mirror.callCount, 1);
            assert.strictEqual(local.callCount, 0);
        });

        it('getActiveCapabilityCount counts the mirrored set, not the empty local one', async function () {
            // This count is the PBFT DENOMINATOR. Off BTC the local path answers 0 (no
            // capability configured), which makes quorum 1 and lets a single signature
            // finalize a round the rest of the federation would refuse.
            const { db, local, mirror } = dbFor('DOGE', 'regtest');
            const n = await db.getActiveCapabilityCount('price', SNAP_BLOCK);
            assert.strictEqual(n, 4);
            assert.strictEqual(mirror.callCount, 1);
            assert.match(mirror.firstCall.args[0], /COUNT\(DISTINCT signing_pubkey\)/);
            assert.strictEqual(local.callCount, 0);
        });

        it('hasCapability answers from the mirror, so the truncation fallback agrees', async function () {
            // actions/price.js drops to the per-signer hasCapability path when the capable
            // read reports `truncated === true`. If that path stayed local off BTC it would
            // answer false for every signer and drop the whole quorum.
            const { db, local, mirror } = dbFor('DOGE', 'regtest');
            assert.strictEqual(await db.hasCapability('aa11', 'price', SNAP_BLOCK), true);
            assert.strictEqual(mirror.callCount, 1);
            assert.match(mirror.firstCall.args[0], /FROM capability_snapshots/);
            assert.strictEqual(local.callCount, 0);
        });

        it('all four reads name the SAME capable set', async function () {
            // The split this guards against is the worst shape the bug can take: a node
            // that tallies signatures against one validator set and divides by a quorum
            // denominator computed from another reaches a verdict no other node reaches.
            const a = dbFor('DOGE', 'regtest');
            const counted = await a.db.getValidatorsByCapability('price', SNAP_BLOCK);
            const n       = await a.db.getActiveCapabilityCount('price', SNAP_BLOCK);
            const member  = await a.db.hasCapability('aa11', 'price', SNAP_BLOCK);
            sinon.restore();
            const b = dbFor('DOGE', 'regtest');
            const weighted = await b.db.getStakeWeightsByCapability('price', SNAP_BLOCK);

            assert.strictEqual(counted.length, weighted.length,
                'count resolver and weight resolver disagree about HOW MANY signers are capable');
            assert.strictEqual(n, counted.length,
                'the PBFT denominator disagrees with the set the tally is drawn from');
            assert.strictEqual(member, true,
                'the per-signer fallback disagrees with the set both resolvers returned');
            assert.deepStrictEqual(counted.map(r => r.pubkey).sort(), weighted.map(r => r.pubkey).sort(),
                'count resolver and weight resolver disagree about WHO is capable');
            // Same numbers on both sides, so a quorum computed either way agrees.
            assert.deepStrictEqual(counted.map(r => String(r.amount)), weighted.map(r => String(r.weight)),
                'count resolver and weight resolver disagree about the stake behind each signer');
        });

        it('the mirrored set clears the stake-weighted quorum the measured rounds failed', async function () {
            const swq = require('../../src/stake_weighted_quorum');
            const { db } = dbFor('DOGE', 'regtest');
            const validators = await db.getStakeWeightsByCapability('price', SNAP_BLOCK);
            assert.strictEqual(swq.meetsStakeThreshold(validators, ['aa11', 'bb22', 'cc33', 'dd44']), true);
        });

        it('leaves every other unscoped capability on the local path', async function () {
            const { db, mirror } = dbFor('DOGE', 'regtest');
            assert.deepStrictEqual(await db.getValidatorsByCapability('attestation', SNAP_BLOCK), []);
            assert.deepStrictEqual(await db.getValidatorsByCapability('full_node', SNAP_BLOCK), []);
            assert.strictEqual(await db.getActiveCapabilityCount('attestation', SNAP_BLOCK), 0);
            assert.strictEqual(mirror.callCount, 0);
        });

        it('leaves cross_chain and oracle_publish redirecting, as they always did', async function () {
            for (const cap of ['cross_chain', 'oracle_publish']) {
                const { db, mirror } = dbFor('DOGE', 'mainnet');
                const rows = await db.getValidatorsByCapability(cap, SNAP_BLOCK);
                assert.strictEqual(rows.length, 4, cap + ' must still resolve from the mirror');
                assert.strictEqual(mirror.callCount, 1);
                sinon.restore();
            }
        });
    });

    describe('BTC is unaffected', function () {

        ['mainnet', 'regtest'].forEach(function (network) {
            it('getValidatorsByCapability on BTC ' + network + ' stays on local stakes', async function () {
                const { db, local, mirror } = dbFor('BTC', network, LOCAL_ROWS);
                const rows = await db.getValidatorsByCapability('price', SNAP_BLOCK);
                assert.deepStrictEqual(rows.map(r => r.pubkey), ['ee55']);
                assert.strictEqual(mirror.callCount, 0, 'BTC must never read the mirror for a capability');
                assert.ok(local.callCount > 0, 'BTC must query the local stakes tables');
            });

            it('getStakeWeightsByCapability on BTC ' + network + ' stays on local stakes', async function () {
                const { db, local, mirror } = dbFor('BTC', network, LOCAL_ROWS);
                const rows = await db.getStakeWeightsByCapability('price', SNAP_BLOCK);
                assert.deepStrictEqual(rows.map(r => r.pubkey), ['ee55']);
                assert.deepStrictEqual(rows.map(r => r.source), ['localsrc']);
                assert.strictEqual(mirror.callCount, 0);
                assert.ok(local.callCount > 0);
            });

            it('getActiveCapabilityCount on BTC ' + network + ' stays on local stakes', async function () {
                const { db, local, mirror } = dbFor('BTC', network, [{ cnt: 7 }]);
                assert.strictEqual(await db.getActiveCapabilityCount('price', SNAP_BLOCK), 7);
                assert.strictEqual(mirror.callCount, 0);
                assert.ok(local.callCount > 0);
            });
        });
    });

    describe('the truncation fallback still behaves', function () {

        it('the local BTC path still marks a capped read truncated', async function () {
            const config = getTestConfig();
            const limit  = config['VALIDATOR_QUERY_LIMIT'];
            const capped = Array.from({ length: limit }, (_, i) => ({ pubkey: 'k' + i, total: '5000.00000000' }));
            const { db } = dbFor('BTC', 'regtest', capped);
            sinon.stub(console, 'warn');
            const rows = await db.getValidatorsByCapability('price', SNAP_BLOCK);
            assert.strictEqual(rows.truncated, true,
                'a capped local read must still flag truncation so price.js falls back per signer');
        });

        it('the mirrored path never claims truncation', async function () {
            const { db } = dbFor('DOGE', 'regtest');
            const rows = await db.getValidatorsByCapability('price', SNAP_BLOCK);
            assert.strictEqual(rows.truncated, undefined);
            assert.strictEqual(rows.truncated === true, false);
        });
    });
});
