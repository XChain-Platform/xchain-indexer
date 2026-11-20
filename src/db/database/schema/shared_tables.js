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
 **********************************************************************/

'use strict';

// The sibling sync service ships schema-equivalent definitions for these tables
// and may have created them before the indexer's first schema verification.
const SYNC_SHAREABLE_DECLARED_TABLES = Object.freeze([
    'state_tree_roots',
    'state_tree_nodes',
    'escrow_leaf_journal'
]);

module.exports = { SYNC_SHAREABLE_DECLARED_TABLES };
