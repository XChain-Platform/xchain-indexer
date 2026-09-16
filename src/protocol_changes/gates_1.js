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
 * Indexer-only registry rows, part 1 of 3: amount_representability_activation to dispenser_send_amount_compare_activation
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

// amount_representability_activation
// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']).
addGate('amount_representability_activation.AMOUNT_REPRESENTABILITY_ACTIVATION', 'time', {
    mainnet: 9999999999,    // UNARMED (house sentinel, year 2286): mainnet writes are held
    testnet: 9999999999,    // UNARMED (house sentinel): live launched history, arm needs a measured replay witness
    regtest: 0,
});

// Integer capacity of DECIMAL(60,18), the widest scale the consensus
// aggregations cast to. See the WHY 42 INTEGER DIGITS note above.
addGate('amount_representability_activation.AMOUNT_MAX_INTEGER_DIGITS', 'constant', 42);

// anchor_activation
// ANCHOR_ACTIVATION: the DOGE height (per network) at/above which the ANCHOR wire set restarts at
// version 0 (v0 = the per-network checkpoint bundle, v1 = the archive head with its publisher tail,
// v2 = the archive continuation chunk). Every ANCHOR mined BELOW this height, of any version, is
// invalid ('invalid: ANCHOR before activation'); at/above it only versions 0/1/2 parse and every
// other version byte is 'invalid: VERSION (unknown)'. Keyed on the action's OWN DOGE block_index
// (data['BLOCK_INDEX'] at parse time, anchor_actions.block_index_doge), never on SNAPSHOT_BLOCK or
// the checkpointed height: the row being judged is the anchor itself. Mainnet 6360000 sits ABOVE
// the chain tip on purpose: the restarted wire set has NOT activated on mainnet yet, and the height
// is a flag day the operator arms deliberately rather than one that silently already passed.
// Testnet 67858600 is 24 blocks above its last pre-restart anchor (67858576) and is already past.
// Neither is 0, because both carry pre-restart history (mainnet 56 rows, testnet 11, measured
// 2026-08-30): at 0 the gate can never fire, so the retired wires fall through to the restarted
// version table and are read as shapes they are not. The old per-chain version 0 would report as a
// checkpoint bundle carrying SPV roots and a publisher attestation, and the old tail-less version 1
// as an archive head with a publisher tail; on mainnet those rows carry state_root NULL 36/36 and
// no publisher_attestations field at all 56/56. Regtest is 0: its stacks are rebuilt from genesis.
// Operator rulings 2026-08-30.
addGate('anchor_activation.ANCHOR_ACTIVATION', 'height', {
    mainnet: 6360000,
    testnet: 67858600,
    regtest: 0,
});

// archive_batch_author_activation
// Per-network activation, interpreted against the DOGE block_index of the batch's
// canonical archive head. Every network is armed from genesis, so all three run the
// publisher-scoped rule end to end.
addGate('archive_batch_author_activation.ARCHIVE_BATCH_AUTHOR_ACTIVATION', 'height', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 archive chunks, measured 2026-09-09)
    testnet: 0,           // ARMED at genesis 2026-08-14 per the 2026-08-11 operator ruling; the re-genesised testnet has no pre-flag history to keep byte-identical
    regtest: 0,           // armed from genesis
});

// archive_head_unverified_gate_activation
// Per-network activation, interpreted against the DOGE block_index the v1
// archive head landed in. Every network is armed from genesis. Changing any value
// here is a consensus change: read the header block first.
addGate('archive_head_unverified_gate_activation.ARCHIVE_HEAD_UNVERIFIED_GATE_ACTIVATION', 'height', {
    // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history
    // (0 archive chunks, measured 2026-09-09). Pinned at genesis in the same wave as the
    // class-6 height-key repair, which this key is never moved apart from.
    mainnet: 0,
    // Armed from genesis. Safe on a chain with history ONLY where that chain's indexer
    // state is rebuilt from the chain itself, because a rebuild recomputes every block
    // under this rule and so leaves nothing indexed under the narrower one to contradict.
    // That rebuild is a precondition of this height, not a consequence of it.
    testnet: 0,
    regtest: 0,           // armed from genesis: fresh regtest stacks exercise the widened gate end to end
});

// attest_admission_activation
// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js). Compared against the request's own
// LOCAL block_index on its own chain (see the ACTIVATION PLANE note above), which
// is the block the responsible set is computed at.
addGate('attest_admission_activation.ATTEST_ADMISSION_ACTIVATION', 'height', {
    // The VALUE is a BTC height; the COMPARISON is per-chain local. Numerically equal
    // to the STAKE_WEIGHTED_QUORUM anchor, but that gate resolves it on the
    // BTC-anchored snapshot_block plane, so the two do not flip together off BTC.
    mainnet: 961000,      // ARMED: BTC anchor ~2026-08-04; already satisfied on LTC/DOGE local heights; deploy ALL indexers before this height
    testnet: 0,
    regtest: 0,
});

// attest_broadcast_fee_activation
// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js). Compared against the LOCAL block_index
// of the SETTLING action (the ATTEST v1 response, or the v4 relay response), which is
// the block whose oracle price the conversion reads and the block the reward rows are
// stamped with.
// TESTNET ARMED AT 0, operator-ratified 2026-08-18 under the standing ruling that every
// platform feature must be ACTIVE on testnet, so nothing is found dormant after release.
// Safe for the same MEASURED reason as ATTEST_REQUEST_CAP_ACTIVATION rather than by
// assumption: this gate only changes how a fulfilled ATTEST settle splits its escrow, and
// the live explorer reports `total: 0` attestation rows EVER recorded on BTC, LTC and DOGE
// testnet alike (/{TBTC,TLTC,TDOGE}/api/attestations, checked 2026-08-18). No settle has
// ever happened on testnet, so there is no reward split to reinterpret and replay stays
// byte-identical. MAINNET was measured the same way on 2026-09-09 and armed at genesis by
// that day's ruling: 0 attestation rows on BTC, LTC and DOGE mainnet, so no settle exists
// there either and a from-genesis replay is the witness.
addGate('attest_broadcast_fee_activation.ATTEST_BROADCAST_FEE_ACTIVATION', 'height', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 attestations, measured 2026-09-09)
    testnet: 0,           // ARMED at genesis (operator-ratified 2026-08-18; zero historical attestation settles, so nothing is reinterpreted)
    regtest: 0,           // ARMED at genesis on regtest so the e2e venue exercises the carve-out
});

// Per-provider broadcast-fee allowance, denominated in NATIVE coin (whole coins, not
// satoshis), LOCAL COPY of the canonical map in xchain-documentation/protocol/constants.js.
//
// PROVIDERS holds the shipped per-provider default. DEFAULT covers a provider an
// operator registered through an ATTESTATION.PROVIDERS overlay that this map does not
// name. HARD_MAX is the ceiling every resolved value is clamped to, including one an
// overlay supplied, which is what keeps the bound consensus-visible rather than
// operator-controlled.
//
// SIZING. A BTC ATTEST v1 carrying a small response is a few hundred to a few thousand
// satoshis of miner fee at ordinary congestion. 0.0001 BTC (10,000 sat) covers that with
// room and still costs a fraction of a normal request fee, which is what "conservative"
// means here: the allowance is paid FLAT (see the header, decision 1), so an over-sized
// default would systematically overpay the leader out of the author's escrow. The llm
// provider carries the same figure; its responses are capped SMALLER than http_get's
// (16KB vs 32KB), so it has no case for a wider allowance.
//
// These values are consensus-visible the moment the gate arms, so a change to any of
// them needs its own flag-day exactly as the height does.
addGate('attest_broadcast_fee_activation.ATTEST_BROADCAST_FEE_CAP', 'constant', {
    DEFAULT:  '0.00010000',
    HARD_MAX: '0.00100000',
    PROVIDERS: {
        http_get: '0.00010000',
        llm:      '0.00010000',
    },
});

// attest_request_cap_activation
// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js). Compared against the request's own
// LOCAL block_index on its own chain.
addGate('attest_request_cap_activation.ATTEST_REQUEST_CAP_ACTIVATION', 'height', {
    mainnet: 0,           // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 attestations, measured 2026-09-09)
    testnet: 0,           // ARMED at genesis (operator-ratified 2026-08-18; zero historical attestations, so nothing is reinterpreted)
    regtest: 0,           // ARMED at genesis so the e2e venue exercises the cap
});

// The cap VALUES; the map above decides WHEN they apply (LOCAL COPY, parity-tested).
//
// perContract bounds one contract's share of a block, so a single busy (or hostile)
// contract cannot take the whole ceiling and starve every other contract's requests.
// perBlock bounds the network-wide total, which is the number that actually bounds
// validator spend: with REDUNDANCY 3 and BTC's ~144 blocks/day, a full-but-legal
// 10/block admits ~1440 requests/day, i.e. ~4320 provider calls/day spread across the
// responsible sets - a bounded, forecastable bill instead of a mempool-limited one.
//
// Sized to be invisible to legitimate use: a contract firing more than 2 attestations
// in a single block is a batch pattern that can space itself across blocks, and 10
// admitted requests in one block is far above any observed rate on any network today.
addGate('attest_request_cap_activation.ATTEST_REQUEST_CAPS', 'constant', {
    perContract: 2,
    perBlock:    10,
});

// attestation/providerMinStakeHistory
// Frozen block-anchored governance min_stake_xchain history, per network, per
// provider: an ascending list of { activation_block, value } entries, each the
// floor EFFECTIVE FROM that block until the next entry. Mirrors the shape of
// xchain-hub ProviderRegistry.providerConfigHistory (whose entries carry
// min_stake_xchain alongside additional_config) and of MIN_STAKE_ACTIVATIONS
// in capability_min_stake_history.js.
//
// EMPTY on every network. See the header before adding an entry: it is a
// consensus flag day, not config.
addGate('attestation/providerMinStakeHistory.PROVIDER_MIN_STAKE_ACTIVATIONS', 'constant', {
    mainnet: {},
    testnet: {},
    regtest: {},
});

// capability_min_stake_history
// Frozen block-anchored governance MIN_STAKE history, per network, per capability:
// an ascending list of { activation_block, value } entries, each the threshold
// EFFECTIVE FROM that block until the next entry. Mirrors the shape of
// xchain-hub CapabilityRegistry.minStakeHistory.
//
// EMPTY on every network: no governance MIN_STAKE change has ever activated, so
// the threshold at every block is the genesis floor the caller supplies (the
// frozen coin-config constant the hub asserts its own value against at boot).
// See the header before adding an entry - it is a consensus flag day, not config.
addGate('capability_min_stake_history.MIN_STAKE_ACTIVATIONS', 'constant', {
    mainnet: {},
    testnet: {},
    regtest: {},
});

// caret_ref_strict_activation
// Per-chain activation heights, interpreted against the chain's own block_index.
// Pinned to the mainnet pre-freeze activation train, the SAME cohort and the same
// values as LIST_EDIT_RESOLUTION_ACTIVATION in list_edit_resolution_activation.js
// (which in turn rides BET_STATUS_STATE_HASH_ACTIVATION in stateHash.js): all three
// are execution-path validity changes on the same deploy train, so operators reason
// about one boundary rather than three. caret-ref-strict.test.js asserts this map is
// value-equal to that one, so a re-pin of the train has to move both or fail CI.
// CONFIRM again at train assembly: heights are only as good as the day measured.
addGate('caret_ref_strict_activation.CARET_REF_STRICT_ACTIVATION', 'height', {
    'BTC:mainnet':  963000,     // tip 959,853 (2026-07-27) + 21d @144/day = 962,877
    'LTC:mainnet':  3162000,    // tip 3,149,481 + 21d @576/day = 3,161,577
    'DOGE:mainnet': 6338000,    // tip 6,307,307 + 21d @1440/day = 6,337,547
    // Testnet is genesis-active as of the 2026-08-10 fresh testnet genesis: the
    // chain restarts at firstBlock (BTC 147500 / LTC 4855000 / DOGE 67815000) with
    // no pre-rule history to preserve, so a mid-chain boundary would gate nothing
    // and only risk a fleet-split at a height nobody needs.
    'BTC:testnet':  0,
    'LTC:testnet':  0,
    'DOGE:testnet': 0,
    regtest: 0,                 // armed from genesis: fresh regtest stacks exercise the reject end to end
});

// consolidation_leg_amount_activation
// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']).
addGate('consolidation_leg_amount_activation.CONSOLIDATION_LEG_AMOUNT_ACTIVATION', 'time', {
    mainnet: 0,             // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 SEND, 0 DESTROY, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
});

// dispense_cancelling_match_activation
// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']). Mainnet flips at the coordinated 2.0.0 contract-era
// flag-day; testnet/regtest are active from genesis, mirroring the 2.0.0
// protocol_changes cohort (testnet_time/regtest_time = 0).
addGate('dispense_cancelling_match_activation.DISPENSE_CANCELLING_MATCH_ACTIVATION', 'time', {
    mainnet: 1786060800,    // 2026-08-07 00:00:00 UTC - coordinated 2.0.0 flag-day; deploy ALL indexers before this time
    testnet: 0,
    regtest: 0,
});

// dispense_payment_tally_scale_activation
// Scale the tally is kept at once the rule is live. 18 is
// config.MAX_TOKEN_DECIMALS, the finest precision any tick can be issued with,
// and the scale ledger_amount_precision_activation and the balance projections
// already net in. Deliberately a local constant rather than an import: an edit
// to another gate's scale must not silently re-price blocks above this height.
addGate('dispense_payment_tally_scale_activation.DISPENSE_TALLY_EXACT_SCALE', 'constant', 18);

// The scale the tally has always used, and the scale a native-coin payment
// keeps. Also the render width of the dispenses row below.
addGate('dispense_payment_tally_scale_activation.DISPENSE_TALLY_LEGACY_SCALE', 'constant', 8);

// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']), matching the dispenser-family cohort.
addGate('dispense_payment_tally_scale_activation.DISPENSE_PAYMENT_TALLY_SCALE_ACTIVATION', 'time', {
    mainnet: 0,             // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 dispensers, 0 dispenses, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
});

// dispenser_amount_positivity_activation
// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']).
addGate('dispenser_amount_positivity_activation.DISPENSER_AMOUNT_POSITIVITY_ACTIVATION', 'time', {
    mainnet: 0,             // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 dispensers, 0 dispenses, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
});

// dispenser_caps_activation
// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']). Mainnet flips at the coordinated 2.0.0 contract-era
// flag-day; testnet/regtest are active from genesis, mirroring the 2.0.0
// protocol_changes cohort and the sibling dispenser-family activations.
addGate('dispenser_caps_activation.DISPENSER_CAPS_ACTIVATION', 'time', {
    mainnet: 1786060800,    // 2026-08-07 00:00:00 UTC - coordinated 2.0.0 flag-day; deploy ALL indexers before this time
    testnet: 0,
    regtest: 0,
});

// dispenser_freshness_activation
// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after the height the indexer-local freshness query governs;
// below it the legacy utxo-tracker getFirstSeen HTTP path runs. ARMED 2026-07-22
// at the ratified deploy-train heights; testnet + regtest genesis-active
// (pre-launch).
addGate('dispenser_freshness_activation.DISPENSER_FRESHNESS_ACTIVATION', 'height', {
    'BTC:mainnet':  961000,
    'LTC:mainnet':  3154250,
    'DOGE:mainnet': 6319000,
    testnet: 0,
    regtest: 0,
});

// dispenser_freshness_shape_activation
// Per-chain activation height, interpreted as the processing chain's OWN
// block_index. At/after the height a shape-violating non-null get_first_seen
// result throws; below it the legacy fail-open null is returned.
addGate('dispenser_freshness_shape_activation.DISPENSER_FRESHNESS_SHAPE_ACTIVATION', 'height', {
    'BTC:mainnet':  null,   // UNARMED: operator-owned, sized below 961000 on the arming train
    'LTC:mainnet':  null,   // UNARMED: operator-owned, sized below 3154250 on the arming train
    'DOGE:mainnet': null,   // UNARMED: operator-owned, sized below 6319000 on the arming train
    mainnet:        null,   // UNARMED: a coin with no entry above inherits the inert posture
    testnet:        0,      // genesis-active: the tracker path is unreachable there, nothing replays differently
    regtest:        0,      // genesis-active so the venue exercises the strict path
});

// dispenser_give_amount_activation
// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']).
addGate('dispenser_give_amount_activation.DISPENSER_GIVE_AMOUNT_ACTIVATION', 'time', {
    mainnet: 0,             // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 dispensers, 0 dispenses, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
});

// dispenser_oracle_price_activation
// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']).
addGate('dispenser_oracle_price_activation.DISPENSER_ORACLE_PRICE_ACTIVATION', 'time', {
    mainnet: 0,             // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 dispensers, 0 dispenses, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
});

// dispenser_ownership_cancel_activation
// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']). Mainnet flips at the coordinated 2.0.0 contract-era
// flag-day; testnet/regtest are active from genesis, mirroring the 2.0.0
// protocol_changes cohort and dispense_cancelling_match_activation.js.
addGate('dispenser_ownership_cancel_activation.DISPENSER_OWNERSHIP_CANCEL_ACTIVATION', 'time', {
    mainnet: 1786060800,    // 2026-08-07 00:00:00 UTC - coordinated 2.0.0 flag-day; deploy ALL indexers before this time
    testnet: 0,
    regtest: 0,
});

// dispenser_send_amount_compare_activation
// Scale the two amount operands are compared at once the rule is live.
//
// FROZEN. This is the emitted SQL of a consensus predicate: once any chain
// arms a height, changing this number changes how blocks above that height
// evaluate on a replay, which is a fork. It is deliberately a local constant
// rather than an import of LEDGER_AMOUNT_PRECISION, so that a future edit to
// that gate's scale cannot silently rewrite this predicate. The two are equal
// today (both 18) and both exist for the same reason: 18 is
// config.MAX_TOKEN_DECIMALS, the finest precision any tick can be issued with,
// so no token amount can be truncated by the cast. Raising MAX_TOKEN_DECIMALS
// above this value would make the comparison lossy; the accompanying unit test
// pins that relationship so the divergence fails CI instead of shipping.
addGate('dispenser_send_amount_compare_activation.DISPENSER_SEND_COMPARE_SCALE', 'constant', 18);

// Per-chain activation heights, interpreted against the chain's own block_index.
// `null` = NOT YET PINNED = inert (legacy lexicographic compare, byte-identical
// replay). Mainnet and regtest are armed; testnet is still unpinned.
addGate('dispenser_send_amount_compare_activation.DISPENSER_SEND_AMOUNT_COMPARE_ACTIVATION', 'height', {
    // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet
    // history (0 dispensers, 0 dispenses on every chain, measured 2026-09-09), so
    // height 0 opens no retroactive window.
    'BTC:mainnet':  0,
    'LTC:mainnet':  0,
    'DOGE:mainnet': 0,
    // Unpinned. Testnet arms at flag-day assembly, above the tip recorded at that
    // time, in one coordinated fleet deploy. A height a carrying fleet has already
    // passed opens a retroactive window: a node that reindexes across it derives
    // different state than one that did not, and testnet does carry the history
    // that makes that real.
    'BTC:testnet':  null,
    'LTC:testnet':  null,
    'DOGE:testnet': null,
    regtest: 0,
});
