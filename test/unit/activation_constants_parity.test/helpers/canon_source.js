/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The canonical checkout the activation-gate parity suite compares against, shared by
 * test/unit/activation_constants_parity.test.js and its height-ordering part: the path,
 * the verdict on the checkout, the skip-or-throw decision, and the before-all hook every
 * block of the suite carries.
 *
 ********************************************************************/

'use strict';

const path = require('path');
const { siblingCheckout, siblingsRequired } = require('../../../helpers/sibling_checkout.js');

// The same absolute path the suite names in its titles: five levels up from this directory
// is the directory holding the sibling checkouts, as three levels up is from test/unit.
const CONSTANTS_PATH = path.resolve(__dirname, '../../../../../xchain-documentation/protocol/constants.js');

// Usable, not merely present: a lane symlink into a live main checkout is refused here,
// and every parity case below keys off this flag.
const canonVerdict = siblingCheckout(__dirname, CONSTANTS_PATH);
const canonExists = canonVerdict.usable;

// What this suite does about the canonical checkout, isolated from fs and from mocha's
// own skip machinery so both branches are directly assertable. The suite cannot delete a
// sibling repo to reach the absent branch, so the branch is tested here instead.
// `refusal` is the sibling verdict's reason, so a checkout refused as a lane symlink into a
// live main checkout says so instead of claiming the file is missing. Without it the message
// names the absent checkout path as before.
function resolveCanonSource(canonExists, requireSiblings, refusal) {
    if (canonExists) return { status: 'checked' };
    if (requireSiblings)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but ' +
            (refusal || 'canonical constants not found at ' + CONSTANTS_PATH));
    return { status: 'skipped', reason: refusal || 'documentation checkout absent at ' + CONSTANTS_PATH };
}

// The before-all hook of every block, and the body the single hook had when the suite was one
// describe. A strict run (XCHAIN_REQUIRE_SIBLINGS=1) on an absent or refused checkout throws here
// in every block rather than skipping; otherwise it hands back the canonical map, or null when the
// checkout is skipped and every parity case is pending.
function loadCanon() {
    if (resolveCanonSource(canonExists, siblingsRequired(), canonVerdict.reason).status !== 'checked') return null;
    return require(CONSTANTS_PATH);
}

module.exports = { CONSTANTS_PATH, canonVerdict, canonExists, resolveCanonSource, loadCanon };
