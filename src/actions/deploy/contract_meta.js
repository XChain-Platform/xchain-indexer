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

// The text grammar every meta field must meet (contract_meta/meta_text.js): the banned
// code points, the explicit "trimmed" edge set and the byte-cap check the ladder
// below applies to name, description and version.
const { isValidMetaText } = require('./contract_meta/meta_text.js');

// Field caps, in UTF-8 BYTES (the unit every other size gate on the deploy path
// uses; see actions/deploy/index.js MAX_CODE_SIZE and the gas byte count).
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

    return evaluateMetaFields(parsed, m.metaJson);
}

/**
 * Rows 5 to 7 of the ladder: the three text fields of a meta the host has parsed and
 * found to be a plain object, first failure wins, then the conforming value.
 *
 * @param   {object} parsed    the host's own JSON.parse of the isolate's metaJson
 * @param   {string} metaJson  the isolate's bytes, stored verbatim as the meta json
 * @returns {{ error: (string|null), meta: (null|{ name: string, description: string, version: (string|null), json: string }) }}
 */
function evaluateMetaFields(parsed, metaJson){
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
            json:        metaJson
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
