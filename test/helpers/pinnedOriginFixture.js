'use strict';

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
 * Load a fixture that is meant to be an IMMUTABLE ANCHOR, refusing it if the
 * bytes moved (#5404).
 *
 * Used by the two schema-parity suites for the origin copies of the pre-ledger
 * baselines. Those guards work by comparing today's baseline against a record of
 * what the shape used to be, so the record is only worth as much as its
 * immutability: an author who can silently edit the anchor can silently re-freeze
 * the baseline, which is the hole the guards exist to close.
 *
 * The sha256 lives in the CONSUMING test file, not here and not in the fixture, so
 * a legitimate re-anchor is a three-file edit (fixture + pin + the migration that
 * justifies it) that a reviewer cannot miss. This is a ratchet, not proof: nothing
 * stops a determined author from moving all three. It converts a silent `git add`
 * into a deliberate, visible act, and that is the whole claim.
 ********************************************************************/

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');

// Read a pinned anchor fixture and return its parsed JSON. Throws with the remedy
// spelled out when the file's sha256 no longer matches `pinnedSha256`.
function loadPinnedOriginFixture(filePath, pinnedSha256, consumerLabel) {
    const raw    = fs.readFileSync(filePath);
    const actual = crypto.createHash('sha256').update(raw).digest('hex');

    assert.strictEqual(actual, pinnedSha256,
        'The immutable anchor ' + filePath + ' has been edited: its sha256 is now ' + actual +
        ' but ' + consumerLabel + ' pins ' + pinnedSha256 + '.\n' +
        'This file records the ORIGINAL pre-ledger shapes and is what proves a later re-freeze of ' +
        'the live baseline was justified by a dated migration. Editing it to quiet a failing ' +
        'parity guard destroys that proof and re-opens the drift hole for every aged database.\n' +
        'If the anchor genuinely must move (a re-baseline the team decided on), update the pin in ' +
        'the same commit and say in the commit message which migration each moved entry converges ' +
        'through. Otherwise: git checkout the fixture and ship the migration instead.');

    return JSON.parse(raw.toString('utf8'));
}

module.exports = { loadPinnedOriginFixture };
