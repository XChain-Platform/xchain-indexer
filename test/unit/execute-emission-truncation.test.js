/**
 * Emission amount truncation (item 5346) @regression @tier1
 *
 * Contracts compute with 64-digit bignum precision, so an emitted action can carry an amount
 * with more fractional digits than its tick's decimals. Execute._truncateEmissionAmounts
 * normalizes every amount-bearing emission field to its tick's decimals BEFORE the emission is
 * validated/dispatched, using the SAME normalization the ledger applies
 * (createLedgerChangeRecord -> util.bcadd(amount, 0, decimals)). This keeps a contract's
 * over-precise output from being rejected by isValidAmountFormat (which would revert e.g.
 * every AMM swap) while keeping the stored action amount equal to the ledger row.
 *
 * Two guards live here:
 *   1. Coverage: every emittable action that carries an amount appears in
 *      EMISSION_AMOUNT_FIELDS (so a new emittable action cannot silently skip truncation).
 *   2. Behavior: amounts are normalized to the tick's decimals, byte-identically to bcadd.
 */
'use strict';

const assert  = require('assert');
// Utility loads a coin config in its constructor; set env before requiring it (mirrors
// utility.test.js). bcadd/isNull do not depend on the coin, so any valid coin works.
process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Execute = require('../../src/actions/execute.js');
const Utility = require('../../src/utility.js');

// Emittable actions that legitimately carry NO tick-denominated amount (kept explicit so the
// coverage test forces a deliberate classification when a new emittable action is added).
// COINPAY's amount is a native-coin value (validated as satoshis), not a tick amount.
const AMOUNTLESS_EMITTABLE = ['CALLBACK', 'XCALL', 'EXECUTE', 'BROADCAST', 'COINPAY',
    'FILE', 'LINK', 'LIST', 'MESSAGE', 'SWEEP'];

// The set of actions buildActionParams can emit, derived from its switch source so the test
// tracks the live code (mirrors the approach in emission_params.test.js).
function emittableActionsFromBuildParams(){
    const src = Execute.prototype.buildActionParams.toString();
    const cases = [...src.matchAll(/case\s+'([A-Z]+)'\s*:/g)].map(m => m[1]);
    return [...new Set(cases)];
}

describe('Emission amount truncation (item 5346) @regression @tier1', function(){

    describe('coverage: every amount-bearing emittable action is mapped', function(){
        const MAP = Execute.EMISSION_AMOUNT_FIELDS;
        const emittable = emittableActionsFromBuildParams();

        it('buildActionParams exposes at least the known emittable actions', function(){
            // sanity: regex actually found the switch labels
            assert.ok(emittable.includes('SEND') && emittable.includes('ORDER'),
                'could not parse buildActionParams case labels');
        });

        it('every emittable action is either amount-mapped or explicitly amountless', function(){
            for(const action of emittable){
                const classified = Object.prototype.hasOwnProperty.call(MAP, action)
                    || AMOUNTLESS_EMITTABLE.includes(action);
                assert.ok(classified,
                    `Emittable action ${action} is in buildActionParams but neither in ` +
                    `EMISSION_AMOUNT_FIELDS nor AMOUNTLESS_EMITTABLE. Classify it (add its ` +
                    `amount->tick fields to EMISSION_AMOUNT_FIELDS in execute.js, or add it to ` +
                    `AMOUNTLESS_EMITTABLE here) so emitted amounts cannot escape truncation.`);
            }
        });

        it('every mapped action is actually emittable (no stale map entries)', function(){
            for(const action of Object.keys(MAP))
                assert.ok(emittable.includes(action),
                    `EMISSION_AMOUNT_FIELDS has ${action} but buildActionParams cannot emit it`);
        });
    });

    describe('behavior: amounts normalized to tick decimals (== ledger bcadd)', function(){
        const util = new Utility();

        // Stub indexerDb: every tick resolves to a fixed id; decimals come from a table.
        function makeExecute(decimalsByTick){
            const indexerDb = {
                getTickerId: async (tick) => (tick in decimalsByTick ? 1 : null),
                getTokenDecimalPrecision: async (/*tickId*/) => decimalsByTick.__d,
            };
            return new Execute({ config:{}, decoderDb:{}, indexerDb, util, mapper:{} });
        }

        it('SEND quantity is rounded to the tick decimals, matching bcadd', async function(){
            const ex = makeExecute({ TKN:true, __d:8 });
            const params = { tick:'TKN', destination:'addr', quantity:'3.333333333333333' };
            await ex._truncateEmissionAmounts('SEND', params);
            assert.strictEqual(params.quantity, String(util.bcadd('3.333333333333333', 0, 8)));
            assert.strictEqual(params.quantity, '3.33333333');
        });

        it('non-divisible tick (decimals 0) collapses to an integer', async function(){
            const ex = makeExecute({ TKN:true, __d:0 });
            const params = { tick:'TKN', destination:'addr', quantity:'5.9999999' };
            await ex._truncateEmissionAmounts('SEND', params);
            assert.strictEqual(params.quantity, String(util.bcadd('5.9999999', 0, 0)));
        });

        it('ORDER normalizes give/get legs to their own tick decimals', async function(){
            // giveTick and getTick both resolve; both use the stubbed decimals (4 here).
            const ex = makeExecute({ A:true, B:true, __d:4 });
            const params = { giveTick:'A', giveAmount:'1.123456789', getTick:'B', getAmount:'2.987654321' };
            await ex._truncateEmissionAmounts('ORDER', params);
            assert.strictEqual(params.giveAmount, String(util.bcadd('1.123456789', 0, 4)));
            assert.strictEqual(params.getAmount,  String(util.bcadd('2.987654321', 0, 4)));
        });

        it('ISSUE uses its inline declared decimals (tick not in issues table yet)', async function(){
            const ex = makeExecute({ __d:99 }); // getTickerId would return null; declared path is used
            const params = { tick:'NEW', decimals:'2', maxSupply:'1000.12345', mintSupply:'10.999' };
            await ex._truncateEmissionAmounts('ISSUE', params);
            assert.strictEqual(params.maxSupply,  String(util.bcadd('1000.12345', 0, 2)));
            assert.strictEqual(params.mintSupply, String(util.bcadd('10.999', 0, 2)));
        });

        it('VOTE deposit and gasEscrow normalize to the fixed GAS tick decimals (gas:true path)', async function(){
            // VOTE v0 escrows are denominated in the chain's GAS tick (config GAS),
            // not a tick named by a param; the map resolves it via `gas: true`.
            const indexerDb = {
                getTickerId: async (tick) => (tick === 'XCHAIN' ? 1 : null),
                getTokenDecimalPrecision: async () => 8,
            };
            const ex = new Execute({ config:{ GAS:'XCHAIN' }, decoderDb:{}, indexerDb, util, mapper:{} });
            const params = { tick:'TKN', deposit:'1.234567891234', gasEscrow:'0.999999999' };
            await ex._truncateEmissionAmounts('VOTE', params);
            assert.strictEqual(params.deposit,   String(util.bcadd('1.234567891234', 0, 8)));
            assert.strictEqual(params.gasEscrow, String(util.bcadd('0.999999999', 0, 8)));
        });

        it('leaves a get-leg untouched when its tick is unknown locally (cross-chain)', async function(){
            // giveTick A is known; getTick FOREIGN is not (getTickerId -> null).
            const ex = makeExecute({ A:true, __d:8 });
            const params = { giveTick:'A', giveAmount:'1.123456789', getTick:'FOREIGN', getAmount:'9.999999999' };
            await ex._truncateEmissionAmounts('ORDER', params);
            assert.strictEqual(params.giveAmount, String(util.bcadd('1.123456789', 0, 8)));
            assert.strictEqual(params.getAmount, '9.999999999', 'foreign-tick leg must be left as-is');
        });

        it('skips null/empty amount fields', async function(){
            const ex = makeExecute({ TKN:true, __d:8 });
            const params = { tick:'TKN', destination:'addr', quantity:'' };
            await ex._truncateEmissionAmounts('SEND', params);
            assert.strictEqual(params.quantity, '');
        });

        it('is a no-op for amountless actions', async function(){
            const ex = makeExecute({ __d:8 });
            const params = { method:'foo' };
            const before = JSON.stringify(params);
            await ex._truncateEmissionAmounts('XCALL', params);
            assert.strictEqual(JSON.stringify(params), before);
        });
    });
});
