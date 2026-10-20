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
 * Every stall reason the block loop sets, read off a source text.
 *
 * The source-guard suites that judge stall reasons (the grace-field wiring and
 * the hold-ceiling classifier) must see every non-null `this.stallReason`
 * assignment, whatever form it takes: a string literal, a named constant, or a
 * prefix followed by `+` and prose. A form this reader cannot resolve THROWS,
 * so a new site is never silently outside the scan.
 */

'use strict';

// A non-null assignment; `===` comparisons and null clears are not sites.
const ASSIGNMENT = /this\.stallReason\s*=(?!=)(?!\s*null\b)\s*([^;]+);/g;

// Resolve a named constant to its one string value, from the declarations in the
// source and the caller's imported values; zero or several values is a refusal.
function resolveConstant(name, src, imported) {
    const values = new Set();
    const decl = new RegExp('\\bconst\\s+' + name + "\\s*=\\s*'([^']*)'\\s*;", 'g');
    for (const m of src.matchAll(decl)) values.add(m[1]);
    if (Object.prototype.hasOwnProperty.call(imported, name)) values.add(imported[name]);
    if (values.size !== 1)
        throw new Error('stall reason constant ' + name + ' resolves to ' + values.size +
            ' values (' + [...values].join(', ') + '); declare it once or pass its imported value');
    return [...values][0];
}

// Each site in source order as { reason, prefixed, index, end }. A prefixed site's
// reason is its prefix alone (for example 'parse_exception:'), since its tail is prose.
function stallReasonSites(src, imported = {}) {
    const sites = [];
    for (const m of src.matchAll(ASSIGNMENT)) {
        const rhs = m[1].trim();
        const head = /^(?:'([^']*)'|([A-Z][A-Z0-9_]*))\s*(\+[\s\S]*)?$/.exec(rhs);
        if (!head) throw new Error('unreadable stallReason assignment: ' + rhs);
        const value = head[1] !== undefined ? head[1] : resolveConstant(head[2], src, imported);
        const prefixed = head[3] !== undefined;
        sites.push({ reason: prefixed ? value.trim() : value, prefixed,
                     index: m.index, end: m.index + m[0].length });
    }
    return sites;
}

// Count the non-null assignments by a looser pattern than the reader uses, so a
// form the reader's pattern stops matching shows up as a count mismatch.
function countStallReasonAssignments(src) {
    const all = (src.match(/this\.stallReason\s*=[^=]/g) || []).length;
    const clears = (src.match(/this\.stallReason\s*=\s*null\b/g) || []).length;
    return all - clears;
}

module.exports = { stallReasonSites, countStallReasonAssignments };
