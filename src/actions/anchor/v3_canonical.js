'use strict';

const SEP = String.fromCharCode(124);

function archiveCanonicalSuffix(archive){
    return [archive.MATCH_BATCH_SEQ, archive.MATCH_COUNT, archive.BATCH_CRC32,
            archive.TOTAL_CHUNKS].map(value => SEP + String(value)).join('');
}

function signsExtendedCanonical(sectionIndex, archive){
    return archive != null &&
           Number(archive.WRAPPER_SECTION_INDEX) === Number(sectionIndex);
}

function extendSectionCanonicalBase(base, sectionIndex, archive){
    return signsExtendedCanonical(sectionIndex, archive)
        ? base + archiveCanonicalSuffix(archive)
        : base;
}

module.exports = {
    archiveCanonicalSuffix,
    signsExtendedCanonical,
    extendSectionCanonicalBase,
};
