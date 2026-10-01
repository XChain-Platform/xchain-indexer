'use strict';

const assert = require('assert');

const fixture = require('../../../fixtures/anchor_canonical_vectors.json').fixture;
const {
    archiveCanonicalSuffix,
    signsExtendedCanonical,
    extendSectionCanonicalBase,
} = require('../../../../src/actions/anchor/v3_canonical.js');

const SEP = String.fromCharCode(124);

function archiveFromFixture(value){
    return {
        WRAPPER_SECTION_INDEX: value.wrapper_section_index,
        MATCH_BATCH_SEQ: value.match_batch_seq,
        MATCH_COUNT: value.match_count,
        BATCH_CRC32: value.batch_crc32,
        TOTAL_CHUNKS: value.total_chunks,
    };
}

describe('ANCHOR v3 wrapper section canonical', function () {
    const archive = archiveFromFixture(fixture.bundle_v3);

    it('builds the archive suffix in canonical field order', function () {
        const expected = ['42', '17', '8665563e', '1']
            .map(value => SEP + value).join('');
        assert.strictEqual(archiveCanonicalSuffix(archive), expected);
    });

    it('embeds an upper-case batch CRC as lower-case', function () {
        const upper = Object.assign({}, archive, { BATCH_CRC32: 'ABCDEF01' });
        assert.strictEqual(archiveCanonicalSuffix(upper), SEP + '42' + SEP + '17' + SEP + 'abcdef01' + SEP + '1');
    });

    it('extends only the named wrapper section', function () {
        assert.strictEqual(signsExtendedCanonical(0, archive), true);
        assert.strictEqual(signsExtendedCanonical(1, archive), false);
        assert.strictEqual(signsExtendedCanonical(2, archive), false);
        assert.strictEqual(extendSectionCanonicalBase('section-0', 0, archive),
            'section-0' + archiveCanonicalSuffix(archive));
        assert.strictEqual(extendSectionCanonicalBase('section-1', 1, archive), 'section-1');
        assert.strictEqual(extendSectionCanonicalBase('section-2', 2, archive), 'section-2');
    });

    it('leaves every section unchanged when the fixture has no archive', function () {
        assert.strictEqual(fixture.bundle_v3_no_archive.archive_count, 0);
        for(const sectionIndex of [0, 1, 2]){
            const base = 'section-' + sectionIndex;
            assert.strictEqual(signsExtendedCanonical(sectionIndex, null), false);
            assert.strictEqual(extendSectionCanonicalBase(base, sectionIndex, null), base);
        }
    });

    it('accepts a string-typed wrapper section index', function () {
        const stringIndexArchive = Object.assign({}, archive, { WRAPPER_SECTION_INDEX: '0' });
        assert.strictEqual(signsExtendedCanonical(0, stringIndexArchive), true);
        assert.strictEqual(extendSectionCanonicalBase('section-0', 0, stringIndexArchive),
            'section-0' + archiveCanonicalSuffix(stringIndexArchive));
    });
});
