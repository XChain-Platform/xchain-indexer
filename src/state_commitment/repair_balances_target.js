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
 ********************************************************************/

'use strict';

function requestedTipError(requested, actual){
    if(requested == null || Number(requested) === Number(actual)) return null;
    return 'repair only operates at the current tip ' + actual + '; --block ' + requested +
        (Number(requested) < Number(actual) ? ' is below it' : ' is above it');
}

function tipUnchanged(before, after){
    return Boolean(before && after &&
        Number(before.block_index) === Number(after.block_index) &&
        String(before.balances_root) === String(after.balances_root));
}

module.exports = { requestedTipError, tipUnchanged };
