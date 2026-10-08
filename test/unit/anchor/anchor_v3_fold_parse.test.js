'use strict';

const assert = require('assert');
const sinon = require('sinon');
const zlib = require('zlib');

const { createBaseData } = require('../../fixtures/mocks.js');
const Anchor = require('../../../src/actions/anchor/index.js');
const gateRegistry = require('../../../src/consensus/gate_registry');
const ed25519 = require('../../../src/consensus/ed25519.js');
const swq = require('../../../src/consensus/stake_weighted_quorum.js');
const ar = require('../../../src/consensus/gates/anchor_reward_gate.js');
const { deriveFoldWrapper } = require(
    '../../../src/actions/anchor/anchor_action_query/archive_query.js');
const { v3Params, vectors } = require('../actions/anchor/anchor.test/helpers/anchor_v3_fixtures.js');
const { crc32Hex } = require('../actions/anchor/anchor.test/helpers/anchor_fixtures.js');
const { createMockIndexer } = require('../../fixtures/mocks.js');

const FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';
const PUBKEY_A = 'a'.repeat(64);

function fixture(){
    let indexer = createMockIndexer();
    indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'regtest' });
    let db = indexer.indexerDb;
    db.getValidatorsByCapability = sinon.stub().resolves([{ pubkey: PUBKEY_A, amount: '1' }]);
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
    sinon.stub(gateRegistry, 'activeAt').callThrough()
        .withArgs(FOLD_GATE).returns(true);
    return { indexer, handler: new Anchor(indexer) };
}

function rows(indexer){
    return indexer.indexerDb.createAnchorAction.getCalls().map(call => call.args[0]);
}

function validV3Params(){
    let params = v3Params();
    let archive = JSON.stringify({ matches: Array.from({ length: 17 }, (_, id) => ({ id })) });
    let crcIndex = params.indexOf(vectors.fixture.bundle_v3.batch_crc32);
    params[crcIndex] = crc32Hex(archive);
    params[crcIndex + 2] = zlib.gzipSync(Buffer.from(archive, 'utf8')).toString('base64url');
    return { params, crc: params[crcIndex] };
}

describe('ANCHOR v3 fold parse', function(){
    afterEach(function(){
        sinon.restore();
    });

    it('parses the frozen wire into chain rows and one archive row', async function(){
        const { indexer, handler } = fixture();
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });

        await handler.parse(validV3Params().params, data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.deepStrictEqual(rows(indexer).map(row => row.SECTION_INDEX), [0, 1, 2, 3]);
        assert.deepStrictEqual(rows(indexer).slice(0, 3).map(row => row.CHAIN),
            ['BTC', 'DOGE', 'LTC']);
        assert.strictEqual(rows(indexer)[3].CHAIN, null);
        assert.strictEqual(rows(indexer)[3].MATCH_BATCH_SEQ, '42');
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
        assert.ok(indexer.indexerDb.reconcileAnchorRewardWinner.notCalled);
    });

    it('extends only the wrapper section canonical with the archive fields', async function(){
        const { handler } = fixture();
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });
        const wire = validV3Params();

        await handler.parse(wire.params, data, null);

        const canonicals = ed25519.verify.getCalls().map(call => call.args[0]);
        const checkpointCanonicals = canonicals.filter(value => value.includes('XCHECKPOINT'));
        const wrapper = checkpointCanonicals.find(value => value.includes('XCHECKPOINT|BTC|'));
        assert.ok(wrapper.includes('|42|17|' + wire.crc + '|1'));
        assert.ok(checkpointCanonicals
            .filter(value => !value.includes('XCHECKPOINT|BTC|'))
            .every(value => !value.includes('|42|17|' + wire.crc + '|1')));
    });

    it('records v3 as invalid while the fold gate is inactive', async function(){
        const { indexer, handler } = fixture();
        gateRegistry.activeAt.withArgs(FOLD_GATE).returns(false);
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });

        await handler.parse(v3Params(), data, null);

        assert.strictEqual(data.STATUS, 'invalid: VERSION (unknown)');
        assert.ok(rows(indexer).every(row => row.STATUS === data.STATUS));
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });

    it('stores only chain rows when ARCHIVE_COUNT is zero', async function(){
        const { indexer, handler } = fixture();
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });

        await handler.parse(v3Params({ archive: false }), data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(rows(indexer).length, 3);
        assert.ok(rows(indexer).every(row => row.MATCH_BATCH_SEQ === null));
    });

    it('refuses an invalid archive count through the shared splitter', async function(){
        const { indexer, handler } = fixture();
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });

        await handler.parse(v3Params({ archiveCount: 2 }), data, null);

        assert.strictEqual(data.STATUS, 'invalid: ARCHIVE_COUNT');
        assert.ok(rows(indexer).every(row => row.STATUS === data.STATUS));
    });

    it('derives the folded archive wrapper from its copied signature bytes', function(){
        const signature = '[{"pubkey":"a","sig":"wrapper"}]';
        const archive = {
            action_index: 9, section_index: 3, version: 3, chain: null,
            match_batch_seq: 42, validator_signatures: signature
        };
        const wrapper = {
            action_index: 9, section_index: 0, version: 3, chain: 'BTC',
            network: 'regtest', block_index: 900000, checkpoint_seq: 42,
            snapshot_block: 100,
            validator_signatures: signature
        };

        assert.deepStrictEqual(deriveFoldWrapper([archive, wrapper], archive),
            Object.assign({}, archive, {
                chain: 'BTC', network: 'regtest', block_index: 900000,
                checkpoint_seq: 42, snapshot_block: 100
            }));
    });

    it('leaves the archive identity unresolved when wrapper bytes are ambiguous', function(){
        const signature = '[{"pubkey":"a","sig":"same"}]';
        const archive = {
            action_index: 9, version: 3, chain: null,
            match_batch_seq: 42, validator_signatures: signature
        };
        const chain = { action_index: 9, version: 3, chain: 'BTC',
            validator_signatures: signature };

        assert.strictEqual(deriveFoldWrapper([archive, chain, Object.assign({}, chain)], archive),
            archive);
    });
});
