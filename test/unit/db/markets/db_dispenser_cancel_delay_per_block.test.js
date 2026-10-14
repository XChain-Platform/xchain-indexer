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

const assert = require('assert');
const sinon  = require('sinon');

const dispensers = require('../../../../src/db/dispensers/index.js');

// A regtest DB double whose protocol time per stored block comes from `times`.
function dbFor(rows, times) {
    return {
        config: { NETWORK: 'regtest', COIN: 'BTC', DISPENSER_CLOSE_DELAY: 100 },
        util: {
            bcgt: (a, b) => Number(a) > Number(b),
            bcadd: (a, b) => String(Number(a) + Number(b)),
            isNull: value => value === null || value === undefined,
        },
        doQuery: sinon.stub().resolves(rows),
        protocolTimeForStoredBlock: sinon.stub().callsFake(async index =>
            Object.prototype.hasOwnProperty.call(times, index) ? times[index] : null),
    };
}

describe('dispenser close delay resolves each cancelling block once @regression @tier1', function () {

    afterEach(() => sinon.restore());

    it('reads protocol time once per distinct block and keeps the per-row verdicts and order', async function () {
        const rows = [
            { action_index: 3, block_time: 1, block_index: 7 },
            { action_index: 4, block_time: 1, block_index: 8 },
            { action_index: 5, block_time: 1, block_index: 7 },
            { action_index: 6, block_time: 1, block_index: 8 },
        ];
        // Block 7 matured (500 + 100 < 700); block 8 did not (650 + 100 >= 700).
        const db = dbFor(rows, { 7: 500, 8: 650 });

        const cancels = await dispensers.findCancelledDispensers.call(db, 700, 20);

        assert.deepStrictEqual(cancels, [3, 5]);
        sinon.assert.calledTwice(db.protocolTimeForStoredBlock);
        assert.deepStrictEqual(db.protocolTimeForStoredBlock.args.map(a => a[0]), [7, 8]);
    });

    it('reuses an unresolvable block as not yet elapsed for every row in it', async function () {
        const rows = [
            { action_index: 3, block_time: 1, block_index: 9 },
            { action_index: 4, block_time: 1, block_index: 9 },
        ];
        const db = dbFor(rows, {});

        assert.deepStrictEqual(await dispensers.findCancelledDispensers.call(db, 100000, 20), []);
        sinon.assert.calledOnceWithExactly(db.protocolTimeForStoredBlock, 9);
    });

    it('keys the reuse on the numeric block so a string and a number height share one read', async function () {
        const rows = [
            { action_index: 3, block_time: 1, block_index: '7' },
            { action_index: 4, block_time: 1, block_index: 7 },
        ];
        const db = dbFor(rows, { 7: 500 });

        assert.deepStrictEqual(await dispensers.findCancelledDispensers.call(db, 700, 20), [3, 4]);
        sinon.assert.calledOnce(db.protocolTimeForStoredBlock);
    });
});
