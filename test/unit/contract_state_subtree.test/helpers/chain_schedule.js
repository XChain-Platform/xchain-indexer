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
 * test/unit/contract_state_subtree.test/helpers/chain_schedule.js
 *
 * The block-by-block threading fixture the "incremental equals full build"
 * blocks share: a write schedule, a runner that lands each block's writes and
 * stores its resolved root, and the empty-schedule advance. Two parts carried
 * byte-identical copies inside their describes; hoisting the one copy here
 * keeps the describe that uses it under the function-length limit.
 */
'use strict';

const CST = require('../../../../src/consensus/contract_state_subtree.js');

const { CHAIN, NETWORK } = require('./fake_db');

// A block's writes land BEFORE its root is computed, and no later block's
// rows exist yet. That ordering is production's, and it is a real
// precondition rather than a fixture convenience: latestStateValue reads the
// newest row for a key with no as-of-height filter, so computing a
// historical block's root while later rows exist would read the future. The
// balances path (getNetBalance sums all credits/debits) has the identical
// property, and every caller of both satisfies it because roots are computed
// once, inside the block that produces them.
async function runChain(db, schedule, from, to){
    for(let h = from; h <= to; h++){
        for(const w of (schedule[h] || [])) db.write(h, w[0], w[1], w[2]);
        db.storeRoot(h, await CST.resolveContractStateRoot(db, db.smt(), CHAIN, NETWORK, h));
    }
    return db.roots.get(to).contract_state_root;
}

const SCHEDULE = {
    100: [[7, 'alpha', '"a1"'], [7, 'beta', '"b1"']],
    101: [[7, 'alpha', '"a2"'],                       // overwrite
          [8, 'alpha', '"other"']],                   // same key, different contract
    102: [[7, 'beta',  null]],                        // delete
    103: [[7, 'gamma', '']],                          // the defensive empty-string case
    104: [[8, 'alpha', '"other2"']]
};

async function advance(db, from, to){ return runChain(db, {}, from, to); }

module.exports = { runChain, SCHEDULE, advance };
