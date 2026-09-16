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
 *
 * ANCHOR_ACTIVATION: where the ANCHOR version set restarts at v0.
 *
 * Kept byte-identical to xchain-documentation/protocol/constants.js by
 * test/unit/activationConstantsParity.test.js. Keyed on the anchor's OWN
 * DOGE block_index (data['BLOCK_INDEX'] at parse time), the same key
 * archive_head_unverified_gate_activation.js uses, never on SNAPSHOT_BLOCK
 * or on the checkpointed height of another chain.
 *
 ********************************************************************/

'use strict';

const { get, copy, activeAt } = require('./consensus/gate_registry');

const ANCHOR_ACTIVATION = copy('anchor_activation.ANCHOR_ACTIVATION');

// Is an ANCHOR mined at DOGE height `blockIndex` on `network` at/above the v0
// activation? A non-numeric height or an unknown network fails closed (false):
// the action is then 'invalid: ANCHOR before activation', never silently admitted.
function isAnchorActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = ANCHOR_ACTIVATION[network];
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = { ANCHOR_ACTIVATION, isAnchorActive };
