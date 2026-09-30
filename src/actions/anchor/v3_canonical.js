'use strict';

const SEP = String.fromCharCode(124);

// Embed the batch CRC32 lower-case; every ANCHOR archive canonical builder calls this.
function canonicalBatchCrc(crc){
    return String(crc).toLowerCase();
}

function archiveCanonicalSuffix(archive){
    return [String(archive.MATCH_BATCH_SEQ), String(archive.MATCH_COUNT), canonicalBatchCrc(archive.BATCH_CRC32),
            String(archive.TOTAL_CHUNKS)].map(value => SEP + value).join('');
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
    canonicalBatchCrc,
    archiveCanonicalSuffix,
    signsExtendedCanonical,
    extendSectionCanonicalBase,
};
