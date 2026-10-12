'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const { stubGate } = require('../../../helpers/gate_modules.js');
const {
    BS, makeKey, makeTransfer, snapshotSet, makeCtx, buildProof, captureConsole
} = require('../../bridge/bridge_settle.test/helpers/settle_fixtures.js');

const XCHAIN_KEY = 'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION';
const TOKEN_KEY = 'token_bridge_activation.TOKEN_BRIDGE_ACTIVATION';

describe('bridge_settle: destination below its format-specific bridge sub-gate', function(){
    let xchainGate;
    let tokenGate;
    beforeEach(function(){
        xchainGate = stubGate(sinon, XCHAIN_KEY, true);
        tokenGate = stubGate(sinon, TOKEN_KEY, true);
    });
    afterEach(function(){ sinon.restore(); });

    function fixture(overrides){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row  = makeTransfer(keys, overrides || {});
        const made = makeCtx({
            coin: 'DOGE', validators: snapshotSet(keys), mirrorTransfers: [row],
            tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } }
        });
        made.ctx.proof = buildProof('100.00000000', row.tick);
        return { row, ...made };
    }

    it('applyBridgeTransfer defers a v2 row below XCHAIN_BRIDGE_ACTIVATION and writes nothing', async function(){
        xchainGate.returns(false);
        const { row, ctx, state } = fixture();
        const res = await BS.applyBridgeTransfer(row, ctx);
        assert.strictEqual(res.applied, false);
        assert.ok(/XCHAIN_BRIDGE_ACTIVATION/.test(res.reason));
        assert.strictEqual(state.credits.length, 0);
    });

    it('dueBridgeTransfers and the pass skip a v2 row below XCHAIN_BRIDGE_ACTIVATION', async function(){
        xchainGate.returns(false);
        const { ctx, state } = fixture();
        assert.deepStrictEqual(await BS.dueBridgeTransfers(ctx), []);
        let applied;
        await captureConsole(async () => { applied = await BS.processBridgeSettlePass(ctx); });
        assert.deepStrictEqual(applied.transfers, []);
        assert.strictEqual(state.credits.length, 0);
    });

    it('reads the XCHAIN gate on the destination coin at the block height', async function(){
        xchainGate.returns(false);
        const { ctx } = fixture();
        await BS.dueBridgeTransfers(ctx);
        assert.ok(xchainGate.calledWith(ctx.network, 'DOGE', ctx.blockIndex, null));
    });

    it('applies the same v2 row once the XCHAIN gate is active', async function(){
        const { row, ctx, state } = fixture();
        assert.strictEqual((await BS.dueBridgeTransfers(ctx)).length, 1);
        let res;
        await captureConsole(async () => { res = await BS.applyBridgeTransfer(row, ctx); });
        assert.strictEqual(res.applied, true);
        assert.strictEqual(state.credits.length, 1);
    });

    it('defers a v5 row below TOKEN_BRIDGE_ACTIVATION while XCHAIN is active', async function(){
        tokenGate.returns(false);
        const { row, ctx, state } = fixture({ tick: 'PEPE' });
        const res = await BS.applyBridgeTransfer(row, ctx);
        assert.strictEqual(res.applied, false);
        assert.ok(/TOKEN_BRIDGE_ACTIVATION/.test(res.reason));
        assert.deepStrictEqual(await BS.dueBridgeTransfers(ctx), []);
        assert.strictEqual(state.credits.length, 0);
        assert.strictEqual(state.actions.length, 0);
        assert.strictEqual(state.settlements.length, 0);
        assert.ok(tokenGate.calledWith(ctx.network, 'DOGE', ctx.blockIndex, null));
    });

    it('does not use TOKEN_BRIDGE_ACTIVATION for a v2 row', async function(){
        tokenGate.returns(false);
        const { ctx } = fixture();
        assert.strictEqual((await BS.dueBridgeTransfers(ctx)).length, 1);
    });

    it('does not use XCHAIN_BRIDGE_ACTIVATION for a v5 row', async function(){
        xchainGate.returns(false);
        const { ctx } = fixture({ tick: 'PEPE' });
        assert.strictEqual((await BS.dueBridgeTransfers(ctx)).length, 1);
    });
});
