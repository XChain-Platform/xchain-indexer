'use strict';

const assert = require('assert');
const zlib = require('zlib');

const Anchor = require('../../../../../src/actions/anchor/index.js');
const { foldArchiveReason } = require('../../../../../src/actions/anchor/v3/v3_archive_check.js');

function fixtures(){
    const handler = new Anchor({ config: { NETWORK: 'regtest' } });
    const archiveB64 = zlib.gzipSync(Buffer.from(JSON.stringify({ matches: [{ id: 1 }, { id: 2 }] }), 'utf8'))
        .toString('base64url');
    const archive = {
        WRAPPER_SECTION_INDEX: '0',
        MATCH_BATCH_SEQ: '7',
        MATCH_COUNT: '2',
        BATCH_CRC32: handler.archiveCrc(archiveB64),
        TOTAL_CHUNKS: '1',
        ARCHIVE_B64: archiveB64
    };
    return { handler, archive, data: { BLOCK_INDEX: 100 } };
}

describe('ANCHOR v3 archive check', function () {
    it('accepts a valid single-body archive', function () {
        const { handler, archive, data } = fixtures();

        assert.strictEqual(foldArchiveReason(handler, archive, data), null);
    });

    it('returns the v1 reason for a body CRC mismatch', function () {
        const { handler, archive, data } = fixtures();
        archive.BATCH_CRC32 = archive.BATCH_CRC32 === '00000000' ? 'ffffffff' : '00000000';

        assert.strictEqual(foldArchiveReason(handler, archive, data),
            'invalid: BATCH_CRC32 (archive mismatch)');
    });

    it('rejects an upper-case batch CRC on format before any CRC compare', function () {
        const { handler, archive, data } = fixtures();
        archive.BATCH_CRC32 = 'ABCDEF01';

        assert.strictEqual(foldArchiveReason(handler, archive, data), 'invalid: BATCH_CRC32 (format)');
    });

    it('returns the v1 reason for a non-numeric batch sequence', function () {
        const { handler, archive, data } = fixtures();
        archive.MATCH_BATCH_SEQ = 'not-a-number';

        assert.strictEqual(foldArchiveReason(handler, archive, data),
            'invalid: MATCH_BATCH_SEQ / MATCH_COUNT / TOTAL_CHUNKS (format)');
    });

    it('accepts a missing archive', function () {
        const { handler, data } = fixtures();

        assert.strictEqual(foldArchiveReason(handler, null, data), null);
    });

    it('defers a chunked archive CRC mismatch to reassembly', function () {
        const { handler, archive, data } = fixtures();
        archive.TOTAL_CHUNKS = '2';
        archive.BATCH_CRC32 = archive.BATCH_CRC32 === '00000000' ? 'ffffffff' : '00000000';

        assert.strictEqual(foldArchiveReason(handler, archive, data), null);
    });
});
