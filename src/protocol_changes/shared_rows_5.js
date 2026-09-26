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
 * The SHARED block, part 5 of 5: token_policy_activation to xchain_bridge_activation
 *
 * One SHARED block part. The region between the two marker lines is
 * BYTE-TWINNED into the registry of xchain-sync, xchain-hub, xchain-explorer
 * and xchain-sdk: each consumer keeps the same bytes and replaces only the
 * require line below with its own queue module. What may live between the
 * markers: `addGate(key, unit, table)` calls with LITERAL values (a table, a
 * number, a string or literals joined by +, a RegExp, an array), one call per
 * row, at column zero, and comments. No require, no computed value, nothing
 * from outside the block but addGate, UNARMED and UNPINNED. A regtest entry a
 * venue arms from its environment is written UNPINNED here and armed by the
 * wrapper at registration (shared_rows.js), so the block stays data.
 *
 * Rows are grouped by module stem in alphabetical order; a stem's rows keep
 * the order the module declared them. Keys never change (I4).
 *
 ********************************************************************/

'use strict';

const { addGate, UNARMED, UNPINNED } = require('./shared_rows.js');

// SHARED-GATES BEGIN
// token_policy_activation
// TOKEN_POLICY_INHERITANCE_ACTIVATION: the height (per network) on the chain being
// parsed at/above which policy inheritance is in effect. Keyed on the chain's OWN
// block_index, never on a snapshot's snapshot_block or origin_block, because what it
// gates is the verdict of an action mined here.
//
// What it gates, all of it consensus-visible:
//   - the milestone-1 refusals lifted in issue.js (format 7 on a listed token; format
//     5, and a format 0 carrying lists, on a bridged token);
//   - any-coin address items in list.js and the same widening in db.isAddressSleeping;
//   - application of a mirrored policy_snapshots row on the destination, and with it
//     the in-leg barrier that holds a v5 credit until the tick has a policy;
//   - the hub engine's policy poll, so no XPOLICY row is signed below it.
//
// Below it every milestone-1 verdict stands unchanged, so the replay corpus is
// hash-identical on every chain with this code present.
//
// Mainnet and testnet are the house sentinel 9999999999: this rides the same MAJOR
// train as the two bridges and the operator sizes the dated instant at the cut. A
// height in the map ahead of the fleet's deploy tip is the operator's act, not a
// build's. Regtest is 0 so the e2e rail exercises the armed rule from genesis.
//
// TWO ORDERING INVARIANTS, asserted by test/unit/activationConstantsParity.test.js
// over the canonical constants.js rather than over this copy:
//   - >= TOKEN_BRIDGE_ACTIVATION per network. Inheritance has nothing to inherit onto
//     before bridged copies can exist.
//   - >= LIST_EDIT_RESOLUTION_ACTIVATION per chain and network. The snapshot read
//     resolves a list AS OF origin_block through getListAtBlock, which walks the edit
//     chain; below that gate the legacy create-index read runs and the membership the
//     federation signs would not be the membership the chain actually held.
addGate('token_policy_activation.TOKEN_POLICY_INHERITANCE_ACTIVATION', 'height', {
    mainnet: 9999999999,
    'BTC:testnet': 9999999999,
    'LTC:testnet': 9999999999,
    'DOGE:testnet': 9999999999,
    testnet: 9999999999,
    regtest: 0,
});

// train_activation
// Keyed by platform version, then network, to a BTC block height. Only MAJOR
// trains and consensus-classified hotfixes get a row; a MINOR or PATCH train adds
// none, and resolveRuleSet then keeps the fleet on the previous entry with no
// ceremony change. Regtest is 0 on every row because regtest stacks are rebuilt
// from genesis and so exercise the new rule set end to end rather than the
// migration. Mainnet is armed ABOVE the tip at cut time on purpose: the fleet runs
// the new binary under the OLD rules until that height, which is the rolling-upgrade
// window. Nothing here is edited outside a train cut.
addGate('train_activation.TRAIN_ACTIVATION', 'ruleset', {
    // The launch rule set and the floor. Zero on every network because there is no
    // earlier rule set to migrate from: the launch binary IS the first rule set, and
    // a floor above genesis would leave the pre-floor range resolving to nothing.
    '1.0.0': { mainnet: 0, testnet: 0, regtest: 0 },
    // The XCHAIN bridge rule set, armed at the v0.19.0 cut. Mainnet holds the house
    // sentinel: the mainnet arm is the next milestone and nothing arms there before the
    // checkpoint cross-check lands, so no mainnet node ever reaches this boundary.
    // Testnet: SIZED 2026-09-16, re-cut 16:33Z, from chain_tip TBTC 152,716 + 71 blocks,
    // which is ceil(10 h / 508.8 s per block measured over the preceding 99 blocks), about
    // 10.0 h. The first sizing (11:53Z, 152,716 itself) was overrun by the chain while the
    // cut waited on the e2e matrix, so the boundary was re-cut from the new tip with a lead
    // long enough to cover that wait plus the roll. That is the rolling-upgrade window the
    // fleet roll must finish inside (over 6x the 90 minute roll budget), and every testnet
    // bridge height below sits above it on the same BTC clock, so a node lacking this rule
    // set halts before it can grade a bridge action.
    '0.19.0': { mainnet: 9999999999, testnet: 152787, regtest: 0 },
    // The mirror-admission rule set, armed at the v0.20.0 cut: the producer and consumer
    // admission maps and the anchor-attest barrier replace the effective_time binding, so a
    // node without them grades an admission-stamped row under the rule it replaced. Mainnet
    // holds the house sentinel because the whole family is null on mainnet under the
    // 2026-08-29 write hold. Testnet: SIZED 2026-09-17 22:45Z, chain_tip TBTC 152,891 + 225
    // blocks, which is ceil(36 h / 576.7 s per block), about 36.0 h. The cadence is measured
    // over a trailing window as long as the lead being sized (53 h here), never the last 99
    // blocks: a 99-block window on a testnet difficulty burst is noise, and it is what pulled
    // the LTC leg of this family two days off its BTC counterpart a day after the first cut.
    // That lead is the rolling-upgrade window the fleet roll must finish inside (24x the 90
    // minute roll budget), and every testnet mirror-admission height sits above it on the same
    // BTC clock, so a node lacking this rule set halts before it can grade an admission-stamped
    // row.
    // RE-SLID 2026-09-23 for the v0.20.1 patch train, after the live tips overran the
    // 2026-09-19 slide before the freeze: margin is 40 h to the nearest armed height, converted
    // at each coin's fastest defensible cadence. Chain_tip TBTC 153,698 at 2026-09-23T15:55Z
    // + 376 blocks, ceil(40 h / 383.04 s per block, the least-squares bound). The
    // mirror-admission family below re-slides onto the same instant plus its own 17 h and 6 h
    // offsets. LTC:testnet mirror admission ships disabled on this train and is
    // untouched by this reslide; it arms on a later train.
    '0.20.0': { mainnet: 9999999999, testnet: 154074, regtest: 0 },
});

// xchain_bridge_activation
// XCHAIN_BRIDGE_ACTIVATION: the height on the chain being parsed at/above which XBRIDGE is
// legal. Below it a broadcast v0 or v1 is 'invalid: XBRIDGE before activation' (the
// per-feature shape anchor.js uses; the central 'invalid: ACTION is not yet activated' only
// fires on software that predates the action) and no v2 is ever injected, so pre-activation
// block hashes are unchanged on every chain.
//
// Keyed on the chain's OWN block_index, never on a transfer's snapshot_block: the row being
// judged is the action mined here. The hub reads the same map for the chain a leg was mined
// on, and signs nothing for a chain that has not reached its own height.
//
// KEYED '<COIN>:<network>', with the bare network key as the fallback (the shape
// stake_key_reuse_activation.js already uses one map over). One testnet number cannot serve
// three chains: the bridge arms on TBTC, TLTC and TDOGE, whose tips differ by orders of
// magnitude (about 152,110 / 4,884,193 / 67,889,993 measured 2026-09-12), so a single height
// is either already passed on two of them at boot or unreachable on the third. A coin with
// no entry of its own inherits the bare network key, which leaves an unlisted chain inert
// rather than undecided.
//
// Mainnet is the house sentinel 9999999999 on every key: milestone 1 is a hub-trusted mint
// (spec section 12), and nothing arms on mainnet before the D2 checkpoint cross-check lands.
// Testnet is SIZED AT THE v0.19.0 CUT, one dated instant PER CHAIN, from the three chain
// tips and their last-99-block cadences read in one sitting (2026-09-16 16:33Z, the re-cut
// after the 11:53Z sizing was overrun: TBTC 152,716 at 508.8 s per block, TLTC 4,887,644 at
// 141.8 s, TDOGE 67,900,748 at 27.4 s). The two destinations arm ceil(10 h / cadence) blocks
// above their tips and BTC, the ORIGIN of the v0 lock, arms ceil(30 h / cadence) above its
// tip and so LAST in wall clock, because the lock
// handler never checks the destination's own activation: a destination arming later would
// admit a lock nothing can mint, and the 3x gap is the band a destination cadence can slow by
// before that ordering breaks. All three sit above the TRAIN_ACTIVATION 0.19.0 testnet
// boundary on the BTC clock, so a node lacking the rule set halts before it grades a bridge
// action. Regtest is 0 and stays bare, because one regtest number fits every chain and the
// e2e rail exercises the armed rule from genesis.
addGate('xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION', 'height', {
    'BTC:mainnet':  9999999999,
    'LTC:mainnet':  9999999999,
    'DOGE:mainnet': 9999999999,
    mainnet:        9999999999,   // fallback for a coin with no entry above
    'BTC:testnet':  152929,       // SIZED 2026-09-16, re-cut 16:33Z: chain_tip 152,716 + 213 (30 h at 508.8 s/blk), about 30.1 h, the origin, last
    'LTC:testnet':  4887898,      // SIZED 2026-09-16, re-cut 16:33Z: chain_tip 4,887,644 + 254 (10 h at 141.8 s/blk), about 10.0 h
    'DOGE:testnet': 67902062,     // SIZED 2026-09-16, re-cut 16:33Z: chain_tip 67,900,748 + 1314 (10 h at 27.4 s/blk), about 10.0 h
    testnet:        9999999999,   // fallback: a testnet coin with no entry above stays dark
    regtest:        0,            // genesis-active so the e2e rail exercises the armed rule
});
// SHARED-GATES END
