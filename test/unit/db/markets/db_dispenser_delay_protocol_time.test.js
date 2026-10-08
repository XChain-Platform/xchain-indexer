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

function dbFor(rows, overrides = {}) {
    return Object.assign({
        config: {
            NETWORK: 'regtest',
            COIN: 'BTC',
            DISPENSER_LIST_DELAY: 100,
            DISPENSER_CLOSE_DELAY: 100,
        },
        util: {
            bcgt: (a, b) => Number(a) > Number(b),
            bcadd: (a, b) => String(Number(a) + Number(b)),
            isNull: value => value === null || value === undefined,
            isNumeric: value => value !== null && value !== '' && !isNaN(Number(value)),
        },
        doQuery: sinon.stub().resolves(rows),
        protocolTimeForStoredBlock: sinon.stub().callsFake(async index => index === 7 ? 500 : null),
    }, overrides);
}

describe('dispenser delay protocol-time gate @regression @tier1', function () {

    afterEach(() => sinon.restore());

    it('uses the edit block protocol time for a gated list delay', async function () {
        const db = dbFor([{ expiration: null, allow_list: 5, block_list: null,
            block_time: 1000, block_index: 7 }]);

        const edit = await dispensers.getDispenserEdits.call(db, 1, 700, 20);

        assert.strictEqual(edit.allow_list, 5);
        sinon.assert.calledOnceWithExactly(db.protocolTimeForStoredBlock, 7);
        assert.match(db.doQuery.firstCall.args[0], /b1\.block_index/);
    });

    it('keeps the raw edit timestamp when no current block context exists', async function () {
        const db = dbFor([{ expiration: null, allow_list: 5, block_list: null,
            block_time: 1000, block_index: 7 }]);

        const edit = await dispensers.getDispenserEdits.call(db, 1, 700);

        assert.strictEqual(edit.allow_list, false);
        sinon.assert.notCalled(db.protocolTimeForStoredBlock);
    });

    it('uses the database processing height when the caller omits the current height', async function () {
        const db = dbFor([{ expiration: null, allow_list: 5, block_list: null,
            block_time: 1000, block_index: 7 }], { blockIndex: 20 });

        const edit = await dispensers.getDispenserEdits.call(db, 1, 700);

        assert.strictEqual(edit.allow_list, 5);
        sinon.assert.calledOnceWithExactly(db.protocolTimeForStoredBlock, 7);
    });

    it('uses the cancellation block protocol time for a gated close delay', async function () {
        const db = dbFor([{ action_index: 9, block_time: 1000, block_index: 7 }]);

        const cancels = await dispensers.findCancelledDispensers.call(db, 700, 20);

        assert.deepStrictEqual(cancels, [9]);
        sinon.assert.calledOnceWithExactly(db.protocolTimeForStoredBlock, 7);
        assert.match(db.doQuery.firstCall.args[0], /b1\.block_index/);
    });

    it('keeps the raw cancellation timestamp when no current block context exists', async function () {
        const db = dbFor([{ action_index: 9, block_time: 1000, block_index: 7 }]);

        assert.deepStrictEqual(await dispensers.findCancelledDispensers.call(db, 700), []);
        sinon.assert.notCalled(db.protocolTimeForStoredBlock);
    });

    it('does not mature a list delay when the gated stored block cannot be resolved', async function () {
        const db = dbFor([{ expiration: null, allow_list: 5, block_list: null,
            block_time: 1000, block_index: 8 }]);

        const edit = await dispensers.getDispenserEdits.call(db, 1, 10000, 20);

        assert.strictEqual(edit.allow_list, false);
        sinon.assert.calledOnceWithExactly(db.protocolTimeForStoredBlock, 8);
    });

    it('does not mature a close delay when the gated stored block cannot be resolved', async function () {
        const db = dbFor([{ action_index: 9, block_time: 1000, block_index: 8 }]);

        assert.deepStrictEqual(await dispensers.findCancelledDispensers.call(db, 10000, 20), []);
        sinon.assert.calledOnceWithExactly(db.protocolTimeForStoredBlock, 8);
    });

    it('leaves mainnet on raw timestamps while the height gate is unarmed', async function () {
        const db = dbFor([{ action_index: 9, block_time: 1000, block_index: 7 }]);
        db.config.NETWORK = 'mainnet';

        assert.deepStrictEqual(await dispensers.findCancelledDispensers.call(db, 700, 20), []);
        sinon.assert.notCalled(db.protocolTimeForStoredBlock);
    });
});
