'use strict';

const assert = require('assert');
const sinon = require('sinon');

const gateRegistry = require('../../../src/consensus/gate_registry');
const { checkFoldArchiveReissue } = require('../../../src/actions/anchor/archive/archive_head.js');
const { ARCHIVE_REISSUE_RETRY_REASON } = require(
    '../../../src/actions/anchor/archive/archive_reissue.js');

const FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';
const SOURCE_AUTHOR_GATE = 'anchor_fold_reissue_source_author_activation.ANCHOR_FOLD_REISSUE_SOURCE_AUTHOR_ACTIVATION';
const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const PUBLISHER = 'a'.repeat(64);
const ARCHIVE = {
    MATCH_BATCH_SEQ: '7',
    BATCH_CRC32: 'deadbeef',
    MATCH_COUNT: '3',
};

function fixture(rows, sourceAuthorActive = true) {
    const getArchiveHeadsByAuthorAndSeq = sinon.stub().callsFake(async (author) =>
        author === SOURCE ? rows : []);
    const handler = {
        config: { NETWORK: 'regtest', COIN: 'DOGE' },
        indexerDb: { getArchiveHeadsByAuthorAndSeq },
    };
    const gate = sinon.stub(gateRegistry, 'activeAt').callThrough();
    gate.withArgs(FOLD_GATE).returns(true);
    gate.withArgs(SOURCE_AUTHOR_GATE).returns(sourceAuthorActive);
    return { handler, getArchiveHeadsByAuthorAndSeq };
}

async function check(rows, sourceAuthorActive = true) {
    const f = fixture(rows, sourceAuthorActive);
    const reason = await checkFoldArchiveReissue(f.handler, {
        BLOCK_INDEX: 100,
        SOURCE,
        PUBLISHER,
    }, ARCHIVE, null);
    return { ...f, reason };
}

describe('ANCHOR v3 fold reissue SOURCE author', function () {
    afterEach(function () { sinon.restore(); });

    it('rejects a conflicting archive found under the DOGE SOURCE address', async function () {
        const result = await check([{ batch_crc32: 'cafef00d', match_count: 3 }]);

        assert.strictEqual(result.reason, ARCHIVE_REISSUE_RETRY_REASON);
        sinon.assert.calledOnceWithExactly(result.getArchiveHeadsByAuthorAndSeq, SOURCE, 7);
    });

    it('accepts an exact duplicate found under the DOGE SOURCE address', async function () {
        const result = await check([{ batch_crc32: ARCHIVE.BATCH_CRC32, match_count: 3 }]);

        assert.strictEqual(result.reason, null);
        sinon.assert.calledOnceWithExactly(result.getArchiveHeadsByAuthorAndSeq, SOURCE, 7);
    });

    it('retains the publisher pubkey lookup before activation', async function () {
        const result = await check([], false);

        assert.strictEqual(result.reason, null);
        sinon.assert.calledOnceWithExactly(result.getArchiveHeadsByAuthorAndSeq, PUBLISHER, 7);
    });
});
