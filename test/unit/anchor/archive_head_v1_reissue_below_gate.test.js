'use strict';

const assert = require('assert');
const sinon = require('sinon');
const zlib = require('zlib');

const { createBaseData } = require('../../fixtures/mocks.js');
const gateRegistry = require('../../../src/consensus/gate_registry');
const { ARCHIVE_REISSUE_RETRY_REASON } = require(
    '../../../src/actions/anchor/archive/archive_reissue.js');
const { v3Params, vectors } = require(
    '../actions/anchor/anchor.test/helpers/anchor_v3_fixtures.js');
const {
    armAnchor, disarmAnchor, v1Params, crc32Hex, ARCHIVE_JSON
} = require('../actions/anchor/anchor.test/helpers/anchor_fixtures.js');

const FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';
const SOURCE_AUTHOR_GATE = 'anchor_fold_reissue_source_author_activation.ANCHOR_FOLD_REISSUE_SOURCE_AUTHOR_ACTIVATION';

function foldWire(){
    let params = v3Params();
    let archive = JSON.stringify({ matches: Array.from({ length: 17 }, (_, id) => ({ id })) });
    let crcIndex = params.indexOf(vectors.fixture.bundle_v3.batch_crc32);
    params[crcIndex] = crc32Hex(archive);
    params[crcIndex + 2] = zlib.gzipSync(Buffer.from(archive, 'utf8')).toString('base64url');
    return params;
}

describe('ANCHOR archive head same-author re-issue below the fold gate @regression @tier3', function(){
    let armed;
    beforeEach(function(){ armed = armAnchor(); });
    afterEach(function(){ disarmAnchor(armed); });

    it('indexes a v1 head valid over a stored row with a different CRC and match count, without reading it', async function(){
        const db = armed.indexer.indexerDb;
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        db.getArchiveHeadsByAuthorAndSeq = sinon.stub().callsFake(async (author, batchSeq) => {
            assert.strictEqual(author, data.SOURCE);
            assert.strictEqual(batchSeq, 0);
            return [{ batch_crc32: 'cafef00d', match_count: 99 }];
        });

        await armed.handler.parse(v1Params(ARCHIVE_JSON), data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.notStrictEqual(data.STATUS, ARCHIVE_REISSUE_RETRY_REASON);
        sinon.assert.notCalled(db.getArchiveHeadsByAuthorAndSeq);
        sinon.assert.calledOnce(db.createAnchorAction);
        const row = db.createAnchorAction.firstCall.args[0];
        assert.strictEqual(row.STATUS, 'valid');
        assert.strictEqual(Number(row.MATCH_BATCH_SEQ), 0);
        assert.strictEqual(row.BATCH_CRC32, crc32Hex(ARCHIVE_JSON));
    });

    it('refuses a v3 fold in the same stored-row case with one read once the fold gate is active', async function(){
        const db = armed.indexer.indexerDb;
        db.getArchiveHeadsByAuthorAndSeq = sinon.stub().resolves([{ batch_crc32: 'cafef00d', match_count: 17 }]);
        const gate = sinon.stub(gateRegistry, 'activeAt').callThrough();
        gate.withArgs(FOLD_GATE).returns(true);
        gate.withArgs(SOURCE_AUTHOR_GATE).returns(false);
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });

        await armed.handler.parse(foldWire(), data, null);

        assert.strictEqual(data.STATUS, ARCHIVE_REISSUE_RETRY_REASON);
        sinon.assert.calledOnceWithExactly(db.getArchiveHeadsByAuthorAndSeq,
            vectors.fixture.bundle_v3.publisher, Number(vectors.fixture.bundle_v3.match_batch_seq));
    });
});
