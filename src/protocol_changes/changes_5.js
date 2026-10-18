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
 * Time table part 5 of 5: controller policy and guard transaction boundaries, owner withdraw
 * opt-in, the stake snapshot slash window, the multiround XATTEST slash exemption and the
 * readonly accessor own-key rule, DISPENSER_REFILL, and the XANCPUB publisher-pair slash rule.
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
    READONLY_ACCESSOR_OWN_KEY_MAINNET_TIME,
    READONLY_ACCESSOR_OWN_KEY_TESTNET_TIME,
    APPLY_LENGTH_METER_MAINNET_TIME,
    APPLY_LENGTH_METER_TESTNET_TIME,
    GAS_CEILING_SUCCESS_MAINNET_TIME,
    GAS_CEILING_SUCCESS_TESTNET_TIME,
    STAKE_SNAPSHOT_DECIMAL_STRINGS_MAINNET_TIME,
    STAKE_SNAPSHOT_DECIMAL_STRINGS_TESTNET_TIME,
    ITER_SET_METER_MAINNET_TIME,
    ITER_SET_METER_TESTNET_TIME,
    DISPENSER_REFILL_MAINNET_TIME,
    DISPENSER_REFILL_TESTNET_TIME,
    STAKE_DELEGATED_SIGNING_KEY_MAINNET_TIME,
    STAKE_DELEGATED_SIGNING_KEY_TESTNET_TIME,
    EXACT_INTEGER_WIRE_FIELDS_MAINNET_TIME,
    EXACT_INTEGER_WIRE_FIELDS_TESTNET_TIME,
    SLASH_XANCPUB_PUBLISHER_PAIR_MAINNET_TIME,
    SLASH_XANCPUB_PUBLISHER_PAIR_TESTNET_TIME,
    STAKE_SNAPSHOT_SLASH_WINDOW_MAINNET_TIME,
    STAKE_SNAPSHOT_SLASH_WINDOW_TESTNET_TIME,
    DELEGATION_ROTATE_IN_WINDOW_MAINNET_TIME,
    DELEGATION_ROTATE_IN_WINDOW_TESTNET_TIME,
    SLASH_ATTEST_MULTIROUND_EXEMPT_MAINNET_TIME,
    SLASH_ATTEST_MULTIROUND_EXEMPT_TESTNET_TIME,
    HOST_CALL_BOUNDS_MAINNET_TIME,
    HOST_CALL_BOUNDS_TESTNET_TIME,
    PER_ELEMENT_METER_MAINNET_TIME,
    PER_ELEMENT_METER_TESTNET_TIME,
} = require('./flag_times.js');
const { regtestTimeOverride } = require('./regtest_env.js');
const { UNARMED } = require('./core.js');

// A set non-negative integer arms the row, including 0 (active from genesis); unset, empty or
// non-numeric stays UNARMED.
function exactIntegerWireRegtestTime() {
    const raw = String(process.env.EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME === undefined ? '' :
        process.env.EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME).trim();
    return /^\d+$/.test(raw) ? parseInt(raw, 10) : UNARMED;
}

const CHANGES = [
    // EXACT_INTEGER_WIRE_FIELDS: regtest stays unarmed unless a venue sets
    // EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME.
    ['EXACT_INTEGER_WIRE_FIELDS', '0.2.0', EXACT_INTEGER_WIRE_FIELDS_MAINNET_TIME, EXACT_INTEGER_WIRE_FIELDS_TESTNET_TIME,
        exactIntegerWireRegtestTime, 0, 0, 0],
    ['ITER_SET_METER','0.2.0', ITER_SET_METER_MAINNET_TIME,
        ITER_SET_METER_TESTNET_TIME, 0, 0, 0, 0],
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
    // block that carries the SLASH. Mainnet is unarmed, testnet is armed at the instant
    // in its row, and regtest is genesis-active.
    ['SLASH_XANCPUB_PUBLISHER_PAIR', '0.2.0', SLASH_XANCPUB_PUBLISHER_PAIR_MAINNET_TIME, SLASH_XANCPUB_PUBLISHER_PAIR_TESTNET_TIME, 0, 0, 0, 0],

    // STAKE_SNAPSHOT_SLASH_WINDOW: from the flag day the VM stake snapshot caps a (pubkey, tick)'s
    // mid-UNSTAKE contract_stakes rows at what its open contract_unstakes rows still hold, the
    // place SLASH debits during the activation delay (db/contracts/vm_stake_snapshot.js).
    // This rule and DELEGATION_ROTATE_IN_WINDOW below: mainnet is UNARMED, testnet is armed at
    // the instant in each row, and regtest is inert unless a venue sets the row's
    // *_REGTEST_TIME override.
    ['STAKE_SNAPSHOT_SLASH_WINDOW', '0.2.0', STAKE_SNAPSHOT_SLASH_WINDOW_MAINNET_TIME, STAKE_SNAPSHOT_SLASH_WINDOW_TESTNET_TIME,
        () => regtestTimeOverride('STAKE_SNAPSHOT_SLASH_WINDOW_REGTEST_TIME')() || UNARMED, 0, 0, 0],
    ['DELEGATION_ROTATE_IN_WINDOW', '0.2.0', DELEGATION_ROTATE_IN_WINDOW_MAINNET_TIME, DELEGATION_ROTATE_IN_WINDOW_TESTNET_TIME,
        () => regtestTimeOverride('DELEGATION_ROTATE_IN_WINDOW_REGTEST_TIME')() || UNARMED, 0, 0, 0],

    // SLASH_ATTEST_MULTIROUND_EXEMPT: an XATTEST base-leg pair is no longer slashable,
    // because honest retry rounds sign one EQUIV key with differing content
    // (slash/resolve_slot.js). Relay-leg equivocation stays slashable. Narrowing which
    // proofs burn a bond is a consensus acceptance rule, so it is gated. Mainnet is
    // unarmed until a release cut pins an instant, testnet is armed at the instant in its
    // row, and regtest is genesis-active.
    ['SLASH_ATTEST_MULTIROUND_EXEMPT', '0.2.0', SLASH_ATTEST_MULTIROUND_EXEMPT_MAINNET_TIME, SLASH_ATTEST_MULTIROUND_EXEMPT_TESTNET_TIME, 0, 0, 0, 0],

    // READONLY_ACCESSOR_OWN_KEY: mirrors xchain-vm's ACCESSOR_OWN_KEY_ACTIVATION (testnet and regtest
    // active from genesis, mainnet unarmed); a readonly accessor resolves a snapshot
    // key that names an inherited member as absent from the flag day on.
    ['READONLY_ACCESSOR_OWN_KEY', '0.2.0', READONLY_ACCESSOR_OWN_KEY_MAINNET_TIME,
        READONLY_ACCESSOR_OWN_KEY_TESTNET_TIME, 0, 0, 0, 0],
    ['APPLY_LENGTH_METER', '0.2.0', APPLY_LENGTH_METER_MAINNET_TIME,
        APPLY_LENGTH_METER_TESTNET_TIME, 0, 0, 0, 0],
    ['GAS_CEILING_SUCCESS', '0.2.0', GAS_CEILING_SUCCESS_MAINNET_TIME,
        GAS_CEILING_SUCCESS_TESTNET_TIME, 0, 0, 0, 0],
    // DISPENSER_REFILL: a refill that adds escrow consults the token's trade controller.
    // Unarmed on mainnet, armed on testnet at DISPENSER_REFILL_TESTNET_TIME, and
    // genesis-active on regtest unless a venue sets DISPENSER_REFILL_REGTEST_TIME.
    ['DISPENSER_REFILL', '0.2.0', DISPENSER_REFILL_MAINNET_TIME,
        DISPENSER_REFILL_TESTNET_TIME,
        regtestTimeOverride('DISPENSER_REFILL_REGTEST_TIME'), 0, 0, 0],

    ['STAKE_DELEGATED_SIGNING_KEY','0.2.0', STAKE_DELEGATED_SIGNING_KEY_MAINNET_TIME,
        STAKE_DELEGATED_SIGNING_KEY_TESTNET_TIME, 0, 0, 0, 0],

    // Groups sibling guards on one native-action leg under an outer savepoint.
    // It follows the custody guard on testnet, stays inert on mainnet, and is
    // genesis-active on regtest so fresh test chains exercise the corrected rule.
    ['CONTROLLER_GUARD_LEG_SAVEPOINTS', '0.2.0', UNARMED,
        CONTROLLER_CUSTODY_GUARD_TESTNET_TIME, 0, 0, 0, 0],
    // EMISSION_DEPTH_EXECUTE_ONLY: only an EXECUTE emission stamps the incremented CALL_DEPTH;
    // other emissions keep the emitter's depth. Unarmed on every network until a release cut pins an instant.
    ['EMISSION_DEPTH_EXECUTE_ONLY', '0.2.0', UNARMED, 1792303200, UNARMED, 0, 0, 0],
    ['STAKE_SNAPSHOT_DECIMAL_STRINGS','0.2.0', STAKE_SNAPSHOT_DECIMAL_STRINGS_MAINNET_TIME,
        STAKE_SNAPSHOT_DECIMAL_STRINGS_TESTNET_TIME, 0, 0, 0, 0],

    // ARCHIVE_REPLAY_WRAPPER_WATERMARK: the archive replay guard's checkpoint watermark also
    // reads the wrapper chain row of each v3 archive (db/anchors getArchiveReplayWatermarks).
    // A v3 archive head row carries no checkpoint_seq, so below the flag the watermark only
    // ever sees v1 heads. Judged by the block that carries the ANCHOR. Unarmed on every network.
    ['ARCHIVE_REPLAY_WRAPPER_WATERMARK', '0.2.0', UNARMED, 1792303200, UNARMED, 0, 0, 0],

    // LEGACY_ANCHOR_REWARD_PIN: below the flag the anchor reward mint ignores the legacy
    // pin list. At or above it, a reward tuple pinned in legacy_reward_pins.json is not
    // minted again. Judged by the BTC block that derives the reward. Unarmed on every network.
    ['LEGACY_ANCHOR_REWARD_PIN', '0.2.0', UNARMED, 1792303200, UNARMED, 0, 0, 0],

    // GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS: the controller-guard stake snapshot
    // (actions/execute/controller_guard.js) hands the VM decimal strings, as the primary
    // EXECUTE path does under STAKE_SNAPSHOT_DECIMAL_STRINGS. Unarmed on mainnet and
    // testnet; regtest is inert unless a venue sets GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS_REGTEST_TIME.
    ['GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS', '0.2.0', UNARMED, 1792303200,
        () => regtestTimeOverride('GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS_REGTEST_TIME')() || UNARMED, 0, 0, 0],

    // HOST_CALL_BOUNDS: mirrors xchain-vm HOST_CALL_BOUNDS_ACTIVATION, judged by block time. From the
    // instant on, an emission refused at the emission cap is not charged its reservation, prepay or
    // request fee, a value that contains itself throws a catchable TypeError instead of faulting
    // out_of_stack at the gas ceiling, and a host-call argument may nest as deep as a plain
    // JSON.stringify of it. Unarmed on mainnet and testnet; regtest is active from genesis.
    ['HOST_CALL_BOUNDS', '0.2.0', HOST_CALL_BOUNDS_MAINNET_TIME,
        HOST_CALL_BOUNDS_TESTNET_TIME, 0, 0, 0, 0],

    // PER_ELEMENT_METER: mirrors xchain-vm PER_ELEMENT_METER_ACTIVATION, judged by block time. From
    // the instant on, iterator-helper callbacks and yielded values, set algebra with a set-like
    // argument, String.raw segments and every key an object spread or rest copies are charged
    // per element. Unarmed on mainnet and testnet; regtest is active from genesis.
    ['PER_ELEMENT_METER', '0.2.0', PER_ELEMENT_METER_MAINNET_TIME,
        PER_ELEMENT_METER_TESTNET_TIME, 0, 0, 0, 0],

    // CALLBACK_ARGS_EXACT: an ATTEST, XCALL or binding VOTE callback runs with the argument
    // array its injector built, so a '|' inside a provider response, a callee return value or a
    // callback param stays inside its own argument. Below the flag the arguments are joined on
    // '|' and split again before the VM, which is how they ran before. Judged by the block that
    // injects the callback. Unarmed on mainnet and testnet; genesis-active on regtest unless a
    // venue sets CALLBACK_ARGS_EXACT_REGTEST_TIME.
    ['CALLBACK_ARGS_EXACT', '0.2.0', UNARMED, 1792303200,
        regtestTimeOverride('CALLBACK_ARGS_EXACT_REGTEST_TIME'), 0, 0, 0],
];

module.exports = CHANGES;
