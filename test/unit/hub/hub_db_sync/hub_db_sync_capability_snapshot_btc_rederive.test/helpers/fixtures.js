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
 * test/unit/hub/hub_db_sync/hub_db_sync_capability_snapshot_btc_rederive.test/helpers/fixtures.js
 *
 * Shared fixtures for the capability_snapshots BTC re-derivation fence cases: the
 * hub-served row shape, a Database whose real stake-weight bodies run over a stubbed
 * doQuery, a HubDbSync over a fake mirror table, and a stake history that
 * changes inside the reorg buffer.
 */

'use strict';

const sinon = require('sinon');

const { getTestConfig } = require('../../../../../fixtures/config');
const Utility           = require('../../../../../../src/utility');
const Database          = require('../../../../../../src/db');
const HubDbSync         = require('../../../../../../src/hub/hub_db_sync.js');

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
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test', network: 'regtest',
                                        authoritativeDb: db || null });
    sinon.stub(sync, 'localColumns').resolves(
        new Set(['id', 'snapshot_block', 'capability', 'signing_pubkey', 'amount', 'source']));
    return { sync, inserted, hubDb };
}

// The hub resolves each set at the BURIED height (declared minus
// CANONICAL_REORG_BUFFER) and writes the row under the declared block, so the fence
// must bury too. This history changes inside the buffer below SNAP_BLOCK: source
// srcx deactivates at SNAP_BLOCK - 3, and source srcy tops up from 1000 to 2000 at
// SNAP_BLOCK - 2. `asked` records every height the re-derivation resolved at.
function historyDb(tip) {
    const { db } = dbFor('BTC', { tip });
    const asked  = [];
    sinon.stub(db, 'getStakeWeightsByCapability').callsFake(async (capability, block) => {
        asked.push(block);
        const rows = [{ pubkey: 'aa11', source: 'src1', weight: '5000.00000000' }];
        if (block < SNAP_BLOCK - 3) rows.push({ pubkey: 'ee55', source: 'srcx', weight: '2000.00000000' });
        rows.push({ pubkey: 'ff66', source: 'srcy',
                    weight: block < SNAP_BLOCK - 2 ? '1000.00000000' : '2000.00000000' });
        return rows;
    });
    return { db, asked };
}

const DEACTIVATED = { signing_pubkey: 'ee55', source: 'srcx', amount: '2000.00000000' };
const PRE_TOPUP   = { signing_pubkey: 'ff66', source: 'srcy', amount: '1000.00000000' };

module.exports = {
    SNAP_BLOCK, LOCAL_STAKES, snapshotRow, dbFor, syncFor, historyDb, DEACTIVATED, PRE_TOPUP,
};
