/*
 * test/unit/actions/wire_text_before_validation.test.js
 *
 * The raw bc* helpers (bcadd, bcsub, bcmul, bcdiv, bcmulfloor, bcmuldivfloor) hand their
 * arguments to mathjs.bignumber unchecked, which throws on text it cannot parse, and a throw in
 * a handler halts the block on every node. Each case here is wire text that reached one of
 * them before (or regardless of) the rule that refuses it; each must now settle as a refusal.
 */
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert      = require('assert');
const Utility     = require('../../../src/utility.js');
const voteSettle  = require('../../../src/actions/vote/settle.js');
const Dividend    = require('../../../src/actions/dividend/index.js');
const sendLegs    = require('../../../src/actions/send/legs.js');
const destroyLegs = require('../../../src/actions/destroy/legs.js');

const util = new Utility();

describe('wire text before validation: util.bcparses @regression @tier1', function(){
    it('answers exactly whether the raw helpers throw', function(){
        for(const v of ['abc', '1x', '1 ', '1e', '..1'])
            assert.throws(() => util.bcadd(v, 0, 8), 'premise: bcadd throws on ' + JSON.stringify(v));
        for(const v of ['abc', '1x', '1 ', '1e', '..1'])
            assert.strictEqual(util.bcparses(v), false, JSON.stringify(v));
        for(const v of ['1', '0.5', 'NaN', 'Infinity', '0x10', '0x1.8', '1e5', null, undefined, '', 3, util.bcnum('2')])
            assert.strictEqual(util.bcparses(v), true, JSON.stringify(v));
    });
});

describe('wire text before validation: VOTE v0 create refused before its DEPOSIT check @regression @tier1', function(){
    function handler(){
        const created = [];
        return {
            created,
            config: { GAS: 'XCHAIN' },
            util,
            mapper: { createMappings: async () => {} },
            indexerDb: { createPoll: async (d, o) => { created.push(o); } },
        };
    }
    for(const dep of ['abc', '1x']){
        it('a text DEPOSIT ' + JSON.stringify(dep) + ' on a refused create settles inert', async function(){
            const h = handler();
            const data = { TICK: 'GOVT', SOURCE: 'b', GAS_ESCROW: '0' };
            await voteSettle.settleCreatePoll.call(h, data, 'invalid: SOURCE (must hold TICK to create poll)', dep);
            assert.strictEqual(data.STATUS, 'invalid: SOURCE (must hold TICK to create poll)');
            assert.deepStrictEqual(h.created, [{ inert: true }]);
        });
    }
});

describe('wire text before validation: DIVIDEND recipients built before AMOUNT is judged @regression @tier1', function(){
    function dividend(){
        return new Dividend({ config: {}, decoderDb: {}, util, mapper: {},
            indexerDb: { getList: async () => [] } });
    }
    for(const amt of ['abc', '1x']){
        it('a text AMOUNT ' + JSON.stringify(amt) + ' gives no recipients instead of throwing', async function(){
            const rec = {};
            const out = await dividend().buildDividendRecipients({ AMOUNT: amt, SOURCE: 'a', BLOCK_INDEX: 3 }, { b: '10', c: '5' }, { DECIMALS: 8 }, rec);
            assert.deepStrictEqual(out, {});
            assert.strictEqual(String(rec.DEBIT), '0');
        });
    }
    it('a numeric AMOUNT still pays every holder', async function(){
        const rec = {};
        const out = await dividend().buildDividendRecipients({ AMOUNT: '0.5', SOURCE: 'a', BLOCK_INDEX: 3 }, { b: '10', c: '5' }, { DECIMALS: 8 }, rec);
        assert.deepStrictEqual(Object.keys(out).sort(), ['b', 'c']);
        assert.strictEqual(util.bcstr(rec.DEBIT), '7.5');
    });
});

describe('wire text before validation: SEND and DESTROY legs of an unknown TICK merged before the TICK is judged @regression @tier1', function(){
    const self = { config: { NETWORK: 'regtest' }, util, gatedTotalsByTickId: () => null };
    it('two SEND legs of an unknown tick to one destination merge at 0 decimals', function(){
        const out = sendLegs.consolidateSendLegs.call(self, [['ZZZQ', '1', 'dest', ''], ['ZZZQ', '1', 'dest', '']], { ZZZQ: false }, { BLOCK_TIME: 1 });
        assert.strictEqual(out.length, 1);
        assert.strictEqual(util.bcstr(out[0][1]), '2');
    });
    it('two DESTROY legs of an unknown tick merge at 0 decimals', function(){
        const out = destroyLegs.consolidateLegs.call(self, [['ZZZQ', '1', ''], ['ZZZQ', '1', '']], { ZZZQ: false }, { BLOCK_TIME: 1 });
        assert.strictEqual(out.length, 1);
        assert.strictEqual(util.bcstr(out[0][1]), '2');
    });
    it('a known tick still merges at its own decimals', function(){
        const out = sendLegs.consolidateSendLegs.call(self, [['T', '0.5', 'dest', ''], ['T', '0.25', 'dest', '']], { T: { DECIMALS: 8 } }, { BLOCK_TIME: 1 });
        assert.strictEqual(util.bcstr(out[0][1]), '0.75');
    });
});
