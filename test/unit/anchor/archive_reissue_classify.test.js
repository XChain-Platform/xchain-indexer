'use strict';

const assert = require('assert');

const {
    ARCHIVE_REISSUE_RETRY_REASON,
    classifyArchiveReissue
} = require('../../../src/actions/anchor/archive/archive_reissue.js');

const INCOMING = { batch_crc32: 'deadbeef', match_count: 4 };

describe('classifyArchiveReissue()', function () {
    it('returns fresh for an empty, null or undefined stored set', function () {
        assert.strictEqual(classifyArchiveReissue([], INCOMING), 'fresh');
        assert.strictEqual(classifyArchiveReissue(null, INCOMING), 'fresh');
        assert.strictEqual(classifyArchiveReissue(undefined, INCOMING), 'fresh');
    });

    it('returns duplicate for an exact match, crc compared case-insensitively', function () {
        const stored = [{ batch_crc32: 'DEADBEEF', match_count: '4' }];
        assert.strictEqual(classifyArchiveReissue(stored, INCOMING), 'duplicate');
    });

    it('returns conflict for a differing crc under the same seq', function () {
        const stored = [{ batch_crc32: 'cafef00d', match_count: 4 }];
        assert.strictEqual(classifyArchiveReissue(stored, INCOMING), 'conflict');
    });

    it('returns conflict for a differing match_count under the same seq', function () {
        const stored = [{ batch_crc32: 'deadbeef', match_count: 5 }];
        assert.strictEqual(classifyArchiveReissue(stored, INCOMING), 'conflict');
    });

    it('returns duplicate when one stored row conflicts and another is identical', function () {
        const stored = [
            { batch_crc32: 'cafef00d', match_count: 4 },
            { batch_crc32: 'deadbeef', match_count: 4 }
        ];
        assert.strictEqual(classifyArchiveReissue(stored, INCOMING), 'duplicate');
    });

    it('never throws on a stored row missing a field, treating it as no match', function () {
        const stored = [{ batch_crc32: 'deadbeef' }, { match_count: 4 }, {}];
        assert.strictEqual(classifyArchiveReissue(stored, INCOMING), 'conflict');
    });
});

describe('ARCHIVE_REISSUE_RETRY_REASON', function () {
    it('matches the exported constant and names a retry', function () {
        assert.strictEqual(ARCHIVE_REISSUE_RETRY_REASON,
            'invalid: MATCH_BATCH_SEQ (retry; this publisher already holds an archive under this seq)');
        assert.match(ARCHIVE_REISSUE_RETRY_REASON, /retry/);
    });
});
