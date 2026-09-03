/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The ATTEST response canonical, in both eras
 * (the ATTEST response-mirror design, §3.1).
 *
 * The legacy canonical is five fields concatenated with NO separator:
 *
 *     request_id || provider_id || sha256hex(body) || status || meta
 *
 * That is safe only because of an accident of ordering. request_id and the body
 * hash are fixed-width hex, provider_id and status are drawn from closed
 * vocabularies, and `meta` is free-form provider text - but `meta` is LAST, so
 * nothing follows it that its own bytes could be mistaken for.
 *
 * The mirror era appends `effective_time`, and appending anything after a
 * free-form trailing field is exactly what that accident was protecting.
 * Concatenated bare, `meta="X" effective=1234` and `meta="X1" effective=234`
 * produce identical bytes, so one honest quorum's signatures would validate
 * against two different effective times. The verifier does not parse the
 * canonical; it REBUILDS it from a row it does not trust, so a hub could pick
 * whichever of those readings it liked and move the block the callback fires at.
 * Not a fork (every node reads the same row and agrees), but a producer-chosen
 * shift in a value the whole point of the design is to take away from producers.
 *
 * Two things together make the encoding injective, and neither is sufficient
 * alone:
 *
 *   1. A '|' separator before the appended field.
 *   2. A CANONICAL INTEGER SPELLING requirement on effective_time: digits only,
 *      no sign, no leading zeros, no whitespace, no exponent. This is the same
 *      guard the cross-chain relay applies to its own signed integers
 *      (lib/canonical_int.js), and for the same reason: '0120' and '120' are one
 *      number and two byte strings, so a value that round-trips through
 *      Number() and back can strand a row nobody can re-derive.
 *
 * With both, `meta + '|' + effective` has exactly one reading: no alternative
 * split can put a '|' inside the digit run, and a longer digit run would have to
 * start with a digit that is really part of meta, which would leave the true
 * effective_time non-canonically spelled.
 *
 * ERA SELECTION IS THE CALLER'S JOB, and it is keyed on the REQUEST's own block
 * through attest_response_mirror_activation.js. Passing a null effectiveTime
 * yields the legacy string byte for byte, so a from-genesis replay of historical
 * blocks is unchanged. The two eras can never share a signature, because the
 * canonical they sign differs.
 *
 * The EQUIV header wrapper is deliberately NOT applied here. It is a per-repo
 * module with its own flag day, and both callers already wrap this string in it
 * when it is active; folding it in would give this twin two reasons to change.
 *
 * BYTE-TWIN of xchain-hub/src/attest_response_canonical.js. A one-sided edit
 * makes every mirror-era signature fail to verify, which presents as a dead
 * federation rather than as a missing feature, so the twin is test-pinned.
 *
 ********************************************************************/

'use strict';

// Separates the appended mirror-era field from the free-form `meta` that precedes
// it. Never appears between the five legacy fields: adding one there would change
// historical bytes.
const MIRROR_FIELD_SEPARATOR = '|';

// True when `v` is spelled the one way this canonical accepts: a non-negative
// integer in decimal, no sign, no leading zeros (except "0" itself), no
// whitespace, no exponent, no fractional part.
//
// Deliberately a STRING test, not a numeric one. Number('0120') === 120 is the
// coercion that hides the problem: two byte strings that a verifier rebuilding
// from a row cannot tell apart, one of which no honest signer produced.
function isCanonicalIntSpelling(v){
    if(typeof v === 'number') return Number.isInteger(v) && v >= 0;
    if(typeof v !== 'string') return false;
    return /^(0|[1-9][0-9]*)$/.test(v);
}

// Build the raw canonical string for an ATTEST response.
//
// `effectiveTime` null or undefined selects the LEGACY era and returns the
// historical five-field concatenation byte for byte. Any other value selects the
// mirror era and MUST be a canonical integer spelling; a value that is not throws
// rather than silently producing bytes no counterpart can rebuild. Throwing is
// the right failure here on both sides: a leader that cannot spell its own
// effective time must not propose, and a verifier handed an unspellable one must
// treat the row as unverifiable, which it does by skipping it.
function buildResponseCanonicalRaw(fields){
    let raw = String(fields.requestId)
            + String(fields.providerId)
            + String(fields.responseHash)
            + String(fields.status)
            + String(fields.meta || '');
    let et = fields.effectiveTime;
    if(et === null || et === undefined) return raw;
    if(!isCanonicalIntSpelling(et))
        throw new Error('attest response canonical: effective_time is not a canonical integer spelling: ' + JSON.stringify(et));
    return raw + MIRROR_FIELD_SEPARATOR + String(et);
}

module.exports = {
    MIRROR_FIELD_SEPARATOR,
    isCanonicalIntSpelling,
    buildResponseCanonicalRaw
};
