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
 * The SHARED block, part 2 of 5: attest_responsible_widening_activation to rollcall_activation
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
// attest_responsible_widening_activation (continued)
// STAGE 2, selected by ATTEST_ZERO_CONF_ACTIVATION on the request block (LOCAL COPY,
// parity-tested). Two things change and one does not:
//
//   startOffset 0: the ladder starts AT the request block, where the hub now starts its
//   own leader and model ladders. It is named startOffset rather than confirmations because
//   it is a ladder-start offset and the hub's ATTESTATION_CONFIRMATIONS is a different knob.
//
//   headroom 1: one extra slot from step 0, before any segment has elapsed. The failure
//   this exists for, measured on testnet, is one member that can never sign: an old key seated in 1
//   of 7 slots stalls every 3-of-7 draw that includes it at 2 of 3 until the ladder opens,
//   a third of the deadline window later. Headroom makes such a round finalize inside the
//   first segment with no clock at all, and keeps the assignment deterministic. The
//   assigned set (the persisted RESPONSIBLE_SET_JSON, the missed_count charge) is still
//   the unwidened slice: headroom widens who may EARN, never who is CHARGED.
//
//   maxSlots 2 is kept, so the set can reach redundancy + 3: headroom plus two ladder
//   steps for two dead members.
addGate('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING_V2', 'constant', {
    startOffset: 0,
    headroom:    1,
    maxSlots:    2,
});

// attest_zero_conf_activation
// Per-network activation height (LOCAL COPY, parity-tested). Compared against
// the ATTEST v0 request's own BTC block_index.
addGate('attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION', 'height', {
    mainnet: null,        // INERT: operator-owned height, unratified. Ratified only after the mirror arms there.
    testnet: 151800,      // SIZED 2026-09-08 (tip 151483 at 07:32Z, about 5 blocks/h): above the 151324 mirror floor and past the v0.16.0 indexer-then-hub roll; keyed on the request block.
    regtest: 0,           // ARMED at genesis so the e2e mirror venue exercises the flip
});

// checkpoint_commitment_activation
// Per-network activation height, interpreted as the BTC-anchored snapshot_block
// carried by the checkpoint/ANCHOR canonical (NOT the local processing height), so
// every chain + the hub flip the signed shape on the same anchor.
addGate('checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 146000,      // ARMED 2026-07-22: first BTC-testnet anchor past all three STATE_COMMITMENT testnet thresholds; was 0, which forced the SPV root suffix from testnet genesis before the indexer computes roots, so the hub refused to sign every testnet checkpoint
    regtest: 0,
});

// cross_chain_royalty_activation
// Per-network activation height, interpreted as the BTC-anchored snapshot_block
// carried by the XMATCH canonical (NOT the local processing height), so every
// chain + the hub flip the match format on the same anchor.
addGate('cross_chain_royalty_activation.CROSS_CHAIN_ROYALTY_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers before this height
    testnet: 0,
    regtest: 0,
});

// equivocation_header
// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js, kept equal by the cross-service
// regression suite). Keyed on the BTC-anchored snapshot_block, NOT the local
// processing height, so every chain + the hub flip on the same anchor.
addGate('equivocation_header.EQUIV_HEADER_ACTIVATION', 'height', {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
});

// Fixed per-engine tag (spec §4.1.1). One slashable canonical family per engine.
addGate('equivocation_header.ENGINE_TAGS', 'constant', {
    DEX:        'XDEX',
    XCALL:      'XCALL',
    ATTEST:     'XATTEST',
    ORACLE:     'XORACLE',
    // PRICE batches. A DISTINCT tag from ORACLE, not a reuse: a batch canonical
    // carries first_round/last_round and no scalar `round`, and SLASH v0 reads
    // `round` out of an ORACLE-tagged content to judge equivocation, skipping its
    // distinct-rounds guard when either side lacks one. Under a shared tag an
    // honest validator that signed one per-round consensus canonical and one batch
    // at the same BTC anchor would be provably equivocating, for a full bond burn plus permanent
    // capability disqualification. The batch ROUND_ID is
    // `<anchor>|<first_round>|<last_round>` (pipes are safe here; equivKey treats
    // the round id as opaque), so two honest batches that split one window
    // differently do not collide on one key either.
    ORACLE_BATCH: 'XORACLEB',
    CHECKPOINT: 'XCHECKPOINT',
    CONFIG:     'XCONFIG',
    NODEPROOF:  'XNODEPROOF',
    // ROLLCALL presence proofs. Namespacing ONLY, exactly like XNODEPROOF: the
    // tag is deliberately absent from SLASH's ENGINE_CAPABILITY map, so no
    // ROLLCALL canonical is a slashable family. Several valid ROLLCALLs per
    // epoch are expected (a leader's, sweepers', self-publishes), every one
    // carrying signatures over the SAME canonical for that epoch, so two of
    // them are never conflicting content for one key. ROUND_ID is the BTC
    // EPOCH_HEIGHT in decimal, VIEW is 0.
    ROLLCALL:   'XROLLCALL',
    // Cross-chain bridge transfer records. ROUND_ID is the transfer_id, VIEW is the live
    // PBFT view on the hub and the row's finalizing_view on an indexer. Mapped to the
    // cross_chain capability in SLASH's ENGINE_CAPABILITY: a forged transfer record directs
    // value, so two conflicting canonicals for one transfer_id must be slashable.
    BRIDGE:     'XBRIDGE',
    // Per-token policy snapshots (allow list, block list, sleep) carried from an origin row
    // to every bridged copy. A DISTINCT tag from BRIDGE, not a reuse: the two canonicals
    // share no field layout, and SLASH judges equivocation within one tag family, so one tag
    // over both would make a validator that signed one transfer and one snapshot at the same
    // round id provably equivocating. ROUND_ID is the snapshot_id.
    POLICY:     'XPOLICY',
});

// list_edit_resolution_activation
// Per-chain activation heights, interpreted against the chain's own
// block_index. Pinned to the same pre-freeze activation train as
// BET_STATUS_STATE_HASH_ACTIVATION in stateHash.js: BET members-only markets
// are the loudest consumer of a mutable list, so the two flip together and
// operators reason about one boundary. RE-PINNED 2026-07-27 against live tips
// in lockstep with that map. These two maps must stay equal value for value;
// the explorer vendors this one byte-identically behind a guard test. CONFIRM
// again at train assembly: they are only as good as the day measured.
addGate('list_edit_resolution_activation.LIST_EDIT_RESOLUTION_ACTIVATION', 'height', {
    'BTC:mainnet':  963000,   // tip 959,853 (2026-07-27) + 21d @144/day = 962,877
    'LTC:mainnet':  3162000,   // tip 3,149,481 + 21d @576/day = 3,161,577
    'DOGE:mainnet': 6338000,   // tip 6,307,307 + 21d @1440/day = 6,337,547
    // Testnet is genesis-active as of the 2026-08-10 fresh testnet genesis: the
    // chain restarts at firstBlock (BTC 147500 / LTC 4855000 / DOGE 67815000) with
    // no pre-rule history to preserve. Kept value-equal to
    // CARET_REF_STRICT_ACTIVATION and BET_STATUS_STATE_HASH_ACTIVATION, which CI
    // asserts, so all three moved in this one change.
    'BTC:testnet':  0,
    'LTC:testnet':  0,
    'DOGE:testnet': 0,
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise list edits end to end
});

// mirror_admission_activation
// How far ahead of the producer's observed admission tip a row is stamped, in BLOCKS of each
// chain in its map. Not a new number: producers already size their forward margin as 4 blocks
// of the gating chain and then CONVERT it to seconds. On the admission axis the conversion is
// deleted, which is why an unknown chain needs no nominal block interval here at all.
addGate('mirror_admission_activation.ADMIT_MARGIN_BLOCKS', 'constant', {
    default:                      4,
    attestation_responses:        1,    // their 120 s forward margin was chosen to be as SHORT as propagation allows
    oracle_prices:                1,    // effective_at stays the economic filter; admission is what the barrier certifies
    anchor_reward_attestations: 144,    // the existing ANCHOR_REWARD_MIRROR_MATURITY, already frozen fleet-wide
});

// A row may never be admissible at a block that already exists, or a producer could backdate
// a row into a block its peers have already committed.
addGate('mirror_admission_activation.ADMIT_MIN_FUTURE_BLOCKS', 'constant', 1);

// The follower's upper bound, PER CHAIN, sized so each chain's height window spans the same
// 3600 s the existing absolute effective_time ceiling already allows: ceil(3600 / interval).
//
// A flat block count here would be a silent tightening. Six blocks is an hour on BTC but six
// minutes on DOGE, so a flat [tip + 1, tip + 6] would collapse clock-skew tolerance from
// 3600 s to 360 s on DOGE and refuse honest rows between hubs whose tips differ by three blocks.
addGate('mirror_admission_activation.ADMIT_MAX_FUTURE_BLOCKS', 'constant', {
    BTC:      6,
    LTC:     24,
    DOGE:    60,
    default:  6,
});

/*
 * TWO maps, one module, with an ordering rule that is the whole point: every PRODUCER height is
 * sized strictly BELOW its CONSUMER height for the same key, so no row is ever produced legacy
 * and read modern. Get that backwards and a consumer above its height reads an admission column
 * the producer below its own height never wrote, and binds nothing.
 *
 * Keyed by (coin, network), not by network alone. A single per-network height cannot arm a
 * family that binds on every chain: one number is an LTC height on an LTC indexer and a BTC
 * height on a BTC indexer, so the two legs of one cross-chain match would cross the flag day at
 * unrelated instants. The 'COIN:network' key shape is established precedent.
 *
 * Mainnet is null under the 2026-08-29 write hold. TESTNET SIZED 2026-09-16 20:41Z, LTC and DOGE
 * RE-CUT 2026-09-17 22:45Z onto the BTC instant after their cadences drifted off it; the measured
 * tips, the formula, the cadence-window rule, the epoch-close rule and the per-chain re-size rule
 * are written once in the canon (xchain-documentation/protocol/constants.js), which this row is
 * held value-identical to. The v7 HUB_SCHEMA_VERSION roll completes BEFORE any of these heights:
 * the heights map rides frames carrying no schema_version, so a v7 indexer above the activation
 * against a v6 hub would see no heights at all and defer forever under the fail-closed rule.
 */
addGate('mirror_admission_activation.MIRROR_ADMISSION_ACTIVATION', 'height', {
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  153300,      // RE-SLID 2026-09-19: train 153,221 + 79 blocks (17 h at 781.078553 s/blk), the v0.20.1 patch reslide
    'LTC:testnet':  null,        // dq4 (a), 2026-09-18: LTC:testnet mirror admission ships null on this train; arms on a later train
    'DOGE:testnet': 67916857,    // RE-SLID 2026-09-19: tip 67,911,061 + 5796 blocks (41 h at 25.469118 s/blk, the same instant as the BTC producer), the v0.20.1 patch reslide
    'BTC:regtest':  UNPINNED,   // ARMS by XC_MIRROR_ADMISSION_ACTIVATION at registration
    'LTC:regtest':  UNPINNED,   // ARMS by XC_MIRROR_ADMISSION_ACTIVATION at registration
    'DOGE:regtest': UNPINNED,   // ARMS by XC_MIRROR_ADMISSION_ACTIVATION at registration
});

addGate('mirror_admission_activation.MIRROR_ADMISSION_CONSUMER_ACTIVATION', 'height', {
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  153328,      // RE-SLID 2026-09-19: its producer + 28 blocks (6 h at 781.078553 s/blk), strictly above, never equal
    'LTC:testnet':  null,        // dq4 (a), 2026-09-18: LTC:testnet mirror admission ships null on this train; arms on a later train
    'DOGE:testnet': 67917706,    // RE-SLID 2026-09-19: its producer + 849 blocks (6 h at 25.469118 s/blk)
    'BTC:regtest':  UNPINNED,   // ARMS by XC_MIRROR_ADMISSION_ACTIVATION at registration
    'LTC:regtest':  UNPINNED,   // ARMS by XC_MIRROR_ADMISSION_ACTIVATION at registration
    'DOGE:regtest': UNPINNED,   // ARMS by XC_MIRROR_ADMISSION_ACTIVATION at registration
});

addGate('mirror_admission_activation.MIRROR_ADMISSION_REGTEST_ENV', 'constant', 'XC_MIRROR_ADMISSION_ACTIVATION');

addGate('mirror_admission_activation.MIRROR_ADMISSION_REGTEST_ARMED_HEIGHT', 'constant', 0);

// A chain code is a closed vocabulary: upper-case letters and digits, nothing else. The
// injectivity argument rests on that, so the check lives here and not only in a test.
addGate('mirror_admission_activation.CHAIN_CODE_RE', 'constant', /^[A-Z0-9]{1,10}$/);

// Canonical base-10 spelling of a non-negative integer: digits only, no sign, no leading
// zeros. The rule the hub's lib/canonical_int.js applies to its other signed integers,
// restricted to non-negative because a height never is.
addGate('mirror_admission_activation.CANONICAL_HEIGHT_RE', 'constant', /^(?:0|[1-9][0-9]*)$/);

// One nullable BIGINT UNSIGNED column per chain the federation serves (C28), spelled
// `admit_block_<code lower-cased>` in every mirror table's DDL. The hub writes them at
// finalization and every mirror client reads them back to rebuild the signed field, so the
// list lives in the twin rather than on one side: a chain the hub writes and an indexer does
// not read back is a row every indexer refuses (the rebuilt field misses a chain and no
// signature verifies), fail-closed but still an outage. Adding a chain adds it here and in
// the mirror .sql twins; it does NOT make rows signed before that chain existed admissible
// on it (C38), which is why the map is read from the columns actually set and never from
// this list.
addGate('mirror_admission_activation.ADMIT_COLUMN_CHAINS', 'constant', ['BTC', 'LTC', 'DOGE']);

// price_batching_floor_activation
// Per-network pre-batch era floor, as a unix-second block time. 0 (or an
// absent/unknown network) means the barrier applies at every block. A
// '<COIN>:<network>' key wins over the bare network key, so one chain's rail
// start can differ from its siblings' without splitting the map.
addGate('price_batching_floor_activation.PRICE_BATCHING_FLOOR_ACTIVATION', 'time', {
    mainnet: 0,
    testnet: 0,
    regtest: 0,
});

// price_pair_activation
// Ticker-side bounds either side of the gate (LOCAL COPY, see header).
addGate('price_pair_activation.PRICE_PAIR_TICKER_MAX_LEGACY', 'constant', 5);

addGate('price_pair_activation.PRICE_PAIR_TICKER_MAX_WIDE', 'constant', 6);

// Per-network activation TIME (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js). Keyed on the action's own block time.
//
// ARMED at genesis on every network. Mainnet was ruled on 2026-09-09: no PRICE action has
// ever been indexed on any mainnet chain (measured 2026-09-09), so the widened ticker bound
// reinterprets nothing and the from-genesis OLD-vs-ON replay is the witness. Arming at 0
// rather than at a launch instant is what keeps LTC/DOGE native-coin fees payable from the
// first mainnet block that carries one; the contract-era stamp 1786060800 (2026-08-07)
// would have left them unpayable up to that instant.
addGate('price_pair_activation.PRICE_PAIR_WIDEN_ACTIVATION', 'time', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 PRICE actions, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
});

// Pre-built per-bound matchers. Anchored, uppercase-only, and without the /g flag
// so .test() carries no lastIndex state between calls.
// {3,5}: PRICE_PAIR_TICKER_MAX_LEGACY wide; the two move together.
addGate('price_pair_activation.PRICE_PAIR_RE_LEGACY', 'constant', /^[A-Z]{3,5}\/[A-Z]{3,5}$/);

// {3,6}: PRICE_PAIR_TICKER_MAX_WIDE wide; the two move together.
addGate('price_pair_activation.PRICE_PAIR_RE_WIDE', 'constant', /^[A-Z]{3,6}\/[A-Z]{3,5}$/);

// price_scale_activation
// Decimal-side bound in force at/above the gate. The producers' bcformat width.
addGate('price_scale_activation.PRICE_SCALE_MAX_DECIMALS', 'constant', 8);

// Per-network activation TIME, keyed on the action's own block time.
//
// ARMED at genesis on every network, mainnet by the 2026-09-09 ruling on the measurement
// the header records (0 PRICE actions ever indexed on any mainnet chain).
addGate('price_scale_activation.PRICE_SCALE_ACTIVATION', 'time', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 PRICE actions, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
});

// The two price-value matchers. Anchored and without the /g flag so .test()
// carries no lastIndex state between calls.
//
// LEGACY is byte-for-byte the pattern both v0 ingest sites carry today; it is
// what keeps a below-gate replay identical, so it is never "tidied".
addGate('price_scale_activation.PRICE_VALUE_RE_LEGACY', 'constant', /^[0-9]+(\.[0-9]+)?$/);

// {1,8}: PRICE_SCALE_MAX_DECIMALS wide; the two move together.
addGate('price_scale_activation.PRICE_VALUE_RE_CANONICAL', 'constant', /^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/);

// price_sig_tally_activation
// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js). Keyed on the round's BTC-anchored
// BTC_BLOCK_HEIGHT, NOT the landing chain's local height, so the hub and the BTC,
// LTC and DOGE indexers all flip on the same anchor.
//
// mainnet is ARMED to 963000, the one BTC-height boundary a whole family of
// cross-chain-verdict gates now shares (retraction signing, archive reward,
// attest relay and the hub's governance snapshot), so operators reason about
// one boundary rather than five. That cohort was RE-PINNED 2026-08-12 off an
// earlier 969500 pin: 969500 was derived alongside a TIME anchor that has since
// been repinned twice and now sits at 1786060800 (2026-08-07), which left the
// height half ~8 weeks behind the time half of the same ratified flag-day set.
// 963000 is the pre-freeze train boundary already armed for BTC:mainnet in stateHash.js,
// caret_ref_strict_activation.js and list_edit_resolution_activation.js (tip
// 959,853 on 2026-07-27 at ~144 blocks/day + 21 days), so this reuses a ratified
// boundary rather than minting a new one. Deliberately NOT the nearer 961000
// anchor, whose train shipped 2026-07-23 and whose BTC anchor (~2026-08-04) has
// already passed: a height in the past is not a flag day at all. 963000 leaves
// the usual "deploy every consumer before this era" runway.
//
// testnet/regtest activate at genesis (same convention as
// STAKE_WEIGHTED_QUORUM_ACTIVATION and ATTEST_ADMISSION_ACTIVATION, which are
// also verdict-changing): the test venues run the corrected tally from block 0.
addGate('price_sig_tally_activation.PRICE_SIG_TALLY_ACTIVATION', 'height', {
    mainnet: 963000,      // ARMED, RE-PINNED 2026-08-12 off 969500 onto the shared pre-freeze train boundary; deploy ALL indexers + hubs before this height
    testnet: 0,
    regtest: 0,
});

// retraction_signing_activation
// Per-network activation, interpreted as a BTC-anchored snapshot_block era.
addGate('retraction_signing_activation.RETRACTION_SIGNING_ACTIVATION', 'height', {
    mainnet: 963000,      // ARMED 2026-07-16, RE-PINNED 2026-08-12 off 969500 onto the shared pre-freeze train boundary (tip 959,853 on 07-27 at ~144 blocks/day + 21d); deploy every consumer before this era
    testnet: 0,
    regtest: 0,
});

// rollcall_activation
// Per-network BTC height at/above which ROLLCALL epochs exist at all.
// MAINNET ARMS AT 0 by the 2026-09-09 ruling: eviction can only reinterpret a chain that
// has validators to evict, and mainnet carries 0 validators, 0 stakes and 0 roll-calls
// (measured 2026-09-09), so every epoch below the tip closes empty and the from-genesis
// OLD-vs-ON replay per chain is the witness. null is still a legitimate value here (regtest
// holds it until the venue opts in), so every read MUST go through the Number.isFinite
// guard below: a bare `height >= ROLLCALL_ACTIVATION[network]` would arm a null network at
// height 0, since `0 >= null` is true in JS.
addGate('rollcall_activation.ROLLCALL_ACTIVATION', 'epoch', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 validators, 0 stakes, 0 roll-calls, measured 2026-09-09)
    testnet: 151200,      // 1008 x 150 = 144 x 1050; tip was 150400 on 2026-08-30, ~5.5 days out
    regtest: UNPINNED,   // ARMS AT 0 when the venue sets XC_ROLLCALL_REGTEST_ACTIVATION
});

// The documented regtest arming height: genesis. It is a multiple of the
// 30-block regtest interval, so epoch 0 is a real epoch and the first close is
// not skipped. This is the height a regtest venue arms AT, not a height it is
// armed at by default -- see resolveRegtestActivation for why the default is
// inert and how a venue opts in.
addGate('rollcall_activation.ROLLCALL_REGTEST_ARMED_HEIGHT', 'constant', 0);

// The one environment variable this module reads, and only ever for regtest.
addGate('rollcall_activation.ROLLCALL_REGTEST_ENV', 'constant', 'XC_ROLLCALL_REGTEST_ACTIVATION');

// Epoch cadence in BTC blocks. Weekly on the live networks per the 2026-08-30
// ruling: with K=2 an outage shorter than one epoch minus the accept window
// (~6 days) can never evict, and 2-3 weeks idle always does. Regtest uses 30 so
// an acceptance run does not have to mine 2 x 1008 blocks.
addGate('rollcall_activation.ROLLCALL_INTERVAL_BLOCKS', 'constant', { mainnet: 1008, testnet: 1008, regtest: 30 });

// How long after the epoch block a signature may still land, in BTC blocks. The
// BTC header stamp at E + this value is what cuts the DOGE chain (see
// rollcallWindowEndHeight / the epoch close).
addGate('rollcall_activation.ROLLCALL_ACCEPT_WINDOW_BLOCKS', 'constant', { mainnet: 144, testnet: 144, regtest: 12 });
// SHARED-GATES END
