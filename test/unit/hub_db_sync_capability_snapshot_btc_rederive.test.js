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
 * test/unit/hub_db_sync_capability_snapshot_btc_rederive.test.js
 *
 * , first step. capability_snapshots is the ONLY mirrored table that
 * arrives with no authentication of any kind: the rows are pulled from the hub
 * over a bare SELECT and applied with INSERT IGNORE, and they are the verification
 * authority every off-BTC resolver reads for cross_chain, oracle_publish, price and
 * attestation. A hub serving a forged validator set was mirrored verbatim.
 *
 * The full remedy (an SMT membership proof against the BTC state_checkpoints
 * stakes_root) needs a hub proof endpoint, a pinned trust anchor, a new activation
 * height and a grandfathering watermark, so it is a later spec round. What is built
 * here is the falsifiable first step: a BTC indexer holds the SAME stakes the hub
 * built these rows from, so it re-derives every mirrored row against its own
 * authoritative stakes at snapshot_block and refuses a contradiction.
 *
 * These cases pin BOTH halves, and the second half is the one that matters most:
 * a refusal must fire only where the node can actually prove the claim, because
 * every false refusal is a permanent hole in a consensus-critical mirror.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const HubDbSync         = require('../../src/hub_db_sync.js');

// The BTC-anchored boundary the hub locked this validator set at.
const SNAP_BLOCK = 961234;

// This node's own authoritative stake rows at SNAP_BLOCK, in the shape
// _stakeWeightsWithCap reads them (weight = the SOURCE aggregate, carried on every
// effective key of that source; `_sr` is the source rank the capped branch ranks on).
const LOCAL_STAKES = [
    { pubkey: 'aa11', source: 'src1', weight: '5000.00000000', _sr: 1 },
    { pubkey: 'bb22', source: 'src2', weight: '4000.00000000', _sr: 2 },
    // One source, two delegated keys - both carry the source aggregate.
    { pubkey: 'cc33', source: 'src3', weight: '3000.00000000', _sr: 3 },
    { pubkey: 'dd44', source: 'src3', weight: '3000.00000000', _sr: 3 },
];

// A capability_snapshots row as the hub serves it.
function snapshotRow(over) {
    return Object.assign({
        id:             77,
        snapshot_block: SNAP_BLOCK,
        capability:     'cross_chain',
        signing_pubkey: 'aa11',
        amount:         '5000.00000000',
        source:         'src1'
    }, over || {});
}

// A Database wired for `coin`, whose local stake re-derivation answers LOCAL_STAKES
// and whose parsed tip is `tip`. doQuery is dispatched on the statement so the REAL
// getStakeWeightsByCapability / getLatestBlockIndex bodies run: the point of the check
// is which rows those produce, so stubbing them out would test nothing.
function dbFor(coin, opts) {
    const o        = opts || {};
    const config   = getTestConfig();
    config.COIN    = coin;
    config.NETWORK = 'regtest';
    // Faithful to coins/DOGE.js and coins/LTC.js: no capabilities at all off BTC.
    if (coin !== 'BTC') config.STAKING = Object.assign({}, config.STAKING, { CAPABILITIES: {} });

    const util = new Utility();
    sinon.stub(util, 'logError');

    const db = new Database('127.0.0.1', 3306, 'xchain_test', 'u', 'p', { config, util });
    sinon.stub(db, 'getStatusId').resolves(1);
    const seen = { stakeQueries: [] };
    sinon.stub(db, 'doQuery').callsFake(async (sql, args) => {
        if (/MAX\(block_index\)/.test(sql)) return [{ max_block: ('tip' in o) ? o.tip : SNAP_BLOCK }];
        seen.stakeQueries.push({ sql, args });
        return ('stakes' in o) ? o.stakes : LOCAL_STAKES;
    });
    return { db, seen, config };
}

// A HubDbSync over a fake mirror table, with `authoritativeDb` wired to `db`. Applied
// rows land in `inserted`, so "was this row mirrored" is read off the statements the
// applier actually issued rather than asserted from a return value alone.
function syncFor(db) {
    const inserted = [];
    const hubDb = {
        doQuery: sinon.stub().callsFake(async (sql, args) => {
            if (/^INSERT/.test(sql)) inserted.push({ sql, args });
            return [];
        })
    };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test', network: 'regtest',
                                        authoritativeDb: db || null });
    sinon.stub(sync, '_localColumns').resolves(
        new Set(['id', 'snapshot_block', 'capability', 'signing_pubkey', 'amount', 'source']));
    return { sync, inserted, hubDb };
}

afterEach(function () { sinon.restore(); });

describe('capability_snapshots BTC re-derivation fence @regression @tier2', function () {

    describe('a contradiction the node can prove is refused', function () {

        // The refusal is deliberately loud on the real path; keep the suite readable.
        beforeEach(function () { sinon.stub(console, 'error'); });

        it('refuses a key no local stake makes an effective signer', async function () {
            const { db }              = dbFor('BTC');
            const { sync, inserted }  = syncFor(db);
            const forged = snapshotRow({ signing_pubkey: 'ffff', source: 'attacker' });

            const applied = await sync._applyRow('capability_snapshots', forged);

            assert.strictEqual(applied, false, 'a disprovable row must be refused, not applied');
            assert.strictEqual(inserted.length, 0, 'nothing may reach the mirror table');
        });

        it('refuses a real key carrying a weight the chain does not back', async function () {
            // The inflation shape: a key that IS staked, with its voting weight raised.
            // Weight is the quorum denominator input, so this is the forgery that pays.
            const { db }             = dbFor('BTC');
            const { sync, inserted } = syncFor(db);

            const applied = await sync._applyRow('capability_snapshots',
                snapshotRow({ amount: '500000.00000000' }));

            assert.strictEqual(applied, false);
            assert.strictEqual(inserted.length, 0);
        });

        it('refuses a key staked by a DIFFERENT source than the row claims', async function () {
            // source is the fourth key column and the unit quorum weight is deduped by,
            // so re-pointing a real key at another source is a real forgery.
            const { db }             = dbFor('BTC');
            const { sync, inserted } = syncFor(db);

            const applied = await sync._applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'aa11', source: 'src2', amount: '4000.00000000' }));

            assert.strictEqual(applied, false);
            assert.strictEqual(inserted.length, 0);
        });

        it('refuses a nonnumeric amount rather than letting it match anything', async function () {
            const { db }             = dbFor('BTC');
            const { sync, inserted } = syncFor(db);

            const applied = await sync._applyRow('capability_snapshots',
                snapshotRow({ amount: 'lots' }));

            assert.strictEqual(applied, false);
            assert.strictEqual(inserted.length, 0);
        });
    });

    describe('everything the node cannot disprove still mirrors', function () {

        it('applies an honest row', async function () {
            const { db }             = dbFor('BTC');
            const { sync, inserted } = syncFor(db);

            await sync._applyRow('capability_snapshots', snapshotRow());

            assert.strictEqual(inserted.length, 1, 'the honest row must still be mirrored');
            assert.match(inserted[0].sql, /INSERT IGNORE INTO capability_snapshots/);
        });

        it('applies both keys of a source that delegated twice', async function () {
            const { db }             = dbFor('BTC');
            const { sync, inserted } = syncFor(db);

            await sync._applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'cc33', source: 'src3', amount: '3000.00000000' }));
            await sync._applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'dd44', source: 'src3', amount: '3000.00000000' }));

            assert.strictEqual(inserted.length, 2, 'DELEGATE v0 is additive: both keys are honest rows');
        });

        it('applies a row whose amount differs only in FORMAT', async function () {
            // Two producers, one number. Refusing over a trailing zero would blow a hole
            // in a consensus-critical mirror for a serialization difference.
            const { db }             = dbFor('BTC');
            const { sync, inserted } = syncFor(db);

            await sync._applyRow('capability_snapshots', snapshotRow({ amount: '05000.0' }));

            assert.strictEqual(inserted.length, 1);
        });

        it('applies a row for a block this node has not parsed yet', async function () {
            // Below our own tip the stake history at that block is simply absent, so a
            // refusal there would reject every honest row served ahead of our sync.
            const { db }             = dbFor('BTC', { tip: SNAP_BLOCK - 1 });
            const { sync, inserted } = syncFor(db);

            await sync._applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'ffff', source: 'nobody' }));

            assert.strictEqual(inserted.length, 1, 'an unreached block is unknown, never a forgery');
        });

        it('applies every row on a chain that resolves FROM the mirror', async function () {
            // The honest limit of this step: off BTC there are no local capability stakes,
            // so the mirror is the authority and cannot be checked against itself.
            const { db, seen }       = dbFor('DOGE');
            const { sync, inserted } = syncFor(db);

            await sync._applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'ffff', source: 'attacker' }));

            assert.strictEqual(inserted.length, 1);
            assert.strictEqual(seen.stakeQueries.length, 0, 'no local stake read is even attempted off BTC');
        });

        it('applies rows when no authoritative stake db is wired', async function () {
            // The explorer's vendored display mirror: no indexer db, no re-derivation.
            const { sync, inserted } = syncFor(null);

            await sync._applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'ffff', source: 'attacker' }));

            assert.strictEqual(inserted.length, 1);
        });

        it('applies rows when the local re-derivation throws', async function () {
            const { db }             = dbFor('BTC');
            const { sync, inserted } = syncFor(db);
            sinon.stub(db, 'verifyCapabilitySnapshotRow').rejects(new Error('mirror db down'));
            sinon.stub(console, 'warn');

            await sync._applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'ffff', source: 'attacker' }));

            assert.strictEqual(inserted.length, 1, 'a failed re-derivation is not evidence of a forgery');
        });

        it('leaves every OTHER mirrored table untouched by the fence', async function () {
            const { db, seen } = dbFor('BTC');
            const { sync }     = syncFor(db);
            sync._localColumns.restore();
            sinon.stub(sync, '_localColumns').resolves(new Set(['id', 'checkpoint_seq']));

            await sync._applyRow('state_checkpoints', { id: 4, checkpoint_seq: 9 });

            assert.strictEqual(seen.stakeQueries.length, 0);
        });
    });

    describe('the verdict itself', function () {

        it('reports verified / refused / unknown, never a bare boolean', async function () {
            const { db } = dbFor('BTC');

            assert.strictEqual((await db.verifyCapabilitySnapshotRow(snapshotRow())).verdict, 'verified');
            const refused = await db.verifyCapabilitySnapshotRow(snapshotRow({ amount: '1' }));
            assert.strictEqual(refused.verdict, 'refused');
            assert.ok(refused.reason && /5000/.test(refused.reason), 'a refusal must say what it disproved');
            assert.strictEqual((await db.verifyCapabilitySnapshotRow(
                snapshotRow({ capability: 'not_a_capability' }))).verdict, 'unknown');
            assert.strictEqual((await db.verifyCapabilitySnapshotRow(
                snapshotRow({ snapshot_block: 'soon' }))).verdict, 'unknown');
        });

        it('re-derives at minStake 0, so a hub MIN_STAKE above ours cannot cause a refusal', async function () {
            // The hub filters its rows by its OWN authoritative MIN_STAKE, which may
            // legitimately differ from this node's local floor. Re-deriving at the local
            // floor would start refusing honest rows the moment the two drifted.
            const { db, seen } = dbFor('BTC');

            await db.verifyCapabilitySnapshotRow(snapshotRow());

            assert.strictEqual(seen.stakeQueries.length, 1);
            assert.ok(seen.stakeQueries[0].args.some(a => String(a) === '0'),
                'the local set must be re-derived with no stake floor at all');
        });

        it('stays unknown when the local set was truncated', async function () {
            // A truncated set is a PARTIAL set: absence from it proves nothing.
            const { db } = dbFor('BTC');
            sinon.stub(db, 'getStakeWeightsByCapability').callsFake(async () => {
                const rows = [];
                rows.truncated = true;
                return rows;
            });

            const v = await db.verifyCapabilitySnapshotRow(snapshotRow({ signing_pubkey: 'ffff' }));
            assert.strictEqual(v.verdict, 'unknown');
        });

        it('matches keys and sources case-insensitively, as the mirror collation does', async function () {
            // capability_snapshots is utf8_general_ci and AnchorRecovery lowercases keys,
            // so a case difference is the same row, not a contradiction.
            const { db } = dbFor('BTC');

            const v = await db.verifyCapabilitySnapshotRow(
                snapshotRow({ signing_pubkey: 'AA11', source: 'SRC1' }));
            assert.strictEqual(v.verdict, 'verified');
        });
    });
});
