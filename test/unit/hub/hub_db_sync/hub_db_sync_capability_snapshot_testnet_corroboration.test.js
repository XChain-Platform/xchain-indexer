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
 * test/unit/hub/hub_db_sync/hub_db_sync_capability_snapshot_testnet_corroboration.test.js
 *
 * The capability_snapshots re-derivation fence carries no network branch, so it must
 * behave the same on testnet as on regtest: a BTC-testnet node refuses a forged row it
 * can disprove from its own stakes, while LTC and DOGE testnet nodes, which hold no local
 * capability stakes, cannot self-check and mirror the identical row unchecked.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'testnet';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');
const HubDbSync         = require('../../../../src/hub/hub_db_sync.js');

// The BTC-anchored boundary the hub locked this validator set at.
const SNAP_BLOCK = 961234;

// This node's own authoritative stake rows at SNAP_BLOCK, in the shape
// stakeWeightsWithCap reads them (weight = the SOURCE aggregate, carried on every
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
    config.NETWORK = o.network || 'regtest';
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
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test', network: 'testnet',
                                        authoritativeDb: db || null });
    sinon.stub(sync, 'localColumns').resolves(
        new Set(['id', 'snapshot_block', 'capability', 'signing_pubkey', 'amount', 'source']));
    return { sync, inserted, hubDb };
}

afterEach(function () { sinon.restore(); });

describe('capability_snapshots re-derivation on testnet @regression @tier2', function () {

    beforeEach(function () { sinon.stub(console, 'error'); });

    it('a BTC-testnet node refuses a forged row', async function () {
        const { db }             = dbFor('BTC', { network: 'testnet' });
        const { sync, inserted } = syncFor(db);

        const applied = await sync.applyRow('capability_snapshots',
            snapshotRow({ signing_pubkey: 'ffff', source: 'attacker' }));

        assert.strictEqual(applied, false);
        assert.strictEqual(inserted.length, 0);
    });

    it('a BTC-testnet node refuses an inflated weight and mirrors an honest row', async function () {
        const { db }             = dbFor('BTC', { network: 'testnet' });
        const { sync, inserted } = syncFor(db);

        assert.strictEqual(await sync.applyRow('capability_snapshots',
            snapshotRow({ amount: '500000.00000000' })), false);
        await sync.applyRow('capability_snapshots', snapshotRow());

        assert.strictEqual(inserted.length, 1);
    });

    for (const coin of ['LTC', 'DOGE']) {
        it('a ' + coin + '-testnet node cannot self-check and mirrors the same forged row unchecked', async function () {
            const { db, seen }       = dbFor(coin, { network: 'testnet' });
            const { sync, inserted } = syncFor(db);

            await sync.applyRow('capability_snapshots',
                snapshotRow({ signing_pubkey: 'ffff', source: 'attacker' }));

            assert.strictEqual(inserted.length, 1);
            assert.strictEqual(seen.stakeQueries.length, 0, 'no local stake read is attempted off BTC');
            const v = await db.verifyCapabilitySnapshotRow(snapshotRow({ signing_pubkey: 'ffff' }));
            assert.strictEqual(v.verdict, 'unknown');
        });
    }
});
