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
 * XChain Protocol: Canonical Size Limits
 *
 * Single documented source of truth for the protocol-level size caps
 * that more than one service enforces independently. These values had
 * drifted apart before (services each re-declared their own copy and
 * applied it to subtly different quantities), which produced a class of
 * silent-failure bugs where one service accepted data another rejected.
 *
 * Plain CommonJS, zero dependencies; require()-able from any service,
 * tool, or test. Each service keeps its own local copy of these values
 * so it stays self-contained for deployment (the services ship as
 * independent containers and do not share a node_modules tree); the
 * cross-service regression suite asserts every local copy equals the
 * value declared here, so the limits can never silently diverge again.
 *
 ********************************************************************/

// Maximum *compiled* on-chain ACTION push, in bytes.
//
// This is measured against the reassembled script push as it appears on
// chain (i.e. the OP_PUSHDATA-prefixed buffer, BEFORE bitcoin.script.decompile
// strips the push prefix. The indexing decoder is the protocol arbiter: it
// drops any transaction whose compiled ACTION push exceeds this value, so the
// encoder must enforce the identical compiled-size ceiling. A transaction the
// encoder produces above this size would be silently dropped by every node.
const MAX_ACTION_DATA_LENGTH = 8192;

// Bytes added by the OP_PUSHDATA2 push prefix (1-byte opcode + 2-byte
// little-endian length) when a 256..65535-byte payload is compiled into the
// on-chain script. For a single such push the compiled length is therefore
// (decoded payload bytes + OP_RETURN_PUSH_OVERHEAD); smaller payloads use a
// 1- or 2-byte prefix, and multi-segment encodings add one prefix per segment.
// This is why the authoritative cap is enforced on the *compiled* length, not
// on the decoded character count.
const OP_RETURN_PUSH_OVERHEAD = 3;

// Maximum smart-contract source code size, in bytes (64 KiB). Enforced by the
// SDK (pre-flight validation), the indexer (DEPLOY processing) and the VM
// (isolate limit). These were each declared independently and are kept in
// lockstep by the same regression suite.
const MAX_CODE_SIZE = 65536;

// Cross-contract calls (emit.execute). Maximum call depth: a user-submitted
// EXECUTE runs at depth 0; each emit.execute hop adds 1. Enforced by the VM at
// emit time and re-validated by the indexer when it processes the emission.
const VM_MAX_CALL_DEPTH = 4;

// Minimum caller-funded gas reservation per emit.execute call. Bounds call-tree
// fan-out: every call costs at least (VM_EMISSION + VM_MIN_CALL_GAS) out of the
// caller's own gas budget. Enforced by the VM and the indexer in lockstep.
const VM_MIN_CALL_GAS = 5000;

// ── Cross-CHAIN contract calls (emit.crossExecute / XCALL) ──────────────────
// Enforced by the VM at emit time and re-validated host-side by the indexer
// (processEmission + actions/xcall.js); the target chain re-validates the
// signed dispatch row before injecting. See protocol/Cross_Chain_Calls.md.

// Target-side gas ceiling bounds. The injected execution is fee-less on the
// target chain (the caller pre-paid on the source chain), so the per-call cap
// is much tighter than the same-chain 1M execution ceiling. The minimum equals
// VM_MIN_CALL_GAS.
const XCALL_MIN_GAS = 5000;
const XCALL_MAX_GAS = 200000;

// Cross-chain hop budget: a user-originated call is hop 1; a call emitted from
// a cross-chain-injected execution (or from a result callback) is hop 2; more
// requires a fresh user transaction. Bounds X→Y→X ping-pong, which is
// otherwise free after the first hop (injected executions have no fee payer).
const XCALL_MAX_HOPS = 2;

// Source-chain deadline window (blocks). Must comfortably exceed both chains'
// relay confirmation depths plus federation rounds; expiry past deadline_block
// is synthesized deterministically by every source-chain indexer.
const XCALL_MIN_DEADLINE_BLOCKS = 10;
const XCALL_MAX_DEADLINE_BLOCKS = 4000;

// Return payload cap, bytes (pre-base64). The payload is mirrored to every
// indexer and ANCHOR-archived on DOGE; an oversize return becomes status
// 'payload_too_large' with an EMPTY payload (deterministic. Never truncated).
const XCALL_MAX_RETURN_BYTES = 1024;

// Deterministic per-block injection cap on each target chain. Overflow carries
// forward to the next block in (snapshot_block, call_id) order. Never dropped.
const XCALL_MAX_CALLS_PER_BLOCK = 25;

// ── Chunked DEPLOY (DEPLOY v4 carriers + DEPLOY v2/v3 assemble) ─────────────
// A contract whose base64(code) exceeds the single-tx budget is split across
// ordered DEPLOY v4 carrier actions and reassembled by a DEPLOY v2/v3 keyed on
// the CODE_HASH. Enforced by the indexer (deploy_chunk + deploy assembly) and
// the SDK (chunkHelper splitter) in lockstep.

// Maximum number of chunks one DEPLOY may assemble. base64(MAX_CODE_SIZE) is
// ~87.4 KB; at the conservative per-chunk part budget below that is ~12 chunks,
// so 16 leaves headroom while bounding assembler work + chunk-table DoS.
const MAX_DEPLOY_CHUNKS = 16;

// Maximum bytes of base64 code carried by a single DEPLOY v4 carrier's CODE_PART.
// Sized so the compiled v4 carrier action (action prefix + 64-char CODE_HASH +
// indices + the part) stays comfortably under MAX_ACTION_DATA_LENGTH including
// the OP_PUSHDATA2 prefix. The SDK splits at this size; the indexer rejects a
// larger part (belt-and-suspenders; the decoder already drops oversize pushes).
const MAX_DEPLOYCHUNK_PART_BYTES = 7800;

// ── Stake-weighted quorum (STAKE_WEIGHTED_QUORUM / WI-1) ────────────────────
// Consensus-critical activation: at/above this BTC-anchored snapshot_block the
// federation quorum becomes stake-WEIGHTED (signers' summed source stake must
// exceed 2/3 of total active snapshot stake) instead of count-based (2f+1 of the
// pubkey COUNT). Spec: claude/reports/2026-06-14_cross-chain-quorum-security-spec.md.
//
// Keyed on the BTC `snapshot_block` carried by every settlement/checkpoint
// canonical (NOT each chain's local processing height) so the hub and the BTC,
// LTC and DOGE indexers all flip on the SAME anchor. A per-chain local-height
// gate would fork: one snapshot_block lands at different local heights per chain.
// The `network` is also taken from the row, so the gate is env-independent.
//
// Enforced IDENTICALLY by the hub (every PBFT tally engine), the indexer
// (every settlement-signature gate + recovery), and the sdk/explorer/sync
// verifiers. All five keep a local copy of this map; the cross-service
// regression suite asserts they equal these values, so the activation height
// can never silently diverge (a divergence forks the chain).
//
// mainnet is ARMED (2026-07-07) to a concrete near-term height: 961000, the
// BTC-anchored flag-day at which mainnet flips from the count-based quorum
// rule to stake-weighted. BTC anchor ~2026-08-04; hub + ALL indexers (+
// sdk/explorer/sync copies) MUST deploy before this height. testnet/regtest
// activate at genesis so the e2e / regtest stack exercises stake-weighting
// from block 0.
const STAKE_WEIGHTED_QUORUM_ACTIVATION = {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
};

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
const EQUIV_HEADER_ACTIVATION = {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
};

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
const STATE_COMMITMENT_ACTIVATION = {
    'BTC:mainnet':  958500,     // ARMED 2026-07-07 at tip 957062; ~10 days of margin
    'LTC:mainnet':  3143000,    // ARMED 2026-07-07 at tip 3138154; ~8 days
    'DOGE:mainnet': 6291000,    // ARMED 2026-07-07 at tip 6280094; ~7.5 days
    'BTC:testnet':  145000,     // ARMED 2026-07-07 at tip 143299
    'LTC:testnet':  4805000,    // ARMED 2026-07-07 at tip 4797675
    'DOGE:testnet': 67000000,   // ARMED 2026-07-07 at tip 66498605 (fast chain, wide margin)
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise the roots end to end
};

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
const CHECKPOINT_COMMITMENT_ACTIVATION = {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
};

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
const ANCHOR_REWARD_ACTIVATION = {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
};

// ANCHOR_REWARD_AMOUNT: the frozen validator anchor-publish reward, signed into the XANCPUB attestation
// by the hub and re-derived by the indexer (never from the wire). Changing it is itself a flag-day.
const ANCHOR_REWARD_AMOUNT = '10.00000000';

// ARCHIVE_REWARD_ACTIVATION (archive-reward re-derivation, ): the flag-day at/above which the
// anchor_archive reward stops riding the key-authenticated `pushvalidatorrewards` rail and is instead
// DERIVED by every indexer from the on-chain ANCHOR v6 bytes (the v1 archive anchor plus the same
// PUBLISHER + 2f+1 XANCPUB attestation tail as v4/v5, attested over an 'anchor_archive' canonical
// keyed on MATCH_BATCH_SEQ). This retires the last insider-with-key reward-forge surface the
// per-chain ANCHOR_REWARD flag-day left open. Below the flag-day the legacy v1 + push path stands
// and v6 anchors are rejected. Consensus-relevant, same deploy rules and snapshot_block gating as
// ANCHOR_REWARD_ACTIVATION; kept byte-identical to the local copies in
// xchain-{hub,indexer}/src/anchor_reward_activation.js by the cross-service regression suite.
const ARCHIVE_REWARD_ACTIVATION = {
    mainnet: 969500,      // ARMED 2026-07-16 : BTC snapshot_block ~2026-10-01 (ratified anchor; derived from tip 957062 on 07-07 at ~144 blocks/day); deploy every consumer before this era
    testnet: 0,
    regtest: 0,
};

// ARCHIVE_REWARD_AMOUNT: the frozen archive-publish reward, signed into the archive XANCPUB
// attestation by the hub and re-derived by the indexer (never from the wire). Kept equal to the
// hub's historical default (ANCHOR_REWARD_PER_PUBLISH). Changing it is itself a flag-day.
const ARCHIVE_REWARD_AMOUNT = '10.00000000';

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
const CROSS_CHAIN_ROYALTY_ACTIVATION = {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers before this height
    testnet: 0,
    regtest: 0,
};

// VALID_FIAT_CODES: the accepted FIAT_CODE allow-list for PRICE actions. The indexer's
// config['FIATS'] keys (xchain-indexer/src/config.js) are the on-chain arbiter; this list
// mirrors them in the indexer's insertion order. The SDK validator (VALID_FIAT_CODES) must
// be a byte-equal allow-list so it never refuses a FIAT the protocol accepts (it previously
// drifted, missing EUR and KRW). The cross-service parity test asserts SDK === this list.
const VALID_FIAT_CODES = ['USD', 'CAD', 'AUD', 'MXN', 'GBP', 'JPY', 'CNY', 'CHF', 'BRL', 'INR', 'EUR', 'KRW'];

// GAS_TICK: the protocol gas token's TICK. The indexer's config['GAS']
// (xchain-indexer/src/config.js) is the on-chain arbiter: it names the token
// debited for capability STAKE, VOTE deposits/escrows, contract gas billing,
// and every other gas-denominated flow. The SDK co-signer policy engine keys
// capability-STAKE spending caps to this tick (STAKE v1/v2 carry no TICK
// field). The cross-service parity test asserts indexer === SDK === this value.
const GAS_TICK = 'XCHAIN';

// ── Oracle federation (xchain-hub) ───────────────────────────────────────────
// Canonical source: xchain-hub/src/constants.js. Mirrored here byte-identical,
// same as XCALL_MAX_HOPS above, so a hub-side edit or a consumer re-declaring
// either literal has a cross-repo tripwire.

// Coarse global sanity ceiling on an ingested price_snapshots value (pre-scale,
// covers pairs like BTC/KRW up to ~$7M BTC with headroom); rejects
// parse-overflow / misplaced-decimal garbage. Per-pair outliers are caught by
// the co-sign deviation gate and multi-submitter aggregation, not here.
const PRICE_MAX = 10_000_000_000;

// Co-sign deviation band for the oracle PREPARE content-validation gate: a
// follower refuses to co-sign a proposed price that deviates more than this
// fraction from its own local aggregate for the pair. MUST be
// federation-uniform: if hubs used different bands, identical aggregates
// could yield different accept/withhold decisions (a liveness divergence on
// the ±band boundary). 0.05 = 5%.
const ORACLE_DEVIATION_THRESHOLD = 0.05;

module.exports = {
    MAX_ACTION_DATA_LENGTH,
    OP_RETURN_PUSH_OVERHEAD,
    MAX_CODE_SIZE,
    MAX_DEPLOY_CHUNKS,
    MAX_DEPLOYCHUNK_PART_BYTES,
    VM_MAX_CALL_DEPTH,
    VM_MIN_CALL_GAS,
    XCALL_MIN_GAS,
    XCALL_MAX_GAS,
    XCALL_MAX_HOPS,
    XCALL_MIN_DEADLINE_BLOCKS,
    XCALL_MAX_DEADLINE_BLOCKS,
    XCALL_MAX_RETURN_BYTES,
    XCALL_MAX_CALLS_PER_BLOCK,
    STAKE_WEIGHTED_QUORUM_ACTIVATION,
    EQUIV_HEADER_ACTIVATION,
    STATE_COMMITMENT_ACTIVATION,
    CHECKPOINT_COMMITMENT_ACTIVATION,
    ANCHOR_REWARD_ACTIVATION,
    ANCHOR_REWARD_AMOUNT,
    ARCHIVE_REWARD_ACTIVATION,
    ARCHIVE_REWARD_AMOUNT,
    CROSS_CHAIN_ROYALTY_ACTIVATION,
    VALID_FIAT_CODES,
    GAS_TICK,
    PRICE_MAX,
    ORACLE_DEVIATION_THRESHOLD,
};
