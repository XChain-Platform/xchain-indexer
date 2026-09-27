'use strict';

const assert = require('assert');
const { sumMeteredFees } = require('./fee_sum.js');

describe('metered fee sum', function () {
    it('sums metered fees from multiple rows', function () {
        const executions = [
            { metered_fee: '150' },
            { metered_fee: '225' },
        ];
        assert.strictEqual(sumMeteredFees(executions), 375);
    });

    it('returns the metered fee from a single row', function () {
        assert.strictEqual(sumMeteredFees([{ metered_fee: '150' }]), 150);
    });

    it('returns zero for no rows', function () {
        assert.strictEqual(sumMeteredFees([]), 0);
    });

    it('sums a numeric metered fee', function () {
        assert.strictEqual(sumMeteredFees([{ metered_fee: 225 }]), 225);
    });
});
