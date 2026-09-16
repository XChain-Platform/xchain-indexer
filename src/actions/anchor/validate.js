/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * ANCHOR wire-shape validation: the positional fields and signature lists of
 * the archive head (v1), the bundle header, sections and publisher tail (v0),
 * and the continuation chunk fields (v2). Each helper takes the running error
 * and hands it back, so every parser in this directory keeps its
 * first-failure-wins order. Nothing here reads the database or verifies a
 * signature: that is quorum.js.
 *
 ********************************************************************/

const ALLOWED_CHAINS = ['BTC', 'LTC', 'DOGE'];

// A v0 section's fixed slots (CHAIN .. SIG_COUNT), ahead of its signature pairs.
const SECTION_FIXED_FIELDS = 13;

// ANCHOR v1: the archive head's positional fields onto `data`. Returns the slot
// the wrapper signature list starts at.
function readHeadFields(params, data){
    data['CHAIN']                   = String(params[1] || '').toUpperCase();
    data['NETWORK']                 = String(params[2] || '');
    data['BLOCK_INDEX_CHECKPOINTED']= params[3];
    data['BLOCK_HASH']              = String(params[4] || '').toLowerCase();
    data['LEDGER_HASH']             = String(params[5] || '').toLowerCase();
    data['ACTIONS_HASH']            = String(params[6] || '').toLowerCase();
    data['CONTRACT_HASH']           = String(params[7] || '').toLowerCase();
    data['CHECKPOINT_SEQ']          = params[8];
    data['SNAPSHOT_BLOCK']          = params[9];

    // Archive head only: the archive segment sits between SNAPSHOT_BLOCK and SIG_COUNT.
    data['MATCH_BATCH_SEQ'] = params[10];
    data['MATCH_COUNT']     = params[11];
    data['BATCH_CRC32']     = String(params[12] || '').toLowerCase();
    data['TOTAL_CHUNKS']    = params[13];
    data['ARCHIVE_B64']     = String(params[14] || '');
    let sigBase = 15;
    return sigBase;
}

// Structural validation of the archive head's fixed fields.
function validateHeadShape(config, data, error){
    if(!error && ALLOWED_CHAINS.indexOf(data['CHAIN']) === -1)
        error = 'invalid: CHAIN (unknown)';
    // Verify NETWORK is the one this node follows (a checkpoint cut for another network is not ours)
    if(!error && String(data['NETWORK']) !== String(config['NETWORK'] || ''))
        error = 'invalid: NETWORK (not this network)';
    // Verify the checkpointed height, the sequence number and the snapshot block are plain whole numbers
    if(!error && (!/^[0-9]+$/.test(String(data['BLOCK_INDEX_CHECKPOINTED'])) ||
                  !/^[0-9]+$/.test(String(data['CHECKPOINT_SEQ'])) ||
                  !/^[0-9]+$/.test(String(data['SNAPSHOT_BLOCK']))))
        error = 'invalid: BLOCK_INDEX / CHECKPOINT_SEQ / SNAPSHOT_BLOCK (format)';
    for(let f of ['BLOCK_HASH', 'LEDGER_HASH', 'ACTIONS_HASH', 'CONTRACT_HASH']){
        // Verify each committed hash is a 64-character lowercase hex digest
        if(!error && !/^[0-9a-f]{64}$/.test(String(data[f])))
            error = 'invalid: ' + f + ' (format)';
    }
    if(!error){
        if(!/^[0-9]+$/.test(String(data['MATCH_BATCH_SEQ'])) ||
           !/^[0-9]+$/.test(String(data['MATCH_COUNT'])) ||
           !/^[0-9]+$/.test(String(data['TOTAL_CHUNKS'])) || Number(data['TOTAL_CHUNKS']) < 1)
            error = 'invalid: MATCH_BATCH_SEQ / MATCH_COUNT / TOTAL_CHUNKS (format)';
        else if(!/^[0-9a-f]{8}$/.test(String(data['BATCH_CRC32'])))
            error = 'invalid: BATCH_CRC32 (format)';
        else if(!data['ARCHIVE_B64'] || !/^[0-9a-zA-Z_-]+$/.test(String(data['ARCHIVE_B64'])))
            error = 'invalid: ARCHIVE_B64 (format)';
    }
    return error;
}

// Parse the archive head's wrapper signature list. sigCount is returned because
// the publisher tail is located by it.
function parseHeadSigs(params, sigBase, error){
    let sigs = [];
    let sigCount = 0;
    if(!error){
        try {
            sigCount = parseInt(params[sigBase]);
            if(!Number.isFinite(sigCount) || sigCount < 1) throw new Error('SIG_COUNT');
            for(let i = 0; i < sigCount; i++){
                let pubkey = params[sigBase + 1 + 2 * i];
                let sig    = params[sigBase + 1 + 2 * i + 1];
                if(!pubkey || !sig)                       throw new Error('missing sig data at index ' + i);
                if(!/^[0-9a-fA-F]{64}$/.test(pubkey))     throw new Error('pubkey format at index ' + i);
                if(!/^[0-9a-fA-F]{128}$/.test(sig))       throw new Error('sig format at index ' + i);
                sigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
            }
        } catch(e){
            error = 'invalid: ' + e.message;
        }
    }
    return { error, sigs, sigCount };
}

// The publisher tail: PUBLISHER pubkey + the publisher-attestation sig list,
// appended AFTER the wrapper sig list (located by sigBase + 1 + 2*sigCount). It is
// ALWAYS present on an archive head, so a wire carrying version 1 without one fails
// here on 'PUBLISHER format' rather than parsing as some tail-less shape.
//
// ATTEST_SIG_COUNT 0 is LEGAL: it is what the hub emits when the attestation round
// did not reach quorum, and it is the same degraded shape the bundle leg already
// uses. A degraded round must not cost the federation its checkpoint, so the count
// rides at 0, publisher_attestations stores NULL, and the reward derivation
// simply finds no attestation to meet quorum with. Negative is still rejected: it
// is not a shape any signer produces.
function parseHeadPublisherTail(params, data, sigBase, sigCount, error, format){
    let publisherSigs = [];
    if(!error && format === 1){
        try {
            let pubBase = sigBase + 1 + 2 * sigCount;
            data['PUBLISHER'] = String(params[pubBase] || '').toLowerCase();
            if(!/^[0-9a-f]{64}$/.test(data['PUBLISHER'])) throw new Error('PUBLISHER format');
            let attestCount = parseInt(params[pubBase + 1]);
            if(!Number.isFinite(attestCount) || attestCount < 0) throw new Error('ATTEST_SIG_COUNT');
            for(let i = 0; i < attestCount; i++){
                let pubkey = params[pubBase + 2 + 2 * i];
                let sig    = params[pubBase + 2 + 2 * i + 1];
                if(!pubkey || !sig)                       throw new Error('missing attestation sig at index ' + i);
                if(!/^[0-9a-fA-F]{64}$/.test(pubkey))     throw new Error('attestation pubkey format at index ' + i);
                if(!/^[0-9a-fA-F]{128}$/.test(sig))       throw new Error('attestation sig format at index ' + i);
                publisherSigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
            }
        } catch(e){
            error = 'invalid: ' + e.message;
        }
    }
    return { error, publisherSigs };
}

// ANCHOR v0: the bundle header (NETWORK, the bundle SNAPSHOT_BLOCK, SECTION_COUNT).
function validateBundleHeader(config, params, data, error){
    data['NETWORK']        = String(params[1] || '');
    data['SNAPSHOT_BLOCK'] = params[2];
    data['SECTION_COUNT']  = params[3];

    // Verify NETWORK is the one this node follows (a bundle cut for another network is not ours)
    if(!error && String(data['NETWORK']) !== String(config['NETWORK'] || ''))
        error = 'invalid: NETWORK (not this network)';
    // Verify SNAPSHOT_BLOCK is a plain whole number
    if(!error && !/^[0-9]+$/.test(String(data['SNAPSHOT_BLOCK'])))
        error = 'invalid: SNAPSHOT_BLOCK (format)';
    // Verify SECTION_COUNT is a whole number of at least one (a bundle with no sections commits nothing)
    if(!error && (!/^[0-9]+$/.test(String(data['SECTION_COUNT'])) || Number(data['SECTION_COUNT']) < 1))
        error = 'invalid: SECTION_COUNT (format)';
    return error;
}

// One v0 section's fixed fields, read positionally from `cursor`.
function readSection(params, cursor, i, network){
    return {
        FORMAT:                    0,
        SECTION_INDEX:             i,
        NETWORK:                   network,
        CHAIN:                     String(params[cursor]     || '').toUpperCase(),
        BLOCK_INDEX_CHECKPOINTED:  params[cursor + 1],
        BLOCK_HASH:                String(params[cursor + 2] || '').toLowerCase(),
        LEDGER_HASH:               String(params[cursor + 3] || '').toLowerCase(),
        ACTIONS_HASH:              String(params[cursor + 4] || '').toLowerCase(),
        CONTRACT_HASH:             String(params[cursor + 5] || '').toLowerCase(),
        CHECKPOINT_SEQ:            params[cursor + 6],
        // The section's OWN snapshot block. The bundle header's is the MAX over
        // sections, and a lagging chain rides at its own; signatures were
        // produced over this one, so the canonical and the oracle_publish set
        // both resolve here rather than at the header's.
        SNAPSHOT_BLOCK:            params[cursor + 7],
        STATE_ROOT:                String(params[cursor + 8] || '').toLowerCase(),
        STATE_ROOT_VERSION:        params[cursor + 9],
        BLOCK_MERKLE_ROOT:         String(params[cursor + 10] || '').toLowerCase(),
        BLOCK_MERKLE_VERSION:      params[cursor + 11]
    };
}

// One v0 section's signature list, after its fixed fields. The error names the
// section; sigCount is returned so the walk can step past the pairs.
function parseSectionSigs(params, cursor, i){
    let sigCount = parseInt(params[cursor + 12]);
    if(!Number.isFinite(sigCount) || sigCount < 1)
        return { error: 'invalid: SECTION ' + i + ' SIG_COUNT' };
    let sigs = [], sigReason = null;
    for(let k = 0; k < sigCount; k++){
        let pubkey = params[cursor + SECTION_FIXED_FIELDS + 2 * k];
        let sig    = params[cursor + SECTION_FIXED_FIELDS + 2 * k + 1];
        if(!pubkey || !sig)                   { sigReason = 'missing sig data at index ' + k; break; }
        if(!/^[0-9a-fA-F]{64}$/.test(pubkey)) { sigReason = 'pubkey format at index ' + k;    break; }
        if(!/^[0-9a-fA-F]{128}$/.test(sig))   { sigReason = 'sig format at index ' + k;       break; }
        sigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
    }
    if(sigReason) return { error: 'invalid: SECTION ' + i + ' ' + sigReason };
    return { error: null, sigs, sigCount };
}

// The bundle publisher tail, at the cursor the section walk left behind.
function parseBundleTail(params, data, cursor, error){
    let publisherSigs = [];
    if(!error){
        try {
            data['PUBLISHER'] = String(params[cursor] || '').toLowerCase();
            if(!/^[0-9a-f]{64}$/.test(data['PUBLISHER'])) throw new Error('PUBLISHER format');
            let attestCount = parseInt(params[cursor + 1]);
            if(!Number.isFinite(attestCount) || attestCount < 1) throw new Error('ATTEST_SIG_COUNT');
            for(let i = 0; i < attestCount; i++){
                let pubkey = params[cursor + 2 + 2 * i];
                let sig    = params[cursor + 2 + 2 * i + 1];
                if(!pubkey || !sig)                       throw new Error('missing attestation sig at index ' + i);
                if(!/^[0-9a-fA-F]{64}$/.test(pubkey))     throw new Error('attestation pubkey format at index ' + i);
                if(!/^[0-9a-fA-F]{128}$/.test(sig))       throw new Error('attestation sig format at index ' + i);
                publisherSigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
            }
        } catch(e){
            error = 'invalid: ' + e.message;
        }
    }
    return { error, publisherSigs };
}

// Shape-check one v0 section's fixed fields. Returns the failure reason (which the
// caller prefixes with 'SECTION n ') or null when the section is well formed. Split
// out so the reason strings stay in one place and read the same as the archive leg's.
//
// `seenChains` is the set of chains earlier sections of the SAME bundle already
// claimed, which is why this is called in wire order and why the guard lives here
// rather than in a post-pass: the reason has to name the LATER section, the one that
// is the duplicate.
function sectionShapeReason(s, seenChains){
    if(ALLOWED_CHAINS.indexOf(s.CHAIN) === -1) return 'CHAIN (unknown)';
    // One chain, one section. The hub's selector groups by (chain, network) and
    // can only ever produce one row per chain per bundle, so a repeat is malformed or
    // forged. It must take the whole bundle down rather than be skipped, for the same
    // reason a stale section does (all-or-nothing): a second section for a chain is a SECOND
    // checkpoint claim under one publisher signature, and every per-chain reader
    // (idx_anchor_checkpoint, getanchoraction, the SDK's chain filter, the explorer's
    // per-chain table) resolves a checkpoint identity to a row without knowing a
    // sibling row contradicts it. Skipping the duplicate would also make the verdict
    // depend on which copy the parser happened to reach first.
    if(seenChains && seenChains.has(s.CHAIN)) return 'CHAIN (duplicate)';
    if(!/^[0-9]+$/.test(String(s.BLOCK_INDEX_CHECKPOINTED)) ||
       !/^[0-9]+$/.test(String(s.CHECKPOINT_SEQ)) ||
       !/^[0-9]+$/.test(String(s.SNAPSHOT_BLOCK)))
        return 'BLOCK_INDEX / CHECKPOINT_SEQ / SECTION_SNAPSHOT_BLOCK (format)';
    for(let f of ['BLOCK_HASH', 'LEDGER_HASH', 'ACTIONS_HASH', 'CONTRACT_HASH']){
        if(!/^[0-9a-f]{64}$/.test(String(s[f]))) return f + ' (format)';
    }
    // Roots are REQUIRED: a v0 bundle is root-bearing by construction, so a
    // rootless section is malformed rather than a legacy shape to tolerate.
    if(!/^[0-9a-f]{64}$/.test(String(s.STATE_ROOT)))        return 'STATE_ROOT (format)';
    if(!/^[0-9a-f]{64}$/.test(String(s.BLOCK_MERKLE_ROOT))) return 'BLOCK_MERKLE_ROOT (format)';
    if(!/^[0-9]+$/.test(String(s.STATE_ROOT_VERSION)) ||
       !/^[0-9]+$/.test(String(s.BLOCK_MERKLE_VERSION)))
        return 'STATE_ROOT_VERSION / BLOCK_MERKLE_VERSION (format)';
    return null;
}

// ANCHOR v2: the continuation chunk's fields onto `data`, shape-checked.
function validateChunkFields(params, data, error){
    data['MATCH_BATCH_SEQ'] = params[1];
    data['CHUNK_INDEX']     = params[2];
    data['TOTAL_CHUNKS']    = params[3];
    data['ARCHIVE_B64']     = String(params[4] || '');

    // Verify the batch number, the chunk number and the chunk total are plain whole numbers
    if(!error && (!/^[0-9]+$/.test(String(data['MATCH_BATCH_SEQ'])) ||
                  !/^[0-9]+$/.test(String(data['CHUNK_INDEX'])) ||
                  !/^[0-9]+$/.test(String(data['TOTAL_CHUNKS']))))
        error = 'invalid: MATCH_BATCH_SEQ / CHUNK_INDEX / TOTAL_CHUNKS (format)';
    // Verify CHUNK_INDEX names a real continuation slot (the v1 head carries segment 0, so chunks run from 1)
    if(!error && (Number(data['CHUNK_INDEX']) < 1 || Number(data['CHUNK_INDEX']) >= Number(data['TOTAL_CHUNKS'])))
        error = 'invalid: CHUNK_INDEX (out of range)';
    // Verify the chunk body is present and uses only URL-safe base64 characters
    if(!error && (!data['ARCHIVE_B64'] || !/^[0-9a-zA-Z_-]+$/.test(String(data['ARCHIVE_B64']))))
        error = 'invalid: ARCHIVE_B64_CHUNK (format)';
    return error;
}

module.exports = {
    SECTION_FIXED_FIELDS,
    readHeadFields, validateHeadShape, parseHeadSigs, parseHeadPublisherTail,
    validateBundleHeader, readSection, parseSectionSigs, parseBundleTail, sectionShapeReason,
    validateChunkFields
};
