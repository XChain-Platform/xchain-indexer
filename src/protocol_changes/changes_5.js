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
 * Time table part 5 of 5: CONTROLLER_CUSTODY_GUARD.
 *
 * One row per protocol change, in registration order, as the argument list of
 * ProtocolChanges.addChange(name, version, mainnet_time, testnet_time,
 * regtest_time, mainnet_block, testnet_block, regtest_block).
 *
 ********************************************************************/

'use strict';

const {
    CONTROLLER_CUSTODY_GUARD_MAINNET_TIME,
    CONTROLLER_CUSTODY_GUARD_TESTNET_TIME,
} = require('./flag_times.js');
const { regtestTimeOverride } = require('./regtest_env.js');

module.exports = [
    ['CONTROLLER_CUSTODY_GUARD', '0.2.0', CONTROLLER_CUSTODY_GUARD_MAINNET_TIME,
        CONTROLLER_CUSTODY_GUARD_TESTNET_TIME,
        regtestTimeOverride('CONTROLLER_CUSTODY_GUARD_REGTEST_TIME'), 0, 0, 0],
];
