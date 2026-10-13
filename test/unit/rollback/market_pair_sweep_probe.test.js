'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const sweepSql = require('../../../src/db/rollback/sweeps.js');

describe('sweepOrphanedMarketPairs probe @regression @tier1', function () {
    it('matches each tick side index-friendly, never wrapping the column', async function () {
        const doQuery = sinon.stub().resolves([{ 1: 1 }]);
        await sweepSql.sweepOrphanedMarketPairs({ doQuery }, [{ tick1_id: 0, tick2_id: 7 }]);
        const sql = doQuery.firstCall.args[0];
        assert.ok(!/COALESCE/i.test(sql));
        assert.ok(/\(o\.give_tick_id=\? OR \(o\.give_tick_id IS NULL AND \?=0\)\)/.test(sql));
        assert.ok(/\(o\.get_tick_id=\? OR \(o\.get_tick_id IS NULL AND \?=0\)\)/.test(sql));
        assert.deepStrictEqual(doQuery.firstCall.args[1], [0, 0, 7, 7, 7, 7, 0, 0]);
        assert.strictEqual(doQuery.callCount, 1, 'a surviving order keeps the market');
    });

    it('falls through to order_matches and deletes only when neither survives', async function () {
        const doQuery = sinon.stub().resolves([]);
        await sweepSql.sweepOrphanedMarketPairs({ doQuery }, [{ tick1_id: 3, tick2_id: 7 }]);
        assert.strictEqual(doQuery.callCount, 3);
        assert.ok(/FROM order_matches om/.test(doQuery.secondCall.args[0]));
        assert.ok(!/COALESCE/i.test(doQuery.secondCall.args[0]));
        assert.ok(/^\s*DELETE FROM markets/.test(doQuery.thirdCall.args[0]));
    });
});
