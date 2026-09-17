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
 * Indexer-only registry rows, part 3 of 3: protocol/constants to vm_lint_global_alias_activation
 *
 * One part of the indexer-only registry rows: every data export of a module
 * that no other repo twins, as `addGate(key, unit, table)` calls at column
 * zero, each literal carried over from the module with its comments. The
 * module keeps its predicates and reads the row back through get() or copy().
 *
 * Rows are grouped by module stem in alphabetical order; a stem's rows keep
 * the order the module declared them. Keys never change (I4).
 *
 ********************************************************************/

'use strict';

const { addGate, UNARMED, UNPINNED } = require('./shared_rows.js');

// protocol/constants (continued)
// EQUIV_HEADER_ACTIVATION (WI-2 bump 2): the BTC-anchored flag-day at/above which every
// consensus canonical is prefixed with a uniform signed header
// `EQUIV|<ENGINE_TAG>|<ROUND_ID>|<VIEW>||<CONTENT>`. This is consensus-breaking (it changes the
// signed preimage of every settlement/checkpoint/price/attestation signature + the config-change
// PBFT canonical), so it is gated, kept byte-identical to the local copies in
// xchain-{hub,indexer,sdk,explorer,sync}/src/equivocation_header.js by the
// cross-service regression suite, and must deploy hub + ALL indexers atomically. Its sole
// consumer is the SLASH v0 equivocation-slashing action, which is only constructible from
// post-flag-day (header-carrying) messages. Same ARMED height and deploy-by convention as
// STAKE_WEIGHTED_QUORUM_ACTIVATION: mainnet is armed to 961000 (2026-07-07; BTC anchor
// ~2026-08-04), not a disabled placeholder.
addGate('protocol/constants.EQUIV_HEADER_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
});

// STATE_COMMITMENT_ACTIVATION (light-client SPV, spec §6.4): the flag-day at/above which
// each indexer computes + commits the additive per-block `state_root` (balances+stakes SMT)
// and `block_merkle_root`. ADDITIVE (the three consensus block hashes + BLOCK_HASH_VERSION are
// untouched), so it is not consensus-breaking by itself; it only adds new committed roots that
// the xchain-sync follower recomputes and HALTS on if they diverge. UNLIKE the two maps above,
// this gates on the chain's OWN local block_index (each chain starts committing its own per-block
// root at its own height); the Phase 2 checkpoint/ANCHOR extension that SIGNS these roots gates on
// snapshot_block. Kept byte-identical to the local copies in xchain-indexer/src/
// state_commitment_activation.js + xchain-sync/src/state_commitment_activation.js (and xchain-hub
// at Phase 2) by the cross-service regression suite. ARMED MID-CHAIN 2026-07-07 with per-chain
// '<COIN>:<network>' keys (one shared height cannot fit BTC ~957k and DOGE ~6.28M at once; bare
// network key remains for regtest; coin-less mainnet/testnet lookups stay inert). Same heights
// as the two state-hash gate maps, so ONE deploy-by date governs all Cohort-C flips; each height
// precedes the Cohort-B BTC anchor (961000) as the checkpoint-commitment ordering requires.
addGate('protocol/constants.STATE_COMMITMENT_ACTIVATION', 'height', {
    'BTC:mainnet':  958500,     // ARMED 2026-07-07 at tip 957062; ~10 days of margin
    'LTC:mainnet':  3143000,    // ARMED 2026-07-07 at tip 3138154; ~8 days
    'DOGE:mainnet': 6291000,    // ARMED 2026-07-07 at tip 6280094; ~7.5 days
    'BTC:testnet':  145000,     // ARMED 2026-07-07 at tip 143299
    'LTC:testnet':  4805000,    // ARMED 2026-07-07 at tip 4797675
    'DOGE:testnet': 67000000,   // ARMED 2026-07-07 at tip 66498605 (fast chain, wide margin)
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise the roots end to end
});

// CHECKPOINT_COMMITMENT_ACTIVATION (light-client SPV, spec §6.1/§6.3, Phase 2): the flag-day at/above
// which the quorum-signed checkpoint canonical (and the on-chain ANCHOR) COMMIT the additive
// `state_root` + `block_merkle_root` (with their version bytes) that STATE_COMMITMENT_ACTIVATION made
// the indexer compute in Phase 1. Post-flag-day the checkpoint canonical string gains
// `|STATE_ROOT|STATE_ROOT_VERSION|BLOCK_MERKLE_ROOT|BLOCK_MERKLE_VERSION` and a new ANCHOR v3 carries
// the roots on DOGE; pre-flag-day both keep their old shape and the roots are absent. Consensus-relevant
// for signature verification (the signed preimage changes), so it must deploy hub + ALL indexers + the
// SDK/explorer verifiers atomically.
//
// UNLIKE STATE_COMMITMENT_ACTIVATION (which gates on each chain's OWN local block_index, since each chain
// computes its own per-block root), this gates on the BTC-anchored `snapshot_block` carried by every
// checkpoint canonical, exactly like STAKE_WEIGHTED_QUORUM_ACTIVATION / EQUIV_HEADER_ACTIVATION, so the
// hub and the BTC/LTC/DOGE indexers all flip the SIGNED shape on the same anchor. The operator MUST pick
// a snapshot_block at/after which every checkpointed chain is already past its own STATE_COMMITMENT
// flag-day (else the engine would have no roots to sign). Kept byte-identical to the local copies in
// xchain-{hub,indexer,sdk,explorer,sync}/src/checkpoint_commitment_activation.js (sync consumes it at
// checkpoint.js to decide whether to expect the roots) by the cross-service regression suite. Same
// ARMED height and deploy-by convention as the maps above: mainnet is armed to 961000
// (2026-07-07; BTC anchor ~2026-08-04), not a disabled placeholder.
addGate('protocol/constants.CHECKPOINT_COMMITMENT_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 146000,      // ARMED 2026-07-22: first BTC-testnet anchor past all three STATE_COMMITMENT testnet thresholds; was 0, which forced the SPV root suffix from testnet genesis before the indexer computes roots, so the hub refused to sign every testnet checkpoint
    regtest: 0,
});

// ANCHOR_REWARD_ACTIVATION (anchor-reward re-derivation): the flag-day at/above which the validator
// anchor reward stops being TRUSTED from the hub's `pushvalidatorrewards` JSON-RPC and is instead
// DERIVED by every indexer from the on-chain ANCHOR bytes. Post-flag-day the hub emits a publisher-
// bearing ANCHOR (v4 rootless / v5 root-bearing) carrying the elected publisher pubkey plus a 2f+1
// `oracle_publish` attestation (XANCPUB) over the reward tuple; the indexer verifies that quorum and
// credits the publisher with ANCHOR_REWARD_AMOUNT (a frozen consensus constant, NEVER from the wire).
// Below the flag-day the old push path stands and v4/v5 anchors are rejected. Consensus-relevant (the
// credited reward becomes a COLLECT-spendable per-block ledger row), so it must deploy hub + ALL
// indexers atomically. Like CHECKPOINT_COMMITMENT_ACTIVATION / STAKE_WEIGHTED_QUORUM_ACTIVATION it gates
// on the BTC-anchored `snapshot_block` carried by every ANCHOR canonical. Kept byte-identical to the
// local copies in xchain-{hub,indexer}/src/anchor_reward_activation.js by the cross-service regression
// suite. Same ARMED height and deploy-by convention as the maps above: mainnet is armed to 961000
// (2026-07-07; BTC anchor ~2026-08-04), not a disabled placeholder.
addGate('protocol/constants.ANCHOR_REWARD_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
});

// ANCHOR_REWARD_AMOUNT: the frozen validator anchor-publish reward, signed into the XANCPUB attestation
// by the hub and re-derived by the indexer (never from the wire). Changing it is itself a flag-day.
addGate('protocol/constants.ANCHOR_REWARD_AMOUNT', 'constant', '10.00000000');

// ARCHIVE_REWARD_ACTIVATION (archive-reward re-derivation): the flag-day at/above which the
// anchor_archive reward stops riding the key-authenticated `pushvalidatorrewards` rail and is instead
// DERIVED by every indexer from the on-chain ANCHOR v6 bytes (the v1 archive anchor plus the same
// PUBLISHER + 2f+1 XANCPUB attestation tail as v4/v5, attested over an 'anchor_archive' canonical
// keyed on MATCH_BATCH_SEQ). This retires the last insider-with-key reward-forge surface the
// per-chain ANCHOR_REWARD flag-day left open. Below the flag-day the legacy v1 + push path stands
// and v6 anchors are rejected. Consensus-relevant, same deploy rules and snapshot_block gating as
// ANCHOR_REWARD_ACTIVATION; kept byte-identical to the local copies in
// xchain-{hub,indexer}/src/anchor_reward_activation.js by the cross-service regression suite.
addGate('protocol/constants.ARCHIVE_REWARD_ACTIVATION', 'height', {
    mainnet: 963000,      // ARMED 2026-07-16, RE-PINNED 2026-08-12 off 969500 onto the pre-freeze train boundary (tip 959,853 on 07-27 at ~144 blocks/day + 21d); deploy every consumer before this era
    testnet: 0,
    regtest: 0,
});

// ARCHIVE_REWARD_AMOUNT: the frozen archive-publish reward, signed into the archive XANCPUB
// attestation by the hub and re-derived by the indexer (never from the wire). Kept equal to the
// hub's historical default (ANCHOR_REWARD_PER_PUBLISH). Changing it is itself a flag-day.
addGate('protocol/constants.ARCHIVE_REWARD_AMOUNT', 'constant', '10.00000000');

// CROSS_CHAIN_ROYALTY_ACTIVATION (cross-chain royalty match-canonical): the flag-day at/above which
// the validator-signed XMATCH canonical carries the matched orders' royalty payout legs
// (a_payout_legs / b_payout_legs), so a colluding hub cannot strip a royalty from a cross-chain
// match; below it the canonical stays byte-identical to the legacy format, so pre-existing
// signatures keep verifying. Consensus-relevant (the signed preimage changes), so it must deploy
// hub + ALL indexers atomically. Like CHECKPOINT_COMMITMENT_ACTIVATION / ANCHOR_REWARD_ACTIVATION
// it gates on the BTC-anchored `snapshot_block` carried by every XMATCH canonical. The CREATE-side
// acceptance rule (deny a royalty-bearing cross-chain listing while enforcement is impossible) is
// gated separately by the CROSS_CHAIN_ROYALTY entry in the indexer's protocol_changes.js; the
// operator MUST flip this canonical gate first or together with it, NEVER create-side first
// (create-side ON with canonical OFF would put the legs in unsigned mirror fields, the exact
// tamper hole the legs-in-canonical design closes). Kept byte-identical to the local copies in
// xchain-{hub,indexer}/src/cross_chain_royalty_activation.js by the cross-service regression
// suite. Same ARMED height and deploy-by convention as the maps above: mainnet is armed to
// 961000 (2026-07-07; BTC anchor ~2026-08-04), not a disabled placeholder.
addGate('protocol/constants.CROSS_CHAIN_ROYALTY_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers before this height
    testnet: 0,
    regtest: 0,
});

// VALID_FIAT_CODES: the accepted FIAT_CODE allow-list for PRICE actions. The indexer's
// config['FIATS'] keys (xchain-indexer/src/config.js) are the on-chain arbiter; this list
// mirrors them in the indexer's insertion order. The SDK validator (VALID_FIAT_CODES) must
// be a byte-equal allow-list so it never refuses a FIAT the protocol accepts (a drifted copy
// once shipped without EUR and KRW). The cross-service parity test asserts SDK === this list.
addGate('protocol/constants.VALID_FIAT_CODES', 'constant', ['USD', 'CAD', 'AUD', 'MXN', 'GBP', 'JPY', 'CNY', 'CHF', 'BRL', 'INR', 'EUR', 'KRW']);

// GAS_TICK: the protocol gas token's TICK. The indexer's config['GAS']
// (xchain-indexer/src/config.js) is the on-chain arbiter: it names the token
// debited for capability STAKE, VOTE deposits/escrows, contract gas billing,
// and every other gas-denominated flow. The SDK co-signer policy engine keys
// capability-STAKE spending caps to this tick (STAKE v1/v2 carry no TICK
// field). The cross-service parity test asserts indexer === SDK === this value.
addGate('protocol/constants.GAS_TICK', 'constant', 'XCHAIN');

// Coarse global sanity ceiling on an ingested price_snapshots value (pre-scale,
// covers pairs like BTC/KRW up to ~$7M BTC with headroom); rejects
// parse-overflow / misplaced-decimal garbage. Per-pair outliers are caught by
// the co-sign deviation gate and multi-submitter aggregation, not here.
const PRICE_MAX = 10_000_000_000;
addGate('protocol/constants.PRICE_MAX', 'constant', PRICE_MAX);
// price_zero_validity_activation re-exports the same value under its own key.
addGate('price_zero_validity_activation.PRICE_MAX', 'constant', PRICE_MAX);

// Co-sign deviation band for the oracle PREPARE content-validation gate: a
// follower refuses to co-sign a proposed price that deviates more than this
// fraction from its own local aggregate for the pair. MUST be
// federation-uniform: if hubs used different bands, identical aggregates
// could yield different accept/withhold decisions (a liveness divergence on
// the ±band boundary). 0.05 = 5%.
addGate('protocol/constants.ORACLE_DEVIATION_THRESHOLD', 'constant', 0.05);

// ── Oracle history the VM can see (db.getOracleDataForVM) ───────────────────
// The VM's bridge is synchronous and runs in a forked worker, so oracle history
// is PRE-LOADED and shipped across an IPC boundary before every execution. Both
// numbers below bound that payload, and both are consensus inputs: they decide
// which rounds a contract can read, and two nodes loading different rounds reach
// different contract state.
//
// ORACLE_VM_ROUND_WINDOW is the window in ROUNDS, deliberately not in rows. A flat
// row cap taken newest-first would make the visible history a function of how many
// coin pairs the oracle happens to publish: at 36 pairs a 50,000-row cap is only
// ~1,388 rounds, and every pair added narrows it further with no signal. A
// round-denominated window is stable under pair growth, and it is the quantity a
// contract reasons about.
//
// The window is also what makes the boundary VISIBLE. getOracleDataForVM returns
// the oldest round the window guarantees, and the VM's accessor answers
// "outside the loaded window" for anything below it instead of the same null it
// returns for a round that never existed. Those two were indistinguishable, and
// the price-bet family votes its void guard on exactly that null, so the loser of
// a settled bet could reclaim their stake by waiting for the settle round to
// scroll out of the preload.
//
// 1200 rounds is ~8.3 days at the oracle's 144-rounds-per-day cadence, and is
// the largest whole-round window that fits under the row ceiling at today's 36
// pairs (1200 x 36 = 43,200). db.oracle-round-window.test.js pins that
// arithmetic, so adding pairs past the point where the ceiling starts truncating
// reddens a suite rather than silently shrinking the window again.
addGate('protocol/constants.ORACLE_VM_ROUND_WINDOW', 'constant', 1200);

// Hard ceiling on preloaded rows, unchanged from the flat cap it replaces so the
// per-execution IPC payload does not regress. It is a backstop, not the window:
// when it truncates, the oldest loaded round may be missing pairs, so the floor
// reported to the VM rises above that round rather than claiming coverage the
// payload does not have.
addGate('protocol/constants.ORACLE_VM_MAX_ROWS', 'constant', 50000);

// slash_grid_activation
// Scale the per-row deduction runs at once the rule is live. 18 is
// MAX_TOKEN_DECIMALS (src/config.js), the finest precision any tick can be
// issued with, so a subtraction at this scale is exact for every stored amount
// and the derived delta is the reduction written rather than a re-rounding of it.
addGate('slash_grid_activation.SLASH_DEDUCTION_PRECISION', 'constant', 18);

// Per-chain activation heights, interpreted against the chain's own block_index.
// `null` = NOT YET PINNED = inert (legacy arithmetic, byte-identical replay).
addGate('slash_grid_activation.SLASH_GRID_ACTIVATION', 'height', {
    // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet
    // history (0 stakes, 0 slashes on every chain, measured 2026-09-09).
    'BTC:mainnet':  0,
    'LTC:mainnet':  0,
    'DOGE:mainnet': 0,
    // Unpinned: testnet carries stake history, so its heights are pinned at
    // flag-day assembly with the replay evidence that step requires.
    'BTC:testnet':  null,
    'LTC:testnet':  null,
    'DOGE:testnet': null,
    regtest: 0,
});

// slash_ledger_consolidation_activation
// Per-chain activation heights, interpreted against the chain's own block_index.
// `null` = NOT YET PINNED = inert (legacy per-emission overwrite, byte-identical
// replay).
addGate('slash_ledger_consolidation_activation.SLASH_LEDGER_CONSOLIDATION_ACTIVATION', 'height', {
    // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet
    // history (0 stakes, 0 slashes on every chain, measured 2026-09-09).
    'BTC:mainnet':  0,
    'LTC:mainnet':  0,
    'DOGE:mainnet': 0,
    // Unpinned: testnet carries stake history, so its heights are pinned at
    // flag-day assembly with the replay evidence that step requires.
    'BTC:testnet':  null,
    'LTC:testnet':  null,
    'DOGE:testnet': null,
    regtest: 0,
});

// stake_key_reuse_activation
// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after the height a SIGNING_PUBKEY whose every stake row is
// deactivated and past cooldown is admissible for STAKE v1; below it the
// legacy "any valid stakes row ever" refusal runs unchanged.
addGate('stake_key_reuse_activation.STAKE_KEY_REUSE_ACTIVATION', 'height', {
    'BTC:mainnet':  null,         // INERT: operator-owned, sized above the deploy tip on the arming train
    'LTC:mainnet':  null,         // INERT: capability STAKE is BTC-only; carried for shape
    'DOGE:mainnet': null,         // INERT: capability STAKE is BTC-only; carried for shape
    mainnet:        null,         // INERT: a coin with no entry above inherits the unarmed posture
    'BTC:testnet':  156000,       // SIZED 2026-09-11: chain_tip 151,991 + 3,024 (21d @144/day) = 155,015, rounded up
    'LTC:testnet':  4897000,      // SIZED 2026-09-11: chain_tip 4,883,971 + 12,096 (21d @576/day) = 4,896,067, rounded up
    'DOGE:testnet': 67920000,     // SIZED 2026-09-11: chain_tip 67,887,900 + 30,240 (21d @1440/day) = 67,918,140, rounded up
    testnet:        null,         // INERT: a testnet coin with no entry above stays on the legacy refusal
    regtest:        0,            // genesis-active so the e2e venue exercises the armed rule
});

// sweep_zero_leg_activation
// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after the height a SWEEP settle writes no debit/credit leg
// for a held tick whose amount is not above zero; below it the legs are
// written exactly as the deployed fleet writes them.
addGate('sweep_zero_leg_activation.SWEEP_ZERO_LEG_ACTIVATION', 'height', {
    'BTC:mainnet':  null,         // INERT: operator-owned, sized above the deploy tip on the arming train
    'LTC:mainnet':  null,         // INERT: operator-owned, sized above the deploy tip on the arming train
    'DOGE:mainnet': null,         // INERT: operator-owned, sized above the deploy tip on the arming train
    mainnet:        null,         // INERT: a coin with no entry above inherits the unarmed posture
    'BTC:testnet':  156000,       // SIZED 2026-09-11: chain_tip 151,994 + 3,024 (21d @144/day) = 155,018, rounded up; shared with STAKE_KEY_REUSE_ACTIVATION
    'LTC:testnet':  4897000,      // SIZED 2026-09-11: chain_tip 4,883,984 + 12,096 (21d @576/day) = 4,896,080, rounded up; shared with STAKE_KEY_REUSE_ACTIVATION
    'DOGE:testnet': 67920000,     // SIZED 2026-09-11: chain_tip 67,888,041 + 30,240 (21d @1440/day) = 67,918,281, rounded up; shared with STAKE_KEY_REUSE_ACTIVATION
    testnet:        null,         // INERT: a testnet coin with no entry above keeps writing the legs
    regtest:        0,            // genesis-active so the e2e venue exercises the armed rule
});

// tick_namespace_activation
// TICK_NAMESPACE_ACTIVATION: the height (per chain) on the chain being parsed at/above
// which the four-character creation floor and the RESERVED_FUTURE_ROOTS refusal bind.
// Keyed on the chain's OWN block_index: what it gates is the verdict of an ISSUE mined
// here.
//
// Regtest is 0, so both rules bind on the only venue milestone 1 runs on; the integration
// and e2e fixtures were scanned 2026-09-11 and no real ISSUE of a listed or short name
// exists there (XCP appears only in unit-test mocks, and every scenario ticker is four
// characters or longer).
//
// KEYED '<COIN>:<network>' since the v0.20.0 arming train, bare network as the fallback.
// The namespace has to close at or before TOKEN_BRIDGE_ACTIVATION on every chain key, and
// that map is three testnet heights whose tips differ by orders of magnitude: one bare
// testnet number at or below BTC's 153160 would sit millions of blocks under the TLTC and
// TDOGE tips and re-verdict every short or reserved ISSUE ever mined there.
//
// Testnet arms AT the token bridge height on each chain. Every slot is above that chain's
// tip, so no mined ISSUE is re-verdicted, and each carries the same post-roll lead the
// bridge was sized with, which an earlier height would have to give up. Mainnet is a
// genesis-arm candidate under the genesis-arm method and stays at the sentinel until the
// mainnet replicas measure zero mined ISSUEs of a short or listed name, valid OR invalid:
// an armed height below a real one would re-verdict it and move that chain's hashes.
addGate('tick_namespace_activation.TICK_NAMESPACE_ACTIVATION', 'height', {
    mainnet:        9999999999,
    'BTC:testnet':  153160,       // == TOKEN_BRIDGE_ACTIVATION BTC:testnet, sized 2026-09-17 02:42Z
    'LTC:testnet':  4888478,      // == TOKEN_BRIDGE_ACTIVATION LTC:testnet
    'DOGE:testnet': 67906525,     // == TOKEN_BRIDGE_ACTIVATION DOGE:testnet
    testnet:        9999999999,   // fallback: a testnet coin with no entry above stays dark
    regtest:        0,
});

// vm_deploy_lint_pkg3_activation
// Per-chain activation height, interpreted as the processing chain's OWN block_index.
// At/after the height the deploy-lint generator + wasm bans block; below it they are
// dropped from the deploy-blocking set (historical accepted verdict preserved).
// Mirrors xchain-vm/src/index.js PKG3_SANDBOX_ACTIVATION.
addGate('vm_deploy_lint_pkg3_activation.VM_DEPLOY_LINT_PKG3_ACTIVATION', 'height', {
    'BTC:mainnet':  961000,
    'LTC:mainnet':  3154250,
    'DOGE:mainnet': 6319000,
    testnet: 0,
    regtest: 0,
});

// vm_exec_lint_activation
// Per-chain activation height, interpreted as the processing chain's OWN block_index.
// At/after the height the VM re-lints stored contract code on every EXECUTE and fails
// the execution when a now-banned construct is present; below it there is no check and
// no gas charge (byte-identical replay).
// MUST equal xchain-vm/src/index.js EXEC_LINT_ACTIVATION.
addGate('vm_exec_lint_activation.VM_EXEC_LINT_ACTIVATION', 'height', {
    'BTC:mainnet':  0,   // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 contracts, 0 DEPLOY, 0 EXECUTE, measured 2026-09-09)
    'LTC:mainnet':  0,
    'DOGE:mainnet': 0,
    testnet: 0,
    regtest: 0,
});

// vm_lint_global_alias_activation
// Per-chain activation height, interpreted as the processing chain's OWN block_index.
// At/after the height the deploy-lint banned-async / banned-wasm / banned-math rules
// also match sloppy-mode `this` and the globalThis self-reference chain; below it they
// resolve as they historically did (byte-identical replay).
// MUST equal xchain-vm/src/index.js LINT_GLOBAL_ALIAS_ACTIVATION.
addGate('vm_lint_global_alias_activation.VM_LINT_GLOBAL_ALIAS_ACTIVATION', 'height', {
    'BTC:mainnet':  0,   // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 contracts, 0 DEPLOY, measured 2026-09-09)
    'LTC:mainnet':  0,
    'DOGE:mainnet': 0,
    testnet: 0,
    regtest: 0,
});
