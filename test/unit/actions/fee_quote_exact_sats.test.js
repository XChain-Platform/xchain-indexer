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
        // Independent expectation: fee * 1 USD / 0.00000001 USD = 9007199254740993 BTC, times 1e8 sats.
        const expected = (9007199254740993n * 100000000n).toString();
        assert.strictEqual(expected, '900719925474099300000000');
        assert.strictEqual(q.requiredFeeSatsExact, expected);
        // The Number cannot carry it: deriving the string from the Number would differ.
        assert.ok(q.requiredFeeSats > Number.MAX_SAFE_INTEGER);
        assert.notStrictEqual(BigInt(q.requiredFeeSats).toString(), expected);
        assert.strictEqual(q.requiredFeeSats, Number(expected));
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

    it('oraclefeequote RPC keeps the exact digits a Number would lose', async function () {
        const { buildFeesRpc } = require('../../../src/api/rpc/fees.js');
        let util = makeUtil('BTC', FEE_DEST);
        // 9007199254740993.00000001 BTC = 900719925474099300000001 sats, not representable as a Number.
        util.quoteOracleFee = async () => ({ valid: true, expectedFee: '9007199254740993.00000001', belowDust: false });
        const db = {
            apiView(){ return this; },
            getLatestBlockIndex: async () => 100,
            getBlockTime: async () => 1000,
        };
        const rpc = buildFeesRpc({ indexer: { indexerDb: db, util, config: { COIN: 'BTC' } }, ENABLE_DRYRUN: false });
        const r = await rpc.oraclefeequote({ oracleAddress: 'oracle', giveTick: 'T', fiatCode: 'USD', blockTime: 1000 });
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.requiredFeeSatsExact, '900719925474099300000001');
        assert.strictEqual(r.requiredFeeSats, Number('900719925474099300000001'));
        assert.notStrictEqual(BigInt(r.requiredFeeSats).toString(), r.requiredFeeSatsExact);
    });
});
