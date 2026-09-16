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
 * test/unit/contract_state_subtree.test/helpers/shadow_window.js
 *
 * Opens a contract_state_root shadow window (and optionally arms the slot) for
 * the duration of fn, then restores both maps. Shared by the shadow-compute
 * window parts (contract_state_root_incremental_equals and
 * contract_state_root_shadow_derivation), which used to carry it inside the
 * describe; hoisting it keeps each describe under the function-length limit.
 */
'use strict';

const SUB = require('../../../../src/state_subtree_activation.js');

const { CHAIN, NETWORK } = require('./fake_db');

// `await fn()`, not `return fn()`: without the await the finally below runs the
// instant fn returns its promise, so the maps are torn down before the async
// body reads them and every assertion silently runs against an inert gate.
async function shadowFrom(height, armedAt, fn){
    const sMap = SUB.STATE_SUBTREE_SHADOW.contract_state_root;
    const aMap = SUB.STATE_SUBTREE_ACTIVATION.contract_state_root;
    const k = CHAIN + ':' + NETWORK;
    // RESTORE, never delete: contract_state_root now carries a REAL armed
    // height, and deleting it here disarms the chain for every later test.
    const hadA = Object.prototype.hasOwnProperty.call(aMap, k), prevA = aMap[k];
    const hadS = Object.prototype.hasOwnProperty.call(sMap, k), prevS = sMap[k];
    sMap[k] = height;
    if(armedAt != null) aMap[k] = armedAt;
    try { return await fn(); } finally {
        if(hadS) sMap[k] = prevS; else delete sMap[k];
        if(hadA) aMap[k] = prevA; else delete aMap[k];
    }
}

module.exports = { shadowFrom };
