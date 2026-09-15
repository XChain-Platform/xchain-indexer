/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************/

// test/unit/consensus/consensus_rules_digest_twin_bytes.test/helpers/twin_bytes.js
//
// Pins and normalises the single declared byte-twin header exception.

'use strict';

const assert = require('assert');

// The ONLY line that may differ, enumerated as the full text of both sides
// rather than as a pattern. Each copy names the other repo here; a copy that
// names ITSELF, or names a third repo, or spells the line any other way, fails
// the enumeration below instead of being quietly normalised away.
const TWIN_HEADER_IN_MINE = ' * BYTE-TWIN of xchain-hub/src/consensus_rules_digest.js. The two copies';
const TWIN_HEADER_IN_HUB  = ' * BYTE-TWIN of xchain-indexer/src/consensus_rules_digest.js. The two copies';

// What both declared headers collapse to for the comparison. It is not a legal
// line of either file, so a copy cannot smuggle it in to widen the window.
const HEADER_SENTINEL = ' * BYTE-TWIN of <twin>/src/consensus_rules_digest.js. The two copies';

// The prefix that makes a line a twin declaration at all. Counting these is how
// the guard proves its normalisation window is exactly one line wide: a second
// declaration, anywhere, would be a line the comparison silently stopped
// covering.
const TWIN_HEADER_PREFIX = ' * BYTE-TWIN of ';

// Replace the one declared header with the sentinel, asserting on the way that
// it appears exactly once and reads exactly as expected. Everything the
// comparison then sees is untouched source.
function normalise(text, expectedHeader, label) {
    const lines = text.split('\n');
    const declared = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].startsWith(TWIN_HEADER_PREFIX)) declared.push(i);
    }
    assert.strictEqual(declared.length, 1,
        label + ' must carry exactly one BYTE-TWIN declaration, found ' + declared.length
        + '; the normalisation window is one line wide and this copy moved it');
    assert.strictEqual(lines[declared[0]], expectedHeader,
        label + ' twin header line ' + (declared[0] + 1) + ' is not the declared text.\n'
        + '  expected: ' + expectedHeader + '\n'
        + '  actual:   ' + lines[declared[0]]);
    assert.ok(!text.includes(HEADER_SENTINEL),
        label + ' already contains the comparison sentinel, which would hide a real difference');
    lines[declared[0]] = HEADER_SENTINEL;
    return lines.join('\n');
}

module.exports = { normalise, TWIN_HEADER_IN_MINE, TWIN_HEADER_IN_HUB, TWIN_HEADER_PREFIX };
