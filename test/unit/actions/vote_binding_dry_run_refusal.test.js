'use strict';

const assert = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Actions = require('../../../src/actions/index.js');
const Utility = require('../../../src/utility.js');
const probeVm = require('../../../src/actions/vote/callback_probe_vm.js');

function makeCtx(network){
    let calls = { latest: 0, begin: 0 };
    return {
        util: new Utility(),
        config: { NETWORK: network || 'regtest', COIN: 'BTC' },
        indexerDb: {
            getLatestBlockIndex: async () => { calls.latest++; return 900; },
            getBlockTime:        async () => 1700000000,
            beginTransaction:    async () => { calls.begin++; throw new Error('engine reached'); }
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
        assert.strictEqual(ctx.calls.begin, 0);
    });

    it('treats a lowercase action and an empty version as the same create', async () => {
        let ctx = makeCtx();
        let out = await Actions.prototype.dryRunAction.call(ctx,
            { action: ' vote ', params: voteParams('', '5'), source: 'src', guardInert: true });
        assert.ok(out.status.includes('contract 5'));
        assert.strictEqual(ctx.calls.begin, 0);
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
            await Actions.prototype.dryRunAction.call(ctx, Object.assign({ source: 'src' }, request)).catch(() => {});
            assert.ok(ctx.calls.begin > 0, 'engine was not entered');
        });
    }

    it('reads a quoted or decimal zero version as the same v0 create', async () => {
        for(let version of ['"0"', '0.0']){
            let ctx = makeCtx();
            let out = await Actions.prototype.dryRunAction.call(ctx,
                { action: 'VOTE', params: voteParams(version, '77'), source: 'src', guardInert: true });
            assert.ok(out.status.includes('contract 77'), version + ' must take the early refusal');
            assert.strictEqual(ctx.calls.begin, 0);
        }
    });

    it('falls through to the real engine below the usable-method gate', async () => {
        let ctx = makeCtx('mainnet');
        await Actions.prototype.dryRunAction.call(ctx,
            { action: 'VOTE', params: voteParams('0', '77'), source: 'src', guardInert: true }).catch(() => {});
        assert.ok(ctx.calls.begin > 0, 'below the gate the handler gives a verdict, so it must run');
    });

    it('builds the listing probe from the code alone so every callback method shares one probe text', () => {
        let a = probeVm.buildListingProbeCode('module.exports={a(){},b(){}};');
        assert.strictEqual(a, probeVm.buildListingProbeCode('module.exports={a(){},b(){}};'));
        assert.ok(!a.includes('"a"') && !a.includes('"b"'));
        assert.strictEqual(probeVm.listingVerdict({ metaJson: JSON.stringify({ callbackFns: ['a'] }) }, 'a'), true);
        assert.strictEqual(probeVm.listingVerdict({ metaJson: JSON.stringify({ callbackFns: ['a'] }) }, 'b'), false);
    });
});
