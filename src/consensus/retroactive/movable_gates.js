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
 * Gates approved for an automatic retroactive replay.
 *
 *********************************************************************/

'use strict';

const MOVABLE_GATES = Object.freeze([]);
const HISTORY_PRESERVING_GATES = Object.freeze([
    'vm_token_info_legacy_window.VM_TOKEN_INFO_LEGACY_WINDOW_END',
]);

module.exports = { MOVABLE_GATES, HISTORY_PRESERVING_GATES };
