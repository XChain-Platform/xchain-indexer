/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const Utility = require('../../../src/utility.js');
const { stakeSnapshotStrings } = require('../../../src/db/contracts/stake_snapshot_strings.js');

const util = new Utility();

describe('stakeSnapshotStrings', function () {
    it('returns plain decimal strings while preserving keys and staker order', function () {
        const tiny = util.bcadd('0', '0.00000003', 8);
        const big = util.bcadd('0', '2.5', 8);
        const snapshot = {
            stakeByPubkeyTick: { 'aa|XCHAIN': tiny, 'bb|XCHAIN': big },
            totalByTick: { XCHAIN: util.bcadd(tiny, big, 8) },
            stakersByTick: { XCHAIN: [{ pubkey: 'bb', amount: big }, { pubkey: 'aa', amount: tiny }] }
        };

        const result = stakeSnapshotStrings(util, snapshot);

        assert.deepStrictEqual(result, {
            stakeByPubkeyTick: { 'aa|XCHAIN': '0.00000003', 'bb|XCHAIN': '2.5' },
            totalByTick: { XCHAIN: '2.50000003' },
            stakersByTick: { XCHAIN: [
                { pubkey: 'bb', amount: '2.5' },
                { pubkey: 'aa', amount: '0.00000003' }
            ] }
        });
        assert.notStrictEqual(result.stakeByPubkeyTick['aa|XCHAIN'], '3e-8');
        assert.ok(Object.values(result.stakeByPubkeyTick).every(amount => typeof amount === 'string'));
        assert.ok(Object.values(result.totalByTick).every(amount => typeof amount === 'string'));
        assert.ok(result.stakersByTick.XCHAIN.every(staker => typeof staker.amount === 'string'));
    });
});

describe('stakeSnapshotStrings fresh output', function () {
    it('does not mutate or reuse input objects, arrays, entries, or amounts', function () {
        const tiny = util.bcadd('0', '0.00000003', 8);
        const total = util.bcadd(tiny, '2.5', 8);
        const entry = { pubkey: 'aa', amount: tiny };
        const snapshot = {
            stakeByPubkeyTick: { 'aa|XCHAIN': tiny },
            totalByTick: { XCHAIN: total },
            stakersByTick: { XCHAIN: [entry] }
        };

        const result = stakeSnapshotStrings(util, snapshot);

        assert.strictEqual(snapshot.stakeByPubkeyTick['aa|XCHAIN'], tiny);
        assert.strictEqual(snapshot.totalByTick.XCHAIN, total);
        assert.strictEqual(snapshot.stakersByTick.XCHAIN[0], entry);
        assert.strictEqual(snapshot.stakersByTick.XCHAIN[0].amount, tiny);
        assert.notStrictEqual(result.stakeByPubkeyTick, snapshot.stakeByPubkeyTick);
        assert.notStrictEqual(result.totalByTick, snapshot.totalByTick);
        assert.notStrictEqual(result.stakersByTick, snapshot.stakersByTick);
        assert.notStrictEqual(result.stakersByTick.XCHAIN, snapshot.stakersByTick.XCHAIN);
        assert.notStrictEqual(result.stakersByTick.XCHAIN[0], entry);
    });

    it('returns three fresh empty objects for an empty snapshot', function () {
        const snapshot = { stakeByPubkeyTick: {}, totalByTick: {}, stakersByTick: {} };
        const result = stakeSnapshotStrings(util, snapshot);

        assert.deepStrictEqual(result, { stakeByPubkeyTick: {}, totalByTick: {}, stakersByTick: {} });
        assert.notStrictEqual(result.stakeByPubkeyTick, snapshot.stakeByPubkeyTick);
        assert.notStrictEqual(result.totalByTick, snapshot.totalByTick);
        assert.notStrictEqual(result.stakersByTick, snapshot.stakersByTick);
    });
});
