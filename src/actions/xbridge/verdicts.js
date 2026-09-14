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
 * The XBRIDGE verdict strings, lifted out of the handler so the handler file,
 * its validators and its lock/burn effects all read ONE copy. The handler still
 * publishes them as XBridge.VERDICTS, which is the name the SDK, the docs page
 * and the unit tests quote, so nothing outside this directory changed.
 *
 ********************************************************************/

'use strict';

// Platform-wide verdicts this handler REUSES rather than minting a bridge-specific twin.
// Every one of them is already written by send.js / destroy.js / dividend.js for exactly
// the condition it names, so reusing the literal keeps one string per condition across
// the whole action set (the rule XBridge.VERDICTS states for its own strings).
const TICK_UNKNOWN       = 'invalid: TICK (unknown)';
const SOURCE_SLEEPING    = 'invalid: SOURCE (sleeping)';
const TICK_SLEEPING      = 'invalid: TICK (sleeping)';
const SOURCE_UNAUTHORIZED= 'invalid: SOURCE (not authorized)';
const MEMO_PIPE          = 'invalid: MEMO (pipe)';
const MEMO_SEMICOLON     = 'invalid: MEMO (semicolon)';
const MEMO_LENGTH        = 'invalid: MEMO (length)';
const FEE_NATIVE_REQUIRED= 'invalid: insufficient fee (native coin output required)';
const FEE_INSUFFICIENT   = 'invalid: insufficient funds (FEE)';

/**
 * Every verdict string XBRIDGE can write to data['STATUS'], frozen here so the handler,
 * its unit tests, the SDK and the docs all quote ONE source.
 *
 * THESE STRINGS ARE CONSENSUS. A verdict is persisted in index_statuses and enters
 * actions_hash, so renaming one re-grades history on replay and forks the fleet. Reuse an
 * existing string wherever the spec says to (the REUSED block at the foot of this object)
 * rather than minting a clearer one.
 *
 * PRECEDENCE, as implemented, top to bottom:
 *   version known -> activation -> broadcast of an injected version -> chain rule ->
 *   the tick guards (v3/v4 only: row kind, GAS, dot, length) -> TICK unknown ->
 *   BRIDGE_CHAINS (v3) -> DEST_COIN -> the address field -> AMOUNT -> sleep and list ->
 *   MEMO -> funds -> the fee refusals every action shares.
 *
 * Activation sits ABOVE the chain and injected-version rules deliberately: below the gate
 * the feature is not live at all, so the whole action answers with one string rather than
 * a per-version taxonomy of something no chain can run yet. Within the tick guards the
 * order is the token spec's own refusal list, which is why TICK_NOT_BRIDGEABLE is reached
 * before DEST_COIN: a destination the issuer never opted into is a fact about the TOKEN.
 */
const VERDICTS = {
    // Shared gates, common to every version.
    BEFORE_ACTIVATION:   'invalid: XBRIDGE before activation',        // below XCHAIN_BRIDGE_ACTIVATION for this CHAIN (coin-keyed) / TOKEN_BRIDGE_ACTIVATION for this network
    UNKNOWN_VERSION:     'invalid: VERSION (unknown)',                // a version byte outside 0-5; a KNOWN version below its gate is BEFORE_ACTIVATION instead
    BTC_ONLY:            'invalid: XBRIDGE (BTC only)',               // v0 broadcast on any chain other than BTC; the literal the five BTC-only handlers share
    V1_NOT_ON_BTC:       'invalid: XBRIDGE v1 is not valid on BTC',   // v1 broadcast on BTC (the inverse-chain shape anchor.js uses)
    V2_SYSTEM_INJECTED:  'invalid: XBRIDGE v2 is system-injected',    // a BROADCAST v2 on any chain, as a broadcast XCALL v2 is refused
    V5_SYSTEM_INJECTED:  'invalid: XBRIDGE v5 is system-injected',    // a BROADCAST v5 on any chain, the v2 rule carried to the general formats

    // Field refusals for v0 and v1.
    DEST_COIN:           'invalid: DEST_COIN',                        // not a supported coin, or equal to this chain's coin
    DEST_ADDRESS:        'invalid: DEST_ADDRESS',                     // fails isCryptoAddress(address, DEST_COIN, network)
    AMOUNT:              'invalid: AMOUNT',                           // not a positive decimal, or more fractional digits than the token's DECIMALS
    INSUFFICIENT_FUNDS:  'invalid: insufficient funds',               // the source's balance of the tick on this chain is short

    // Tick refusals, in the token bridge's refusal precedence order.
    TICK_NOT_NATIVE:     'invalid: TICK (not native here)',                     // v3 on a bridged row, or on a chain that is not the row's origin
    TICK_USE_V0:         'invalid: TICK (use XBRIDGE v0)',                      // v3 of the GAS tick; XCHAIN keeps v0
    TICK_SUBASSET:       'invalid: TICK (subassets are not bridgeable yet)',    // a dotted name; the prefix walk is a later milestone
    TICK_TOO_LONG:       'invalid: TICK (too long to bridge)',                  // <ORIGIN>.<NAME> would exceed the destination's tick length
    TICK_NOT_BRIDGEABLE: 'invalid: TICK (not bridgeable to DEST_COIN)',         // DEST_COIN is not in the origin row's BRIDGE_CHAINS opt-in list
    TICK_NOT_BRIDGED:    'invalid: TICK (not bridged)',                         // v4 on a native row

    // Address refusals for the formats whose address field is not DEST_ADDRESS. NOT named
    // verbatim in either spec: they follow v0's field-named convention (`invalid: <FIELD>`),
    // which is the only shape the base refusal list uses. The manifest and the docs page must name these
    // two literals verbatim before the first signed row.
    BTC_ADDRESS:         'invalid: BTC_ADDRESS',                      // v1: fails isCryptoAddress(address, 'BTC', network)
    ORIGIN_ADDRESS:      'invalid: ORIGIN_ADDRESS',                   // v4: fails isCryptoAddress(address, <origin>, network)

    // Platform-wide strings this handler REUSES. Listed here so XBridge.VERDICTS stays a
    // complete inventory of what the handler can write (the SDK, the docs page and the
    // unit tests read it as one), but every literal is the one an existing handler
    // already writes for the same condition; none of them is new to the platform.
    TICK_UNKNOWN:        TICK_UNKNOWN,                                // no row for TICK on this chain (send.js, destroy.js)
    SOURCE_SLEEPING:     SOURCE_SLEEPING,                             // the source address is asleep (send.js)
    TICK_SLEEPING:       TICK_SLEEPING,                               // the token is asleep (send.js)
    SOURCE_UNAUTHORIZED: SOURCE_UNAUTHORIZED,                         // the source is off an allow list or on a block list (send.js)
    MEMO_PIPE:           MEMO_PIPE,                                   // MEMO carries the field delimiter (send.js)
    MEMO_SEMICOLON:      MEMO_SEMICOLON,                              // MEMO carries the action delimiter (send.js)
    MEMO_LENGTH:         MEMO_LENGTH,                                 // MEMO longer than MAX_MEMO_LENGTH (send.js)
    FEE_NATIVE_REQUIRED: FEE_NATIVE_REQUIRED,                         // off BTC a protocol fee must be a native-coin output (sweep.js)
    FEE_INSUFFICIENT:    FEE_INSUFFICIENT,                            // the source cannot cover XBRIDGE_BASE in XCHAIN (sweep.js)
};

module.exports = {
    VERDICTS,
    TICK_UNKNOWN,
    SOURCE_SLEEPING,
    TICK_SLEEPING,
    SOURCE_UNAUTHORIZED,
    MEMO_PIPE,
    MEMO_SEMICOLON,
    MEMO_LENGTH,
    FEE_NATIVE_REQUIRED,
    FEE_INSUFFICIENT
};
