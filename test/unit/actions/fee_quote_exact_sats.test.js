// test/unit/actions/fee_quote_exact_sats.test.js
//
// requiredFeeSatsExact: decimal-string twin of the requiredFeeSats Number in fee quote answers.

const assert = require('assert');
const { FEE_DEST, makeUtil, makeDb, makeCtx, BTC_PRICES } = require('../fees/fee_quote.test/helpers/quote_ctx.js');
const Actions = require('../../../src/actions/index.js');
const { exemptFeeQuote } = require('../../../src/actions/actions_class/quote_answers.js');

describe('requiredFeeSatsExact', function () {
    it('priceFeeQuote emits the string beside the unchanged Number', async function () {
        let util = makeUtil('BTC', FEE_DEST);
        let { ctx } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
        let q = await ctx.priceFeeQuote.call(ctx, { blockIndex: 100, blockTime: 1000 }, '1.00000000', undefined);
        assert.strictEqual(q.requiredFeeSats, 2000);
        assert.strictEqual(q.requiredFeeSatsExact, '2000');
    });

    it('stays exact above Number.MAX_SAFE_INTEGER', async function () {
        let util = makeUtil('BTC', FEE_DEST);
        let { ctx } = makeCtx(util, makeDb({ prices: { 'XCHAIN/USD': '1.00000000', 'BTC/USD': '0.00000001' } }));
        let q = await ctx.priceFeeQuote.call(ctx, { blockIndex: 100, blockTime: 1000 }, '90071992.54740993', undefined);
        assert.strictEqual(typeof q.requiredFeeSatsExact, 'string');
        assert.ok(/^\d+$/.test(q.requiredFeeSatsExact));
        assert.strictEqual(q.requiredFeeSats, Number(q.requiredFeeSatsExact));
    });

    it('exempt answer carries zero in both forms', function () {
        let q = exemptFeeQuote({}, 'send');
        assert.strictEqual(q.requiredFeeSats, 0);
        assert.strictEqual(q.requiredFeeSatsExact, '0');
    });

    it('dry-run raw view mirrors the priced string', async function () {
        let util = makeUtil('BTC', FEE_DEST);
        let { ctx } = makeCtx(util, makeDb({ prices: BTC_PRICES }));
        ctx.computeFeeQuoteDryRun = Actions.prototype.computeFeeQuoteDryRun;
        let q = await ctx.computeFeeQuoteDryRun.call(ctx, { action: 'send', params: ['0', 'FOO', '1', 'dest'], source: 'src' });
        assert.strictEqual(q.feeSupported, true);
        assert.strictEqual(q.requiredFeeSats, 2000);
        assert.strictEqual(q.requiredFeeSatsExact, '2000');
    });
});
