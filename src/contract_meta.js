/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The CONTRACT_META_REQUIRED grammar and verdict ladder.
 *
 * WHY THIS EXISTS
 * ---------------
 * A deployed contract is addressed only by C:<CHAIN>:<action_index>. From the
 * CONTRACT_META_REQUIRED flag day a contract must carry its own human-readable
 * identity in its exports:
 *
 *     module.exports = { meta: { name, description, version }, ... };
 *
 * The VM reports what it found (metaType / metaJson / metaError / metaOversize,
 * see xchain-vm CONTRACT_WRAPPER); EVERY verdict lives here, host-side, exactly
 * as the permissions and maxTakeBps verdicts already do. The verdict hashes into
 * the deploy status, so this file is consensus code: each string below is a
 * frozen token and the ladder order is part of the rule.
 *
 * The grammar deliberately avoids anything the host Node version can move under
 * it. No trim() (its whitespace table follows the engine's Unicode version, and
 * the tree pins only a Node major), no locale, no normalisation: a value that
 * does not conform is REJECTED, never repaired, so the bytes a node stores are
 * always the author's bytes. The banned set is the wallet's reviewed
 * CONTROLS / ZERO_WIDTH / BIDI_CONTROLS constants promoted into a consensus
 * rule, because a verdict-bearing grammar can only ever be tightened by another
 * flag day.
 ********************************************************************/

// Field caps, in UTF-8 BYTES (the unit every other size gate on the deploy path
// uses; see actions/deploy.js MAX_CODE_SIZE and the gas byte count).
const META_NAME_MAX_BYTES        = 64;
const META_DESCRIPTION_MAX_BYTES = 512;
const META_VERSION_MAX_BYTES     = 32;

// Total cap on JSON.stringify(meta), in UTF-16 code units. NOT enforced here: it
// is measured INSIDE the isolate (the host only ever sees the manifest report
// after JSON.parse, and the whole report is truncated before parsing, so a
// multi-megabyte meta would otherwise turn the report unparseable and skip every
// check). Declared here so the host and the wrapper name one number.
const META_JSON_MAX_CHARS = 4096;

// Frozen consensus tokens. Every one is written into contracts.status and hashed
// into contract_hash, so a byte of any string below is a consensus change.
const VERDICTS = Object.freeze({
    READ_FAILED: 'invalid: CONTRACT_MANIFEST (manifest read failed)',
    REQUIRED:    'invalid: CONTRACT_MANIFEST (meta required)',
    NOT_OBJECT:  'invalid: CONTRACT_MANIFEST (meta must be a plain object)',
    OVERSIZE:    'invalid: CONTRACT_MANIFEST (meta exceeds 4096 characters)',
    NAME:        'invalid: CONTRACT_MANIFEST (meta.name must be a string of 1..64 bytes, printable, trimmed)',
    DESCRIPTION: 'invalid: CONTRACT_MANIFEST (meta.description must be a string of 1..512 bytes, printable, trimmed)',
    VERSION:     'invalid: CONTRACT_MANIFEST (meta.version must be a string of 1..32 bytes, printable, trimmed)'
});

// Code points banned ANYWHERE in a meta text field. C0 controls and DEL/C1
// (invisible, terminal-hostile), zero-width joiners and the word joiner and BOM
// (a name that renders identically to another), and the bidi overrides and marks
// (a name that renders in an order its bytes do not have). U+000A is banned too
// and re-admitted only for description, which is the one field a line break can
// legitimately appear inside.
function isBannedCodePoint(cp, allowLf){
    if(cp === 0x0A)                     return !allowLf;
    if(cp <= 0x1F)                      return true;   // C0 controls
    if(cp >= 0x7F && cp <= 0x9F)        return true;   // DEL + C1 controls
    if(cp >= 0x200B && cp <= 0x200D)    return true;   // ZWSP, ZWNJ, ZWJ
    if(cp === 0x2060 || cp === 0xFEFF)  return true;   // word joiner, BOM/ZWNBSP
    if(cp === 0x200E || cp === 0x200F)  return true;   // LRM, RLM
    if(cp >= 0x202A && cp <= 0x202E)    return true;   // bidi embeddings/overrides
    if(cp >= 0x2066 && cp <= 0x2069)    return true;   // bidi isolates
    return false;
}

// "Trimmed" as an explicit code-point set rather than `s === s.trim()`: trim()
// resolves against the running engine's Unicode whitespace table, which moves
// between Node versions, and a consensus verdict cannot move with it.
function isEdgeCodePoint(cp, allowLf){
    if(cp === 0x20 || cp === 0xA0 || cp === 0x1680) return true;
    if(cp >= 0x2000 && cp <= 0x200A)                return true;
    if(cp === 0x2028 || cp === 0x2029)              return true;
    if(cp === 0x202F || cp === 0x205F)              return true;
    if(cp === 0x3000)                               return true;
    // description admits an interior LF but not a leading or trailing one.
    if(cp === 0x0A)                                 return allowLf;
    return false;
}

/**
 * The one text grammar, applied identically to name, description and version.
 *
 * @param   {*}       s         candidate value (anything; only a string can pass)
 * @param   {number}  maxBytes  inclusive UTF-8 byte cap
 * @param   {boolean} allowLf   admit U+000A in the interior (description only)
 * @returns {boolean}
 */
function isValidMetaText(s, maxBytes, allowLf){
    if(typeof s !== 'string')
        return false;

    // Unpaired surrogates re-encode as U+FFFD, so a lone surrogate would be
    // counted at a byte length it does not have AND would be refused by the
    // utf8mb4 column on write, wedging a strict node mid-block. Refuse it here,
    // where the verdict is deterministic. String.prototype.isWellFormed is Node
    // 20+; the tree pins Node 22 (.nvmrc, engines.node).
    if(!s.isWellFormed())
        return false;

    let bytes = Buffer.byteLength(s, 'utf8');
    if(bytes < 1 || bytes > maxBytes)
        return false;

    // Iterate CODE POINTS, not UTF-16 units, so an astral character is judged
    // once rather than as two surrogate halves.
    let points = Array.from(s);
    for(let ch of points){
        if(isBannedCodePoint(ch.codePointAt(0), allowLf))
            return false;
    }
    if(isEdgeCodePoint(points[0].codePointAt(0), allowLf))
        return false;
    if(isEdgeCodePoint(points[points.length - 1].codePointAt(0), allowLf))
        return false;

    return true;
}

/**
 * Walk the seven verdict rows of the spec strictly top to bottom, first failure
 * wins, and hand back the conforming value when there is one.
 *
 * Takes the RAW vm.readManifest() result and never throws: it is called on every
 * DEPLOY, including one whose module top level threw (success:false) or whose
 * report was unparseable (manifest:null), which are precisely the cases the old
 * `if(success && manifest)` guard let through unjudged.
 *
 * The caller decides what to DO with the verdict: below the flag day the error is
 * discarded and only the meta is kept (storage wants a conforming value whenever
 * there is one), at/after it the error becomes the deploy status.
 *
 * @param   {object|null} manifestRead  vm.readManifest() result, may be null
 * @returns {{ error: (string|null), meta: (null|{ name: string, description: string, version: (string|null), json: string }) }}
 */
function evaluateContractMeta(manifestRead){
    // Row 1: a module-level throw, a CPU/memory limit hit during the read, or a
    // report the host could not parse. This is the row that closes the bypass:
    // such a contract deploys 'valid' below the flag day and fails on its first
    // execute.
    if(!manifestRead || manifestRead.success !== true || !manifestRead.manifest)
        return { error: VERDICTS.READ_FAILED, meta: null };

    let m = manifestRead.manifest;

    // A manifest report from a VM that predates the meta fields carries no
    // metaType at all; that is the same observable as a contract with no meta.
    let metaType = (m.metaType === undefined || m.metaType === null) ? 'undefined' : m.metaType;

    // Row 2: no meta export.
    if(metaType === 'undefined')
        return { error: VERDICTS.REQUIRED, meta: null };

    // Row 3: meta is not a plain object (null, array, function, primitive), or the
    // isolate could not serialise it (circular, BigInt, throwing getter/toJSON) or
    // it serialised to a non-object (Date, boxed String).
    if(metaType !== 'object' || m.metaError === true)
        return { error: VERDICTS.NOT_OBJECT, meta: null };

    // Row 4: serialised, but over the isolate's total cap.
    if(m.metaOversize === true)
        return { error: VERDICTS.OVERSIZE, meta: null };

    // The host parses the reported JSON itself and re-checks plain-object-ness
    // rather than trusting metaType: metaType describes the isolate's value, and
    // the bytes stored and validated below are what actually crossed the boundary.
    let parsed = null;
    if(typeof m.metaJson === 'string'){
        try { parsed = JSON.parse(m.metaJson); } catch(e) { parsed = null; }
    }
    if(parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return { error: VERDICTS.NOT_OBJECT, meta: null };

    // Row 5.
    if(!isValidMetaText(parsed.name, META_NAME_MAX_BYTES, false))
        return { error: VERDICTS.NAME, meta: null };

    // Row 6. LF is admitted in the interior: a description is prose and may wrap.
    if(!isValidMetaText(parsed.description, META_DESCRIPTION_MAX_BYTES, true))
        return { error: VERDICTS.DESCRIPTION, meta: null };

    // Row 7: version is optional, but validated whenever the KEY is present, so
    // `version: ''` and `version: 3` are refused rather than silently dropped.
    let version = null;
    if(Object.prototype.hasOwnProperty.call(parsed, 'version')){
        if(!isValidMetaText(parsed.version, META_VERSION_MAX_BYTES, false))
            return { error: VERDICTS.VERSION, meta: null };
        version = parsed.version;
    }

    // json is the isolate's bytes verbatim: unknown keys ride along untouched, so
    // a display field can be added later without a reindex or a flag day.
    return {
        error: null,
        meta: {
            name:        parsed.name,
            description: parsed.description,
            version:     version,
            json:        m.metaJson
        }
    };
}

module.exports = {
    META_NAME_MAX_BYTES,
    META_DESCRIPTION_MAX_BYTES,
    META_VERSION_MAX_BYTES,
    META_JSON_MAX_CHARS,
    VERDICTS,
    isValidMetaText,
    evaluateContractMeta
};
