'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const { stubGate } = require('../../../helpers/gate_modules.js');
const {
    BS, makeKey, makeTransfer, snapshotSet, makeCtx, buildProof, captureConsole
} = require('../../bridge/bridge_settle.test/helpers/settle_fixtures.js');

const KEY = 'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION';

describe('bridge_settle: destination below its XCHAIN_BRIDGE_ACTIVATION sub-gate', function(){
    let gate;
    beforeEach(function(){ gate = stubGate(sinon, KEY, true); });
    afterEach(function(){ sinon.restore(); });

    function fixture(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row  = makeTransfer(keys, {});
        const made = makeCtx({
            coin: 'DOGE', validators: snapshotSet(keys), mirrorTransfers: [row],
            tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } }
        });
        made.ctx.proof = buildProof('100.00000000', 'XCHAIN');
        return { row, ...made };
    }

    it('applyBridgeTransfer defers a row below the gate and writes nothing', async function(){
        gate.returns(false);
        const { row, ctx, state } = fixture();
        const res = await BS.applyBridgeTransfer(row, ctx);
        assert.strictEqual(res.applied, false);
        assert.ok(/XCHAIN_BRIDGE_ACTIVATION/.test(res.reason));
        assert.strictEqual(state.credits.length, 0);
    });

    it('dueBridgeTransfers and the pass skip the row below the gate', async function(){
        gate.returns(false);
        const { ctx, state } = fixture();
        assert.deepStrictEqual(await BS.dueBridgeTransfers(ctx), []);
        let applied;
        await captureConsole(async () => { applied = await BS.processBridgeSettlePass(ctx); });
        assert.deepStrictEqual(applied.transfers, []);
        assert.strictEqual(state.credits.length, 0);
    });

    it('reads the gate on the destination coin at the block height', async function(){
        gate.returns(false);
        const { ctx } = fixture();
        await BS.dueBridgeTransfers(ctx);
        assert.ok(gate.calledWith(ctx.network, 'DOGE', ctx.blockIndex, null));
    });

    it('applies the same row once the gate is active', async function(){
        const { row, ctx, state } = fixture();
        assert.strictEqual((await BS.dueBridgeTransfers(ctx)).length, 1);
        let res;
        await captureConsole(async () => { res = await BS.applyBridgeTransfer(row, ctx); });
        assert.strictEqual(res.applied, true);
        assert.strictEqual(state.credits.length, 1);
    });
});
