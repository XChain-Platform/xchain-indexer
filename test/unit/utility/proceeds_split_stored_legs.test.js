const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../../src/utility.js');
const util = new Utility();

describe('Stored payout legs are applied as recorded at match', function () {
    it('applies a stored split of 6000 bps without any current-cap argument', function () {
        const legs = [{ to: 'creator', bps: 6000 }];
        const out  = util.applyProceedsSplit('TOK', '1000', 'seller', legs, 0);
        assert.deepStrictEqual(out.map(c => [c[0], String(c[1]), c[2]]), [
            ['TOK', '400', 'seller'],
            ['TOK', '600', 'creator']
        ]);
    });

    it('still conserves proceeds and fails closed above 10000 bps', function () {
        const over = util.applyProceedsSplit('TOK', '1000', 'seller', [{ to: 'a', bps: 10001 }], 0);
        assert.deepStrictEqual(over, [['TOK', '1000', 'seller']]);
    });

    it('settle handlers no longer read CONTROLLER_MAX_TAKE_BPS', function () {
        for (const f of ['order_match/settle.js', 'swap_match/settle.js', 'cross_settle/settle_leg.js']) {
            const src = fs.readFileSync(path.join(__dirname, '../../../src/actions', f), 'utf8');
            assert.ok(!src.includes('CONTROLLER_MAX_TAKE_BPS'), f);
        }
    });
});
