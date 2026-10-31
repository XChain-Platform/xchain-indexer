'use strict';

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Actions = require('../../../src/actions/index.js');
const Utility = require('../../../src/utility.js');
const probeVm = require('../../../src/actions/vote/callback_probe_vm.js');

function makeCtx(network){
    let util = new Utility();
    let calls = { latest: 0, begin: 0, rollback: 0, handler: 0, order: [] };
    return {
        util,
        config: Object.assign({}, util.config, { NETWORK: network || 'regtest', COIN: 'BTC' }),
        indexerDb: {
            getLatestBlockIndex: async () => { calls.latest++; calls.order.push('latest'); return 900; },
            getBlockTime:        async () => 1700000000,
            beginTransaction:    async () => { calls.begin++; calls.order.push('begin'); },
            rollbackTransaction: async () => { calls.rollback++; },
            currentTxEpoch:      () => 0,
            runInDryRunEpoch:    (epoch, fn) => fn(),
            getFeeRecord:        async () => null
        },
        processTransaction: async (tx) => {
            calls.handler++;
            let contract = String(tx.data).split('|')[14] || '0';
            return { STATUS: 'invalid: ' + util.guardInertContractProbeError(
                contract, 'as a VOTE binding-poll callback') };
        },
        calls
    };
}

function voteParams(version, contract){
    let params = new Array(14).fill('');
    params[0] = version;
    params[13] = contract;
    return params;
}

describe('public VOTE binding dry-run refusal', () => {
    it('answers a guard-inert VOTE v0 binding create as guard-inert without a transaction', async () => {
        let ctx = makeCtx();
        let out = await Actions.prototype.dryRunAction.call(ctx,
            { action: 'VOTE', params: voteParams('0', '77'), source: 'src', guardInert: true });
        assert.ok(out.status.startsWith('invalid: '));
        assert.ok(out.status.includes(ctx.util.guardInertContractProbeError(77, 'as a VOTE binding-poll callback')));
        assert.strictEqual(out.blockIndex, 900);
        assert.strictEqual(out.blockTime, 1700000000);
        assert.strictEqual(out.xchainFee, null);
        assert.strictEqual(out.nativeFeeOwed, null);
        assert.strictEqual(out.coinPaymentsOwed, null);
        assert.strictEqual(ctx.calls.handler, 1);
        assert.strictEqual(ctx.calls.rollback, ctx.calls.begin);
        assert.deepStrictEqual(ctx.calls.order.slice(0, 2), ['begin', 'latest']);
    });

    it('treats a lowercase action and an empty version as the same create', async () => {
        let ctx = makeCtx();
        let out = await Actions.prototype.dryRunAction.call(ctx,
            { action: ' vote ', params: voteParams('', '5'), source: 'src', guardInert: true });
        assert.ok(out.status.includes('contract 5'));
        assert.strictEqual(ctx.calls.handler, 1);
    });

    for(let [label, request] of [
        ['a signaling poll with no callback contract', { action: 'VOTE', params: voteParams('0', ''), guardInert: true }],
        ['a non-v0 VOTE', { action: 'VOTE', params: voteParams('2', '77'), guardInert: true }],
        ['another action', { action: 'SEND', params: voteParams('0', '77'), guardInert: true }],
        ['a request that is not guard-inert', { action: 'VOTE', params: voteParams('0', '77') }],
        ['a non-numeric callback contract', { action: 'VOTE', params: voteParams('0', 'abc'), guardInert: true }]
    ]){
        it('falls through to the real engine for ' + label, async () => {
            let ctx = makeCtx();
            await Actions.prototype.dryRunAction.call(ctx, Object.assign({ source: 'src' }, request));
            assert.ok(ctx.calls.begin > 0, 'engine was not entered');
            assert.strictEqual(ctx.calls.handler, 1);
        });
    }

    it('reads a quoted or decimal zero version as the same v0 create', async () => {
        for(let version of ['"0"', '0.0']){
            let ctx = makeCtx();
            let out = await Actions.prototype.dryRunAction.call(ctx,
                { action: 'VOTE', params: voteParams(version, '77'), source: 'src', guardInert: true });
            assert.ok(out.status.includes('contract 77'), version + ' must take the early refusal');
            assert.strictEqual(ctx.calls.handler, 1);
        }
    });

    it('falls through to the real engine below the usable-method gate', async () => {
        let ctx = makeCtx('mainnet');
        let out = await Actions.prototype.dryRunAction.call(ctx,
            { action: 'VOTE', params: voteParams('0', '77'), source: 'src', guardInert: true });
        assert.ok(ctx.calls.begin > 0, 'the launch check must run under the transaction mutex');
        assert.strictEqual(ctx.calls.handler, 0, 'the launch gate must answer before the handler');
        assert.match(out.status, /not admitted before mainnet launch/);
        assert.strictEqual(out.nativeFeeOwed, null);
        assert.strictEqual(out.coinPaymentsOwed, null);
    });

    it('builds the listing probe from the code alone so every callback method shares one probe text', () => {
        let a = probeVm.buildListingProbeCode('module.exports={a(){},b(){}};');
        assert.strictEqual(a, probeVm.buildListingProbeCode('module.exports={a(){},b(){}};'));
        assert.ok(!a.includes('"a"') && !a.includes('"b"'));
        assert.strictEqual(probeVm.listingVerdict({ metaJson: JSON.stringify({ callbackFns: ['a'] }) }, 'a'), true);
        assert.strictEqual(probeVm.listingVerdict({ metaJson: JSON.stringify({ callbackFns: ['a'] }) }, 'b'), false);
    });
});
