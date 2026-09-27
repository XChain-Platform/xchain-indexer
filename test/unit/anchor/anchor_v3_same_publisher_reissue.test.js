'use strict';

const assert = require('assert');
const sinon = require('sinon');
const zlib = require('zlib');

const { createBaseData, createMockIndexer } = require('../../fixtures/mocks.js');
const Anchor = require('../../../src/actions/anchor/index.js');
const gateRegistry = require('../../../src/consensus/gate_registry');
const ed25519 = require('../../../src/consensus/ed25519.js');
const swq = require('../../../src/consensus/stake_weighted_quorum.js');
const ar = require('../../../src/consensus/gates/anchor_reward_gate.js');
const { ARCHIVE_REISSUE_RETRY_REASON } = require(
    '../../../src/actions/anchor/archive_reissue.js');
const { v3Params, vectors } = require(
    '../actions/anchor/anchor.test/helpers/anchor_v3_fixtures.js');
const { crc32Hex } = require(
    '../actions/anchor/anchor.test/helpers/anchor_fixtures.js');

const FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';
const PUBKEY = 'a'.repeat(64);

function validWire(options = {}){
    let params = v3Params(options);
    if(options.archive === false) return { params, crc: null };
    let archive = JSON.stringify({ matches: Array.from({ length: 17 }, (_, id) => ({ id })) });
    let crcIndex = params.indexOf('9c4e1b22');
    params[crcIndex] = crc32Hex(archive);
    params[crcIndex + 2] = zlib.gzipSync(Buffer.from(archive, 'utf8')).toString('base64url');
    return { params, crc: params[crcIndex] };
}

function fixture(storedRows, foldActive = true){
    let indexer = createMockIndexer();
    indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'regtest' });
    let db = indexer.indexerDb;
    db.getValidatorsByCapability = sinon.stub().resolves([{ pubkey: PUBKEY, amount: '1' }]);
    db.getMaxAnchorCheckpointSeq = sinon.stub().resolves(null);
    db.getArchiveReplayWatermarks = sinon.stub().resolves({ batchSeq: null, checkpointSeq: null });
    db.getArchiveHeadsByAuthorAndSeq = sinon.stub().resolves(storedRows);
    db.createAnchorAction = sinon.stub().resolves();
    db.getAnchorV1ByBatchSeq = sinon.stub().resolves(null);
    db.getAnchorChunks = sinon.stub().resolves([]);
    db.createValidatorReward = sinon.stub().resolves(true);
    db.reconcileAnchorRewardWinner = sinon.stub().resolves(1);
    sinon.stub(ed25519, 'verify').returns(true);
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    sinon.stub(ar, 'isAnchorRewardDeriveActive').returns(false);
    sinon.stub(gateRegistry, 'activeAt').callThrough().withArgs(FOLD_GATE).returns(foldActive);
    return { indexer, handler: new Anchor(indexer) };
}

async function parseFold(handler, params){
    let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });
    await handler.parse(params, data, null);
    return data;
}

describe('ANCHOR v3 same-publisher archive re-issue', function(){
    afterEach(function(){ sinon.restore(); });

    it('rejects different content under the publisher sequence with a retry reason', async function(){
        const wire = validWire();
        const { indexer, handler } = fixture([{ batch_crc32: 'cafef00d', match_count: 17 }]);

        const data = await parseFold(handler, wire.params);

        assert.strictEqual(data.STATUS, ARCHIVE_REISSUE_RETRY_REASON);
        sinon.assert.calledOnceWithExactly(indexer.indexerDb.getArchiveHeadsByAuthorAndSeq,
            vectors.fixture.bundle_v3.publisher, Number(vectors.fixture.bundle_v3.match_batch_seq));
        assert.ok(indexer.indexerDb.createAnchorAction.getCalls()
            .every(call => call.args[0].STATUS === ARCHIVE_REISSUE_RETRY_REASON));
        sinon.assert.notCalled(indexer.indexerDb.createValidatorReward);
    });

    it('accepts identical content from the same publisher and sequence', async function(){
        const wire = validWire();
        const { indexer, handler } = fixture([{ batch_crc32: wire.crc, match_count: 17 }]);

        const data = await parseFold(handler, wire.params);

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.calledOnce(indexer.indexerDb.getArchiveHeadsByAuthorAndSeq);
    });

    it('does not query before fold activation', async function(){
        const wire = validWire();
        const { indexer, handler } = fixture([{ batch_crc32: 'cafef00d', match_count: 17 }], false);

        const data = await parseFold(handler, wire.params);

        assert.strictEqual(data.STATUS, 'invalid: ANCHOR v3 before fold activation');
        sinon.assert.notCalled(indexer.indexerDb.getArchiveHeadsByAuthorAndSeq);
    });

    it('does not query a fold without an archive section', async function(){
        const wire = validWire({ archive: false });
        const { indexer, handler } = fixture([]);

        const data = await parseFold(handler, wire.params);

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.notCalled(indexer.indexerDb.getArchiveHeadsByAuthorAndSeq);
    });
});
