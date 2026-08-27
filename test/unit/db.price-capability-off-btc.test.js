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
 * the two resolvers was scoped to cross_chain and oracle_publish only, so `price`
 * fell through to a local `stakes` path that is empty off BTC. Weighted quorum is
 * genesis-active on regtest, so the empty set summed to a stake of zero.
 *
 * The fix admits `price` to that redirect, GATED, because it flips bytes already
 * on chain from invalid to valid. Below the gate resolution must be exactly what
 * the deployed fleet does today or a from-genesis reindex diverges.
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
const priceCapSnapshot  = require('../../src/price_capability_snapshot_activation');

// A block time comfortably inside the genesis-on era of any network whose gate is
// armed to 0, and comfortably below the mainnet 9999999999 sentinel.
const BLOCK_TIME = 1756166400;   // 2026-08-26

// The BTC-anchored block the round's validator set is locked at.
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
    const mirror = sinon.stub().resolves(MIRROR_ROWS);
    // _mirrorDb() prefers indexer.hubDb, which is where the mirrored tables live in
    // a distributed deployment.
    db.indexer = { hubDb: { doQuery: mirror } };
    return { db, local, mirror };
}

afterEach(function () { sinon.restore(); });

describe('price capability resolution off BTC @regression', function () {

    describe('below the gate: replay of the existing chain is untouched', function () {

        it('getValidatorsByCapability returns the empty local-path set on DOGE mainnet', async function () {
            const { db, mirror } = dbFor('DOGE', 'mainnet');
            const rows = await db.getValidatorsByCapability('price', SNAP_BLOCK, undefined, BLOCK_TIME);
            // Exactly what the deployed fleet returns today: no capability configured
            // off BTC, so the resolver returns a bare empty array with no truncation mark.
            assert.deepStrictEqual(rows, []);
            assert.strictEqual(rows.truncated, undefined);
            assert.strictEqual(mirror.callCount, 0, 'the mirror must not be consulted below the gate');
        });

        it('getStakeWeightsByCapability returns the empty local-path set on DOGE mainnet', async function () {
            const { db, mirror } = dbFor('DOGE', 'mainnet');
            const rows = await db.getStakeWeightsByCapability('price', SNAP_BLOCK, undefined, BLOCK_TIME);
            assert.deepStrictEqual(rows, []);
            assert.strictEqual(mirror.callCount, 0, 'the mirror must not be consulted below the gate');
        });

        it('is the zero-stake sum that produced the measured invalid status', async function () {
            const swq  = require('../../src/stake_weighted_quorum');
            const { db } = dbFor('DOGE', 'mainnet');
            const validators = await db.getStakeWeightsByCapability('price', SNAP_BLOCK, undefined, BLOCK_TIME);
            // The four signatures on the DOGE regtest rounds all verified; the quorum
            // failed because S was 0. This pins the cause, not just the symptom.
            assert.strictEqual(swq.meetsStakeThreshold(validators, ['aa11', 'bb22', 'cc33', 'dd44']), false);
        });

        it('fails CLOSED when no block time reaches the resolver', async function () {
            // A caller that has not been taught to pass the action's block time must get
            // today's behaviour, never the new one: an ungated flip is the fork.
            for (const missing of [undefined, null, '', false, 'not-a-time', NaN]) {
                const { db, mirror } = dbFor('DOGE', 'regtest');   // gate armed to 0 here
                const rows = await db.getValidatorsByCapability('price', SNAP_BLOCK, undefined, missing);
                assert.deepStrictEqual(rows, [], 'block time ' + String(missing) + ' must fail closed');
                assert.strictEqual(mirror.callCount, 0, 'block time ' + String(missing) + ' must not reach the mirror');
                sinon.restore();
            }
        });

        it('fails CLOSED on a network the gate map does not name', async function () {
            const { db, mirror } = dbFor('DOGE', 'signet');
            assert.deepStrictEqual(await db.getValidatorsByCapability('price', SNAP_BLOCK, undefined, BLOCK_TIME), []);
            assert.strictEqual(mirror.callCount, 0);
        });
    });

    describe('at or above the gate: the mirrored set answers', function () {

        it('getValidatorsByCapability reads capability_snapshots for the block', async function () {
            const { db, local, mirror } = dbFor('DOGE', 'regtest');
            const rows = await db.getValidatorsByCapability('price', SNAP_BLOCK, undefined, BLOCK_TIME);
            assert.deepStrictEqual(rows.map(r => r.pubkey), ['aa11', 'bb22', 'cc33', 'dd44']);
            assert.deepStrictEqual(rows.map(r => r.amount),
                ['5000.00000000', '4000.00000000', '3000.00000000', '2000.00000000']);
            assert.strictEqual(mirror.callCount, 1);
            assert.deepStrictEqual(mirror.firstCall.args[1], ['price', SNAP_BLOCK]);
            assert.match(mirror.firstCall.args[0], /FROM capability_snapshots/);
            assert.strictEqual(local.callCount, 0, 'the empty local-stakes path must not be touched');
        });

        it('getStakeWeightsByCapability reads the source-keyed mirrored weights', async function () {
            const { db, local, mirror } = dbFor('DOGE', 'regtest');
            const rows = await db.getStakeWeightsByCapability('price', SNAP_BLOCK, undefined, BLOCK_TIME);
            assert.deepStrictEqual(rows.map(r => r.pubkey), ['aa11', 'bb22', 'cc33', 'dd44']);
            assert.deepStrictEqual(rows.map(r => r.source), ['src1', 'src2', 'src3', 'src4']);
            assert.deepStrictEqual(rows.map(r => r.weight),
                ['5000.00000000', '4000.00000000', '3000.00000000', '2000.00000000']);
            assert.strictEqual(mirror.callCount, 1);
            assert.strictEqual(local.callCount, 0);
        });

        it('the count set and the weight set name the SAME capable signers', async function () {
            // The split this guards against is the worst shape the bug can take: a node
            // that tallies signatures against one validator set and divides by a quorum
            // denominator computed from another reaches a verdict no other node reaches.
            const a = dbFor('DOGE', 'regtest');
            const counted  = await a.db.getValidatorsByCapability('price', SNAP_BLOCK, undefined, BLOCK_TIME);
            sinon.restore();
            const b = dbFor('DOGE', 'regtest');
            const weighted = await b.db.getStakeWeightsByCapability('price', SNAP_BLOCK, undefined, BLOCK_TIME);

            assert.strictEqual(counted.length, weighted.length,
                'count resolver and weight resolver disagree about HOW MANY signers are capable');
            assert.deepStrictEqual(counted.map(r => r.pubkey).sort(), weighted.map(r => r.pubkey).sort(),
                'count resolver and weight resolver disagree about WHO is capable');
            // Same numbers on both sides, so a quorum computed either way agrees.
            assert.deepStrictEqual(counted.map(r => String(r.amount)), weighted.map(r => String(r.weight)),
                'count resolver and weight resolver disagree about the stake behind each signer');
        });

        it('the mirrored set now clears the stake-weighted quorum the measured rounds failed', async function () {
            const swq = require('../../src/stake_weighted_quorum');
            const { db } = dbFor('DOGE', 'regtest');
            const validators = await db.getStakeWeightsByCapability('price', SNAP_BLOCK, undefined, BLOCK_TIME);
            assert.strictEqual(swq.meetsStakeThreshold(validators, ['aa11', 'bb22', 'cc33', 'dd44']), true);
        });

        it('leaves every other unscoped capability on the local path', async function () {
            const { db, mirror } = dbFor('DOGE', 'regtest');
            assert.deepStrictEqual(await db.getValidatorsByCapability('attestation', SNAP_BLOCK, undefined, BLOCK_TIME), []);
            assert.deepStrictEqual(await db.getValidatorsByCapability('full_node', SNAP_BLOCK, undefined, BLOCK_TIME), []);
            assert.strictEqual(mirror.callCount, 0);
        });

        it('leaves cross_chain and oracle_publish ungated, as they were', async function () {
            // Those two predate this gate and have never resolved any other way, so they
            // must redirect with no block time at all; re-gating them would itself be a
            // consensus change.
            for (const cap of ['cross_chain', 'oracle_publish']) {
                const { db, mirror } = dbFor('DOGE', 'mainnet');
                const rows = await db.getValidatorsByCapability(cap, SNAP_BLOCK);
                assert.strictEqual(rows.length, 4, cap + ' must still resolve from the mirror');
                assert.strictEqual(mirror.callCount, 1);
                sinon.restore();
            }
        });
    });

    describe('BTC is unaffected on either side of the gate', function () {

        ['mainnet', 'regtest'].forEach(function (network) {
            it('getValidatorsByCapability on BTC ' + network + ' stays on local stakes', async function () {
                const { db, local, mirror } = dbFor('BTC', network, LOCAL_ROWS);
                const rows = await db.getValidatorsByCapability('price', SNAP_BLOCK, undefined, BLOCK_TIME);
                assert.deepStrictEqual(rows.map(r => r.pubkey), ['ee55']);
                assert.strictEqual(mirror.callCount, 0, 'BTC must never read the mirror for a capability');
                assert.ok(local.callCount > 0, 'BTC must query the local stakes tables');
            });

            it('getStakeWeightsByCapability on BTC ' + network + ' stays on local stakes', async function () {
                const { db, local, mirror } = dbFor('BTC', network, LOCAL_ROWS);
                const rows = await db.getStakeWeightsByCapability('price', SNAP_BLOCK, undefined, BLOCK_TIME);
                assert.deepStrictEqual(rows.map(r => r.pubkey), ['ee55']);
                assert.deepStrictEqual(rows.map(r => r.source), ['localsrc']);
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
            const rows = await db.getValidatorsByCapability('price', SNAP_BLOCK, undefined, BLOCK_TIME);
            assert.strictEqual(rows.truncated, true,
                'a capped local read must still flag truncation so price.js falls back per signer');
        });

        it('the mirrored path never claims truncation, so the fallback is not entered', async function () {
            // actions/price.js drops to the per-signer hasCapability path when the capable
            // read reports `truncated === true`. hasCapability has NOT been admitted to the
            // mirror redirect, so off BTC it would answer false for every signer and drop
            // the whole quorum. The mirrored read is unbounded and marks nothing, so that
            // fallback is unreachable on this path; if it ever became reachable, this
            // assertion is what fails first.
            const { db } = dbFor('DOGE', 'regtest');
            const rows = await db.getValidatorsByCapability('price', SNAP_BLOCK, undefined, BLOCK_TIME);
            assert.strictEqual(rows.truncated, undefined);
            assert.strictEqual(rows.truncated === true, false,
                'a mirrored read must never send price.js to the off-BTC-blind hasCapability path');
        });
    });

    describe('the gate itself', function () {

        it('is UNARMED on mainnet and genesis-on for the test networks', function () {
            assert.deepStrictEqual(priceCapSnapshot.PRICE_CAPABILITY_SNAPSHOT_ACTIVATION,
                { mainnet: 9999999999, testnet: 0, regtest: 0 });
        });

        it('is keyed on time, so a block INDEX cannot be mistaken for an armed instant', function () {
            // A mainnet BTC height (~10^6) is nowhere near the sentinel, so passing a height
            // where a time belongs reads as "not yet active" rather than silently activating.
            assert.strictEqual(priceCapSnapshot.isPriceCapabilitySnapshotActive(961234, 'mainnet'), false);
            assert.strictEqual(priceCapSnapshot.isPriceCapabilitySnapshotActive(9999999999, 'mainnet'), true);
        });
    });
});
