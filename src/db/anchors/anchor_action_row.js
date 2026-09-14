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
 * XChain Indexer - Database helper: anchors / anchor_action_row
 *
 * The column coercion for one anchor_actions row: every value an ANCHOR wire carried,
 * bounded to what its column can store, in the order createAnchorAction binds them.
 * Required by db/anchors.js and not a mixin part, so it adds no prototype method.
 *
 ********************************************************************/

// EVERY bound value must be storable in its column, whatever the wire carried.
//
// anchor.js records a rejected wire rather than dropping it (a retired version below
// ANCHOR_ACTIVATION, an unknown version byte, a malformed field), and the row it hands
// over holds the RAW positional walk: on a pre-restart v5/v7 wire, or on a hostile v1,
// hashes and chain names sit in numeric slots and 64-char strings sit in 8-char columns.
// Coercing those with Number() gave NaN, which the mariadb driver serializes as the bare
// literal `NaN` ("Unknown column 'NaN' in 'VALUES'"), and an over-long string is refused
// outright ("Data too long for column"). Either way the INSERT failed on every retry
// and the block never parsed: a from-genesis replay of DOGE testnet looped forever at
// 67856088, the first legacy anchor (AT-T2, 2026-09-09), and one malformed permissionless
// ANCHOR could park a live DOGE indexer the same way. A field that does not fit its
// column is stored NULL; the row (version byte, status, mined height) is still recorded.
// anchor_actions is not consensus state, so this changes no hash, and a VALID row never
// reaches this path with an unstorable field because every format check bounds it first.
//
// Integer columns: integer-shaped only. "Finite" is not enough (a 64-digit hash coerces
// to 1e64, which BIGINT refuses just as loudly), and each column has its own ceiling.
const U8  = 255, U32 = 4294967295, U64 = Number.MAX_SAFE_INTEGER;
const intOrNull = (v, max) => {
    if(v == null) return null;
    let n;
    if(typeof v === 'number') n = v;
    else {
        let s = String(v).trim();
        if(!/^\d{1,16}$/.test(s)) return null;
        n = Number(s);
    }
    return (Number.isSafeInteger(n) && n >= 0 && n <= max) ? n : null;
};
// String columns: NULL when longer than the column (never truncated: a cut hash would be
// a plausible-looking lie, NULL says "unreadable" and the status says why).
const strOrNull = (v, max) => {
    if(v == null || v === '') return null;
    let s = String(v);
    return (s.length <= max) ? s : null;
};
// MEDIUMTEXT holds 16 MiB; a wire cannot approach that, but the bound is stated.
const TEXT = 16777215;

// The anchor_actions row for one ANCHOR section, every value coerced to its column.
// section_index is the second half of the row key; args lists the bound values in the
// column order the UPDATE SET and the INSERT in createAnchorAction both name, ending
// with the status and the DOGE height the row was mined at.
function anchorActionRow(data, status_id){
    let section_index = intOrNull(data['SECTION_INDEX'], U8);
    if(section_index === null) section_index = 0;
    // The dispatcher bounds the version byte to 0-255 or null; null (an unparseable byte)
    // has always stored as 0 alongside its 'invalid: VERSION (unknown)' status.
    let version = intOrNull(data['FORMAT'], U8);
    if(version === null) version = 0;
    // Publisher tail (#2486): carried by v0 and v1, NULL on v2. Mirrors validator_signatures
    // exactly: anchor.js pre-serializes the XANCPUB sig list to a JSON string (as it does
    // VALIDATOR_SIGNATURES = JSON.stringify(sigs)) before dispatch, so both are stored as-is.
    let publisher = strOrNull(data['PUBLISHER'], 64);
    let publisherAttestations = strOrNull(data['PUBLISHER_ATTESTATIONS'], TEXT);
    let args = [
        section_index,
        version,
        strOrNull(data['CHAIN'], 10),
        strOrNull(data['NETWORK'], 20),
        intOrNull(data['BLOCK_INDEX_CHECKPOINTED'], U64),
        strOrNull(data['BLOCK_HASH'], 64),
        strOrNull(data['LEDGER_HASH'], 64),
        strOrNull(data['ACTIONS_HASH'], 64),
        strOrNull(data['CONTRACT_HASH'], 64),
        intOrNull(data['CHECKPOINT_SEQ'], U64),
        intOrNull(data['SNAPSHOT_BLOCK'], U64),
        strOrNull(data['STATE_ROOT'], 64),
        intOrNull(data['STATE_ROOT_VERSION'], U8),
        strOrNull(data['BLOCK_MERKLE_ROOT'], 64),
        intOrNull(data['BLOCK_MERKLE_VERSION'], U8),
        intOrNull(data['MATCH_BATCH_SEQ'], U64),
        intOrNull(data['MATCH_COUNT'], U32),
        strOrNull(data['BATCH_CRC32'], 8),
        intOrNull(data['TOTAL_CHUNKS'], U32),
        intOrNull(data['CHUNK_INDEX'], U32),
        strOrNull(data['ARCHIVE_B64'], TEXT),
        strOrNull(data['VALIDATOR_SIGNATURES'], TEXT),
        // Publisher-attestation tail (#2486), written on v0 and v1. Both NULL on v2. anchor.js must set
        // data['PUBLISHER_ATTESTATIONS'] = JSON.stringify(publisherSigs) for the attestations
        // to flow (that one-line hand-off is owned in anchor.js).
        publisher,
        publisherAttestations,
        status_id,
        data['BLOCK_INDEX']
    ];
    return { section_index, args };
}

module.exports = { anchorActionRow };
