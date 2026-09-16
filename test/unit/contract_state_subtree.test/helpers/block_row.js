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
 * test/unit/contract_state_subtree.test/helpers/block_row.js
 *
 * One block through the real gated path, shared by the arming-boundary parts
 * (contract_state_root_arming_boundary and contract_state_root_orphan_and_snapshot).
 * Each part used to carry its own copy inside its describe; hoisting it here keeps
 * every describe under the function-length limit without duplicating it.
 */
'use strict';

const M   = require('../../../../src/consensus/merkle.js');
const SC  = require('../../../../src/state_commitment/index.js');
const SUB = require('../../../../src/consensus/gates/state_subtree_gate.js');

const { CHAIN, NETWORK } = require('./fake_db');

// One block through the real gated path, returning what the row would store.
async function blockRow(db, height){
    const candidates    = await SC.reservedSubRootCandidates(db, CHAIN, NETWORK, height);
    const extraSubRoots = SUB.gateSubRoots(candidates, height, NETWORK, CHAIN);
    const column        = SC.extraSubRootColumn(extraSubRoots, 'contract_state_root');
    db.storeRoot(height, column);
    return { column, state_root: SC.assembleStateRoot(rootHex('bal'), rootHex('stk'), extraSubRoots) };
}
function rootHex(tag){ return M.toHex(M.sha256(Buffer.from(tag, 'utf8'))); }
const V1_STATE_ROOT = SC.assembleStateRoot(rootHex('bal'), rootHex('stk'), null);

module.exports = { blockRow, rootHex, V1_STATE_ROOT };
