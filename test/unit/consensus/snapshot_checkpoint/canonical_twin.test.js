'use strict';

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
 *********************************************************************/

// Capability snapshot proofs are verified here with src/consensus/snapshot_checkpoint/canonical.js,
// and the hub signs and finalizes them with its own byte-identical copy. A one-sided edit makes
// every indexer reject what the hub finalizes, so this guard compares the two copies byte for byte.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

const REPO_ROOT    = path.join(__dirname, '..', '..', '..', '..');
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(REPO_ROOT, '..');
const HUB_DIR      = process.env.XCHAIN_HUB_DIR || path.join(SIBLING_ROOT, 'xchain-hub');
const TWIN_PATH    = path.join('src', 'consensus', 'snapshot_checkpoint', 'canonical.js');

describe('snapshot checkpoint canonical twin', function () {
    it('indexer copy is byte-identical to the hub copy', function () {
        const checkout = siblingCheckout(__dirname, path.join(HUB_DIR, 'package.json'));
        if (!skipOrFail(this, checkout, 'the hub snapshot checkpoint checkout')) return;

        const twin = path.join(HUB_DIR, TWIN_PATH);
        const verdict = siblingCheckout(__dirname, twin);
        assert.strictEqual(verdict.usable, true,
            'xchain-hub is present but its snapshot checkpoint canonical twin is unavailable: '
            + verdict.reason);
        assert.ok(fs.readFileSync(path.join(REPO_ROOT, TWIN_PATH)).equals(fs.readFileSync(twin)),
            'src/consensus/snapshot_checkpoint/canonical.js differs from the hub copy; '
            + 'edit both copies together or the indexers reject checkpoints the hub finalizes.');
    });
});
