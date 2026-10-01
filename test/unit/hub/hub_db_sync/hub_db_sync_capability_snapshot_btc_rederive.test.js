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
 * test/unit/hub/hub_db_sync/hub_db_sync_capability_snapshot_btc_rederive.test.js
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

const srb    = require('../../../../src/consensus/snapshot_reorg_buffer.js');
const {
    SNAP_BLOCK, snapshotRow, dbFor, syncFor, historyDb, DEACTIVATED, PRE_TOPUP,
} = require('./hub_db_sync_capability_snapshot_btc_rederive.test/helpers/fixtures.js');

afterEach(function () { sinon.restore(); });

describe('capability_snapshots BTC re-derivation fence @regression @tier2', function () { describe('a contradiction the node can prove is refused', function () {

        // The refusal is deliberately loud on the real path; keep the suite readable.
        beforeEach(function () { sinon.stub(console, 'error'); });

        it('refuses a key no local stake makes an effective signer', async function () {
            const { db }              = dbFor('BTC');
            const { sync, inserted }  = syncFor(db);
            const forged = snapshotRow({ signing_pubkey: 'ffff', source: 'attacker' });

            const applied = await sync.applyRow('capability_snapshots', forged);

            assert.strictEqual(applied, false, 'a disprovable row must be refused, not applied');
            assert.strictEqual(inserted.length, 0, 'nothing may reach the mirror table');
        });

        it('refuses a real key carrying a weight the chain does not back', async function () {
            // The inflation shape: a key that IS staked, with its voting weight raised.
            // Weight is the quorum denominator input, so this is the forgery that pays.
            const { db }             = dbFor('BTC');
            const { sync, inserted } = syncFor(db);

            const applied = await sync.applyRow('capability_snapshots',
                snapshotRow({ amount: '500000.00000000' }));

            assert.strictEqual(applied, false);
            assert.strictEqual(inserted.length, 0);
        });

        it('refuses a key staked by a DIFFERENT source than the row claims', async function () {
            // source is the fourth key column and the unit quorum weight is deduped by,
            // so re-pointing a real key at another source is a real forgery.
            const { db }             = dbFor('BTC');
            const { sync, inserted } = syncFor(db);

            const applied = await sync.applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'aa11', source: 'src2', amount: '4000.00000000' }));

            assert.strictEqual(applied, false);
            assert.strictEqual(inserted.length, 0);
        });

        it('refuses a nonnumeric amount rather than letting it match anything', async function () {
            const { db }             = dbFor('BTC');
            const { sync, inserted } = syncFor(db);

            const applied = await sync.applyRow('capability_snapshots',
                snapshotRow({ amount: 'lots' }));

            assert.strictEqual(applied, false);
            assert.strictEqual(inserted.length, 0);
        });
}); });

describe('capability_snapshots BTC re-derivation fence @regression @tier2', function () { describe('everything the node cannot disprove still mirrors', function () {
        it('applies an honest row', async function () {
            const { db }             = dbFor('BTC');
            const { sync, inserted } = syncFor(db);

            await sync.applyRow('capability_snapshots', snapshotRow());

            assert.strictEqual(inserted.length, 1, 'the honest row must still be mirrored');
            assert.match(inserted[0].sql, /INSERT IGNORE INTO capability_snapshots/);
        });

        it('applies both keys of a source that delegated twice', async function () {
            const { db }             = dbFor('BTC');
            const { sync, inserted } = syncFor(db);

            await sync.applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'cc33', source: 'src3', amount: '3000.00000000' }));
            await sync.applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'dd44', source: 'src3', amount: '3000.00000000' }));

            assert.strictEqual(inserted.length, 2, 'DELEGATE v0 is additive: both keys are honest rows');
        });

        it('applies a row whose amount differs only in FORMAT', async function () {
            // Two producers, one number. Refusing over a trailing zero would blow a hole
            // in a consensus-critical mirror for a serialization difference.
            const { db }             = dbFor('BTC');
            const { sync, inserted } = syncFor(db);

            await sync.applyRow('capability_snapshots', snapshotRow({ amount: '05000.0' }));

            assert.strictEqual(inserted.length, 1);
        });

        it('applies a row for a block this node has not parsed yet', async function () {
            // Below our own tip the stake history at that block is simply absent, so a
            // refusal there would reject every honest row served ahead of our sync. Unreached
            // means below the BURIED height the set resolves at, not the declared one.
            const { db }             = dbFor('BTC', { tip: SNAP_BLOCK - srb.CANONICAL_REORG_BUFFER - 1 });
            const { sync, inserted } = syncFor(db);

            await sync.applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'ffff', source: 'nobody' }));

            assert.strictEqual(inserted.length, 1, 'an unreached block is unknown, never a forgery');
        });

        it('applies every row on a chain that resolves FROM the mirror', async function () {
            // The honest limit of this step: off BTC there are no local capability stakes,
            // so the mirror is the authority and cannot be checked against itself.
            const { db, seen }       = dbFor('DOGE');
            const { sync, inserted } = syncFor(db);

            await sync.applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'ffff', source: 'attacker' }));

            assert.strictEqual(inserted.length, 1);
            assert.strictEqual(seen.stakeQueries.length, 0, 'no local stake read is even attempted off BTC');
        });
}); });

describe('capability_snapshots BTC re-derivation fence @regression @tier2', function () { describe('everything the node cannot disprove still mirrors', function () {
        it('applies rows when no authoritative stake db is wired', async function () {
            // The explorer's vendored display mirror: no indexer db, no re-derivation.
            const { sync, inserted } = syncFor(null);

            await sync.applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'ffff', source: 'attacker' }));

            assert.strictEqual(inserted.length, 1);
        });

        it('applies rows when the local re-derivation throws', async function () {
            const { db }             = dbFor('BTC');
            const { sync, inserted } = syncFor(db);
            sinon.stub(db, 'verifyCapabilitySnapshotRow').rejects(new Error('mirror db down'));
            sinon.stub(console, 'warn');

            await sync.applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'ffff', source: 'attacker' }));

            assert.strictEqual(inserted.length, 1, 'a failed re-derivation is not evidence of a forgery');
        });

        it('leaves every OTHER mirrored table untouched by the fence', async function () {
            const { db, seen } = dbFor('BTC');
            const { sync }     = syncFor(db);
            sync.localColumns.restore();
            sinon.stub(sync, 'localColumns').resolves(new Set(['id', 'checkpoint_seq']));

            await sync.applyRow('state_checkpoints', { id: 4, checkpoint_seq: 9 });

            assert.strictEqual(seen.stakeQueries.length, 0);
        });
}); });

describe('capability_snapshots BTC re-derivation fence @regression @tier2', function () { describe('the verdict itself', function () {

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
}); });

describe('capability_snapshots BTC re-derivation fence @regression @tier2', function () { describe('the set is resolved at the buried height', function () {

        it('verifies and mirrors a row whose source deactivated inside the buffer', async function () {
            const { db, asked }      = historyDb(SNAP_BLOCK);
            const { sync, inserted } = syncFor(db);

            const v = await db.verifyCapabilitySnapshotRow(snapshotRow(DEACTIVATED));
            assert.strictEqual(v.verdict, 'verified', 'N-6 still carries the stake: ' + v.reason);
            assert.strictEqual(asked[0], SNAP_BLOCK - srb.CANONICAL_REORG_BUFFER);

            await sync.applyRow('capability_snapshots', snapshotRow(DEACTIVATED));
            assert.strictEqual(inserted.length, 1, 'an honest transition row must reach the mirror');
        });

        it('verifies a row carrying the pre-top-up weight when the top-up activates inside the buffer', async function () {
            const { db, asked } = historyDb(SNAP_BLOCK);

            const v = await db.verifyCapabilitySnapshotRow(snapshotRow(PRE_TOPUP));

            assert.strictEqual(v.verdict, 'verified', 'the hub resolved the pre-top-up weight: ' + v.reason);
            assert.deepStrictEqual(asked, [SNAP_BLOCK - srb.CANONICAL_REORG_BUFFER]);
        });

        it('refuses the same rows declared a full buffer later, judged from the buried tip', async function () {
            // Declared at N+6 they resolve at N, after both changes, so both contradict the
            // chain. The tip sits between the buried and declared heights: the availability
            // gate must use the buried height too, or these read unknown and mirror.
            const later = SNAP_BLOCK + srb.CANONICAL_REORG_BUFFER;
            const { db, asked } = historyDb(later - 1);

            for (const over of [DEACTIVATED, PRE_TOPUP]) {
                const v = await db.verifyCapabilitySnapshotRow(snapshotRow(Object.assign({ snapshot_block: later }, over)));
                assert.strictEqual(v.verdict, 'refused', over.signing_pubkey + ': ' + v.reason);
                assert.match(v.reason, new RegExp('block ' + later + ' \\(resolved at ' + SNAP_BLOCK + '\\)'));
            }
            assert.deepStrictEqual(asked, [SNAP_BLOCK, SNAP_BLOCK]);
        });
}); });

describe('capability_snapshots BTC re-derivation fence @regression @tier2', function () { describe('the burial flag-day boundary', function () {

        it('resolves at the declared height below SNAPSHOT_BURIAL_ACTIVATION and buries from it on', async function () {
            // Every shipped network is armed at genesis, so the pre-flag-day era is reached
            // by arming the fixture network (regtest) at a nonzero height for this call,
            // as slash.test/snapshot_burial.test.js does.
            const map   = srb.SNAPSHOT_BURIAL_ACTIVATION;
            const saved = map.regtest;
            map.regtest = SNAP_BLOCK;
            const { db, asked } = historyDb(SNAP_BLOCK);
            let below, atGate;
            try {
                below  = await db.verifyCapabilitySnapshotRow(
                    snapshotRow(Object.assign({ snapshot_block: SNAP_BLOCK - 1 }, DEACTIVATED)));
                atGate = await db.verifyCapabilitySnapshotRow(snapshotRow(DEACTIVATED));
            } finally { map.regtest = saved; }

            assert.strictEqual(below.verdict, 'refused', 'below the gate the declared height is used verbatim');
            assert.strictEqual(atGate.verdict, 'verified', 'at the gate the declared height is buried: ' + atGate.reason);
            assert.deepStrictEqual(asked, [SNAP_BLOCK - 1, SNAP_BLOCK - srb.CANONICAL_REORG_BUFFER]);
        });
}); });
