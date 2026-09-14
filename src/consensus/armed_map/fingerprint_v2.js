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
 * Armed-map fingerprint v2 for the running process.
 *
 * Published beside v1 (src/armedMapFingerprint.js), never instead of it,
 * during the W1 window: v1 hashes carrier file bytes and names, v2 hashes the
 * armed VALUES this process resolved, row by row, through the explicit
 * manifest. A fleet tool compares v2 wherever every process publishes it and
 * falls back to v1 for a build that predates it.
 *
 * FAILURE IS NEVER A PLAUSIBLE HEX. If any row cannot be resolved (a carrier
 * failed to load, an export vanished, a value has a refused type) the result
 * is the literal UNREADABLE with the reason beside it. A fingerprint over the
 * rows that did load would be a well-formed 64-hex value that matches nothing
 * real, which is the digest's false-match mode on a checkout without
 * node_modules, and exactly what a fleet sweep must not be shown.
 *
 ********************************************************************/

'use strict';

const { fingerprint } = require('./canonical.js');
const { collectRows } = require('./manifest.js');

const UNREADABLE = 'UNREADABLE';

// Memoized per process, like v1: every row is a load-time value, so a second
// computation in the same process can only reproduce the first, and health is
// polled often enough that re-resolving 290 rows per call would be waste.
let cached = null;

/**
 * @returns {{hex: string, rows: Object<string, string>, count: number}
 *          |{hex: 'UNREADABLE', reason: string}}
 */
function computeArmedMapFingerprintV2() {
    if (cached) return cached;
    let result;
    try {
        const collected = collectRows();
        result = collected.ok
            ? fingerprint(collected.rows)
            : { hex: UNREADABLE, reason: collected.reason };
    } catch (e) {
        // A key-grammar or duplicate-key refusal from the canonicaliser lands
        // here; it is a manifest defect, and it poisons the value the same way.
        result = { hex: UNREADABLE, reason: e && e.message ? e.message : String(e) };
    }
    cached = result;
    return cached;
}

module.exports = { computeArmedMapFingerprintV2, UNREADABLE };
