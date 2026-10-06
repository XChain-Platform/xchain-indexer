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
 * Time table part 5 of 5: controller policy and guard transaction boundaries,
 * and the XANCPUB publisher-pair slash rule.
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
    OWNER_WITHDRAW_OPT_IN_MAINNET_TIME,
    OWNER_WITHDRAW_OPT_IN_TESTNET_TIME,
} = require('./flag_times.js');
const { regtestTimeOverride } = require('./regtest_env.js');
const { UNARMED } = require('./core.js');

const CHANGES = [
    ['CONTROLLER_CUSTODY_GUARD', '0.2.0', CONTROLLER_CUSTODY_GUARD_MAINNET_TIME,
        CONTROLLER_CUSTODY_GUARD_TESTNET_TIME,
        regtestTimeOverride('CONTROLLER_CUSTODY_GUARD_REGTEST_TIME'), 0, 0, 0],

    // OWNER_WITHDRAW_OPT_IN: a contract deployed at/above the flag day refuses owner
    // WITHDRAW unless its meta declares ownerWithdraw: true (actions/withdraw.js).
    // Judged against the contract's DEPLOY block, so every contract deployed before it
    // keeps its owner's recovery path. Regtest is genesis-active unless a venue sets
    // OWNER_WITHDRAW_OPT_IN_REGTEST_TIME.
    ['OWNER_WITHDRAW_OPT_IN', '0.2.0', OWNER_WITHDRAW_OPT_IN_MAINNET_TIME,
        OWNER_WITHDRAW_OPT_IN_TESTNET_TIME,
        regtestTimeOverride('OWNER_WITHDRAW_OPT_IN_REGTEST_TIME'), 0, 0, 0],
    // SLASH_XANCPUB_PUBLISHER_PAIR: an XANCPUB equivocation proof is judged as a
    // publisher-only pair (slash/resolve_slot.js): the two contents agree on scope,
    // round reference, snapshot block and amount and differ in the attested publisher.
    // Below the flag the legacy rule reads the snapshot block alone. Judged by the
    // block that carries the SLASH. Mainnet and testnet are unarmed; regtest is
    // genesis-active.
    ['SLASH_XANCPUB_PUBLISHER_PAIR', '0.2.0', UNARMED, UNARMED, 0, 0, 0, 0],

    // Groups sibling guards on one native-action leg under an outer savepoint.
    // It follows the custody guard on testnet, stays inert on mainnet, and is
    // genesis-active on regtest so fresh test chains exercise the corrected rule.
    ['CONTROLLER_GUARD_LEG_SAVEPOINTS', '0.2.0', 9999999999,
        CONTROLLER_CUSTODY_GUARD_TESTNET_TIME, 0, 0, 0, 0],
];

module.exports = CHANGES;
