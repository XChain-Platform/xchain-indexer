'use strict';

const assert = require('assert');
const sinon = require('sinon');

const {
    ARCHIVE_REISSUE_RETRY_REASON
} = require('../../../src/actions/anchor/archive_reissue.js');
const {
    archiveReissueRefusal
} = require('../../../src/actions/anchor/archive_reissue_guard.js');

const INCOMING = {
    author: 'DPublisher',
    batchSeq: 7,
    batchCrc32: 'deadbeef',
    matchCount: 4
};

function stubDb(rows) {
    return { getArchiveHeadsByAuthorAndSeq: sinon.stub().resolves(rows) };
}

describe('archiveReissueRefusal()', function () {
    afterEach(function () { sinon.restore(); });

    it('returns null when no archive is stored', async function () {
        const db = stubDb([]);

        assert.strictEqual(await archiveReissueRefusal(db, INCOMING), null);
    });

    it('returns null for the same CRC and count regardless of CRC case', async function () {
        const db = stubDb([{ batch_crc32: 'DEADBEEF', match_count: 4 }]);

        assert.strictEqual(await archiveReissueRefusal(db, INCOMING), null);
    });

    it('returns the retry reason for a differing CRC', async function () {
        const db = stubDb([{ batch_crc32: 'cafef00d', match_count: 4 }]);

        assert.strictEqual(
            await archiveReissueRefusal(db, INCOMING),
            ARCHIVE_REISSUE_RETRY_REASON
        );
    });

    it('returns the retry reason for a differing count', async function () {
        const db = stubDb([{ batch_crc32: 'deadbeef', match_count: 5 }]);

        assert.strictEqual(
            await archiveReissueRefusal(db, INCOMING),
            ARCHIVE_REISSUE_RETRY_REASON
        );
    });

    it('reads the author and sequence exactly once', async function () {
        const db = stubDb([]);

        await archiveReissueRefusal(db, INCOMING);

        sinon.assert.calledOnceWithExactly(
            db.getArchiveHeadsByAuthorAndSeq,
            INCOMING.author,
            INCOMING.batchSeq
        );
    });

    it('does not read when the author is missing', async function () {
        const db = stubDb([]);

        assert.strictEqual(
            await archiveReissueRefusal(db, { ...INCOMING, author: '' }),
            null
        );
        sinon.assert.notCalled(db.getArchiveHeadsByAuthorAndSeq);
    });

    it('does not read when the sequence is negative', async function () {
        const db = stubDb([]);

        assert.strictEqual(
            await archiveReissueRefusal(db, { ...INCOMING, batchSeq: -1 }),
            null
        );
        sinon.assert.notCalled(db.getArchiveHeadsByAuthorAndSeq);
    });
});
