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
 * test/unit/hub/hub_db_sync/capability_snapshot_stake_memo.test.js
 *
 * N rows of one capability snapshot must run one stake aggregate, not N.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { SNAP_BLOCK, snapshotRow, dbFor } =
    require('./hub_db_sync_capability_snapshot_btc_rederive.test/helpers/fixtures.js');

afterEach(function () { sinon.restore(); });

describe('capability_snapshots stake set memo @regression @tier2', function () {

    it('runs one aggregate for many rows of one snapshot', async function () {
        const { db, seen } = dbFor('BTC');
        const rows = [
            snapshotRow(),
            snapshotRow({ signing_pubkey: 'bb22', source: 'src2', amount: '4000.00000000' }),
            snapshotRow({ signing_pubkey: 'cc33', source: 'src3', amount: '3000.00000000' }),
        ];
        const verdicts = [];
        for (const r of rows) verdicts.push((await db.verifyCapabilitySnapshotRow(r)).verdict);
        assert.deepStrictEqual(verdicts, ['verified', 'verified', 'verified']);
        assert.strictEqual(seen.stakeQueries.length, 1);
    });

    it('shares one query across concurrent rows', async function () {
        const { db, seen } = dbFor('BTC');
        const out = await Promise.all([1, 2, 3, 4].map(() => db.verifyCapabilitySnapshotRow(snapshotRow())));
        assert.ok(out.every(v => v.verdict === 'verified'));
        assert.strictEqual(seen.stakeQueries.length, 1);
    });

    it('re-derives when the local tip moves', async function () {
        const { db, seen } = dbFor('BTC', { tip: SNAP_BLOCK });
        await db.verifyCapabilitySnapshotRow(snapshotRow());
        db.doQuery.restore();
        sinon.stub(db, 'doQuery').callsFake(async (sql) => {
            if (/MAX\(block_index\)/.test(sql)) return [{ max_block: SNAP_BLOCK + 1 }];
            seen.stakeQueries.push({ sql });
            return [{ pubkey: 'aa11', source: 'src1', weight: '5000.00000000', _sr: 1 }];
        });
        await db.verifyCapabilitySnapshotRow(snapshotRow());
        assert.strictEqual(seen.stakeQueries.length, 2);
    });

    it('re-derives for a different snapshot block', async function () {
        const { db, seen } = dbFor('BTC');
        await db.verifyCapabilitySnapshotRow(snapshotRow());
        await db.verifyCapabilitySnapshotRow(snapshotRow({ snapshot_block: SNAP_BLOCK - 500 }));
        assert.strictEqual(seen.stakeQueries.length, 2);
    });

    it('does not pin a failed read', async function () {
        const { db } = dbFor('BTC');
        const real = db.getStakeWeightsByCapability.bind(db);
        const stub = sinon.stub(db, 'getStakeWeightsByCapability');
        stub.onFirstCall().rejects(new Error('boom'));
        stub.callsFake(real);
        const first = await db.verifyCapabilitySnapshotRow(snapshotRow());
        assert.strictEqual(first.verdict, 'unknown');
        const second = await db.verifyCapabilitySnapshotRow(snapshotRow());
        assert.strictEqual(second.verdict, 'verified');
    });
});
