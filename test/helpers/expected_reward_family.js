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
 * The expected reward family of each publisher-carrying ANCHOR wire version.
 * The mapping is kept by hand from the protocol (only the archive reward type
 * string comes from src), so it is an independent oracle the BTC-side binding
 * parity suite checks REWARD_FAMILY_VERSIONS against. Nothing in production
 * calls it.
 *
 * `foldActive` only models whether a v1 archive head still names a family.
 * Production retires the fold-era archive reward only when BOTH the archive
 * fold-term gate and the fold gate are active (rowGatesActive in
 * anchor_reward_derive.js, archiveRowTerminated in anchor_proof_client.js);
 * that two-gate rule is tested on the real code in
 * test/unit/consensus/anchor_reward_derive/archive_fold_term.test.js.
 *
 ********************************************************************/

'use strict';

const { ARCHIVE_REWARD_TYPE } = require('../../src/actions/anchor/anchor_reward_key.js');

function rewardTypeFor(format, foldActive){
    const numericFormat = typeof format === 'number' ||
        (typeof format === 'string' && format.trim() !== '') ? Number(format) : NaN;
    if(numericFormat === 1) return foldActive ? null : ARCHIVE_REWARD_TYPE;
    if(numericFormat === 0 || numericFormat === 3) return 'anchor_bundle';
    return null;
}

module.exports = { rewardTypeFor };
