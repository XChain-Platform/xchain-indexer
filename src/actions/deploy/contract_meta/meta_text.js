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
 *
 * The CONTRACT_META_REQUIRED text grammar: the one rule a meta name,
 * description or version must meet. A part of actions/deploy/contract_meta.js,
 * whose verdict ladder applies it to each field and which re-exports
 * isValidMetaText as part of its public surface. Consensus code for the same
 * reason the ladder is: a value this grammar refuses becomes the deploy status.
 *
 ********************************************************************/

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

module.exports = { isValidMetaText };
