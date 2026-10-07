// SLASH action handler: the XANCPUB publisher-only pair rule, height-gated by
// SLASH_XANCPUB_PUBLISHER_PAIR.
// Part of the SLASH suite; see ../slash.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const path   = require('path');
const sinon  = require('sinon');
const eq    = require('../../../../../src/consensus/equivocation_header.js');
const { buried, params, data, useSlashHarness } = require('./helpers/slash_harness.js');

const GATE = 'SLASH_XANCPUB_PUBLISHER_PAIR';
const ROUND = 'XANCPUB|archive|regtest|7|100';
const content = (pub, amount) => ['XANCPUB', 'anchor_archive', '7', '100', pub, amount].join('|');
const PUB_A = 'aaaa'.repeat(16), PUB_B = 'bbbb'.repeat(16);

let indexer, ctx, handler, offender;
const bind = (h) => { ({ indexer, ctx, handler, offender } = h); };

function pair(contentA, contentB) {
    const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, ROUND, 0, contentA);
    const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, ROUND, 0, contentB);
    return params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey);
}
const gateStub = (on) => sinon.stub().callsFake(async (name) => name !== GATE || on);

describe('SLASH action handler: XANCPUB publisher-only pair @regression', function () {
    useSlashHarness(bind);

    it('resolves a publisher-only pair to a slashable slot once the gate is active', async function () {
        ctx.protocolChanges.isEnabled = gateStub(true);
        const d = data();
        await handler.parse(pair(content(PUB_A, '50'), content(PUB_B, '50')), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['oracle_publish', buried(100)]);
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
    });

    it('rejects a pair that differs beyond the publisher once the gate is active', async function () {
        ctx.protocolChanges.isEnabled = gateStub(true);
        const d = data();
        await handler.parse(pair(content(PUB_A, '50'), content(PUB_A, '51')), d, null);

        assert.ok(/differs beyond the publisher/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('rejects a pair with the same publisher once the gate is active', async function () {
        ctx.protocolChanges.isEnabled = gateStub(true);
        const d = data();
        await handler.parse(pair(content(PUB_A, '50') + '|x', content(PUB_A, '50') + '|y'), d, null);

        assert.ok(/differs beyond the publisher/.test(d['STATUS']), 'got ' + d['STATUS']);
    });

    it('keeps legacy handling below the gate: the snapshot block alone decides the slot', async function () {
        ctx.protocolChanges.isEnabled = gateStub(false);
        const d = data();
        await handler.parse(pair(content(PUB_A, '50'), content(PUB_A, '51')), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
    });

    it('registers the gate with mainnet and testnet unarmed and regtest genesis-active', function () {
        const PC = require(path.join('..', '..', '..', '..', '..', 'src', 'protocol_changes.js'));
        const row = new PC({ config: {}, util: {} }).changes[GATE];
        assert.ok(row, 'gate must be registered');
        assert.strictEqual(row.mainnet_time, PC.UNARMED);
        assert.strictEqual(row.testnet_time, PC.UNARMED);
        assert.strictEqual(row.mainnet_block, 0);
        assert.strictEqual(row.regtest_block, 0);
    });
    it('reads inactive on mainnet and testnet and active on regtest through isEnabled', async function () {
        const PC = require(path.join('..', '..', '..', '..', '..', 'src', 'protocol_changes.js'));
        const read = async (network, height) => {
            const pc = new PC({ config: { NETWORK: network }, util: {}, decoderDb: { getBlockTime: async () => 1900000000 } });
            return pc.isEnabled(GATE, height);
        };
        assert.strictEqual(await read('mainnet', 900000), false);
        assert.strictEqual(await read('testnet', 900000), false);
        assert.strictEqual(await read('regtest', 1), true);
    });
});
