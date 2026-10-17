'use strict';

const assert = require('assert');
const sinon = require('sinon');
const zlib = require('zlib');

const { createBaseData, createMockIndexer } = require('../../fixtures/mocks.js');
const { stubActiveAt } = require('../../helpers/gate_modules.js');
const Anchor = require('../../../src/actions/anchor/index.js');
const ed25519 = require('../../../src/consensus/ed25519.js');
const swq = require('../../../src/consensus/stake_weighted_quorum.js');
const ar = require('../../../src/consensus/gates/anchor_reward_gate.js');
const ProtocolChanges = require('../../../src/protocol_changes.js');
const { v3Params, vectors } = require('../actions/anchor/anchor.test/helpers/anchor_v3_fixtures.js');
const { crc32Hex } = require('../actions/anchor/anchor.test/helpers/anchor_fixtures.js');

const FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';
const ANCHOR_GATE = 'anchor_activation.ANCHOR_ACTIVATION';
const PUBKEY = 'a'.repeat(64);

function validV3Params(network){
    const params = v3Params();
    const archive = JSON.stringify({ matches: Array.from({ length: 17 }, (_, id) => ({ id })) });
    const crcIndex = params.indexOf(vectors.fixture.bundle_v3.batch_crc32);
    params[1] = network;
    params[crcIndex] = crc32Hex(archive);
    params[crcIndex + 2] = zlib.gzipSync(Buffer.from(archive, 'utf8')).toString('base64url');
    return params;
}

function blockIndex(network){
    const activation = ProtocolChanges.copy(ANCHOR_GATE)[network];
    if(network === 'mainnet') return activation + 1;
    const fold = ProtocolChanges.copy(FOLD_GATE)['DOGE:testnet'];
    return Math.max(activation, fold) + 1;
}

function fixture(network){
    const indexer = createMockIndexer();
    indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: network });
    const db = indexer.indexerDb;
    db.getValidatorsByCapability = sinon.stub().resolves([{ pubkey: PUBKEY, amount: '1' }]);
    db.getMaxAnchorCheckpointSeq = sinon.stub().resolves(null);
    db.getArchiveReplayWatermarks = sinon.stub().resolves({ batchSeq: null, checkpointSeq: null });
    db.createAnchorAction = sinon.stub().resolves();
    db.getAnchorV1ByBatchSeq = sinon.stub().resolves(null);
    db.getAnchorChunks = sinon.stub().resolves([]);
    db.createValidatorReward = sinon.stub().resolves(true);
    db.reconcileAnchorRewardWinner = sinon.stub().resolves(1);
    sinon.stub(ed25519, 'verify').returns(true);
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    sinon.stub(ar, 'isAnchorRewardDeriveActive').returns(false);
    if(network === 'mainnet') stubActiveAt(sinon, FOLD_GATE, true);
    return { indexer, handler: new Anchor(indexer) };
}

describe('ANCHOR v3 checkpoint sequence binding below activation', function(){
    afterEach(function(){
        sinon.restore();
    });

    for(const network of ['mainnet', 'testnet']){
        it('keeps the frozen fold valid with all-row watermark reads on ' + network, async function(){
            const bundle = vectors.fixture.bundle_v3;
            assert.strictEqual(bundle.snapshot_block, 100);
            assert.deepStrictEqual(bundle.sections.map(section => section.checkpoint_seq), [42, 42, 42]);
            const { indexer, handler } = fixture(network);
            const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });
            data.BLOCK_INDEX = blockIndex(network);

            await handler.parse(validV3Params(network), data, null);

            assert.strictEqual(data.STATUS, 'valid');
            const checkpointCalls = indexer.indexerDb.getMaxAnchorCheckpointSeq.getCalls();
            assert.strictEqual(checkpointCalls.length, 3);
            assert.ok(checkpointCalls.every(call => call.args[1] === network && !call.args[2]));
            const watermarkCalls = indexer.indexerDb.getArchiveReplayWatermarks.getCalls();
            assert.strictEqual(watermarkCalls.length, 1);
            assert.ok(!watermarkCalls[0].args[1]);
        });
    }
});
