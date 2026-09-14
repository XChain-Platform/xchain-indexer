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
 * XChain Indexer - Database mixin: stakes
 * 
 * The queries over the stakes table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
// The stakes mixin is cut into parts by behaviour under stakes/; this entry merges them
// back into the one method set db/index.js installs, at the position those methods held here.
const stakeRecords         = require('./stakes/stake_records.js');
const activeStake          = require('./stakes/active_stake.js');
const effectiveSetSql      = require('./stakes/effective_set_sql.js');
const capabilityMembership = require('./stakes/capability_membership.js');
const evictionSweep        = require('./stakes/eviction_sweep.js');
const capabilitySlash      = require('./stakes/capability_slash.js');
const creditSourceReads    = require('./stakes/credit_source_reads.js');

module.exports = {

    ...stakeRecords,
    ...activeStake,
    ...effectiveSetSql,
    ...capabilityMembership,
    ...evictionSweep,
    ...capabilitySlash,
    ...creditSourceReads,

};
