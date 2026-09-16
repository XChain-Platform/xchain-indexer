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
 * XChain Indexer - Hub DB Sync Client: caps, margins and natural keys
 *
 * The memory caps, cadences and margins that bound a drain, and the natural-key
 * derivations the reconciliation passes compare served rows against.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

// TTL for the per-table local-column cache. Bounds how long a hub-side column
// rename can keep silently NULLing the mirror before localColumns re-reads the
// schema and self-heals (see localColumns).
const LOCAL_COLUMN_CACHE_TTL_MS = 5 * 60 * 1000;

// Cap on live price_snapshots events buffered while the price bootstrap drains
// (see bufferPriceEvent). Rounds finalize on PBFT cadence, so even a
// multi-minute drain sees a handful; the cap only bounds a pathological hub.
const PENDING_PRICE_EVENT_CAP = 10000;

// ── price_snapshots bootstrap throughput and visibility ──────────────────────
//
// price_snapshots is the one mirrored table with UNBOUNDED retention, and the
// hub never prunes it: 36 coin pairs at the default 600s round interval write
// ~5,184 rows a day forever. Every one of them was applied on every bootstrap,
// one awaited INSERT at a time, with a single log line at the very end, so an
// operator watching a cold start could not tell a working drain from a wedged
// one (measured 2026-08: 411,747 rows on a production hub, ~13 minutes of
// deferred blocks).
//
// Both halves are addressed here, and neither changes what the mirror ends up
// holding: rows are batched into multi-row upserts of the SAME statement the
// per-row path builds (priceUpsertSql below is the one source for both, so they
// cannot drift), and the page loop emits a throttled progress counter.
//
// The batch is an OPTIMIZATION ONLY and never a new failure mode. It engages for
// price_snapshots alone, only across a run of rows carrying identical columns,
// and any statement that does not come back as a driver OK result falls straight
// back to the per-row path - which then applies that whole chunk in order and
// keeps the "stop at the FIRST unappliable row" hole semantics bootstrapTable
// depends on. Set HUB_SYNC_BATCH_APPLY=false to force the per-row path.
const PRICE_BATCH_APPLY_ROWS = 500;

// How often a long drain reports progress. A drain that finishes inside this
// interval stays silent, so nothing changes for the small mirrored tables.
const BOOTSTRAP_PROGRESS_INTERVAL_MS = 15000;

// Memory bound on the served-key set the price reconciliation builds over a full
// re-page (reconcileForeignPriceRounds). One key per FINALIZED (round, pair) the
// hub serves; at hourly rounds across a handful of pairs this is decades of history,
// so the cap only ever trips on a pathological table. Above it the pass degrades to
// the round-ceiling rule, which needs no set at all.
const PRICE_FINALIZED_KEY_CAP = 500000;

// ── price_snapshots bootstrap bound ──────────────────────────────────────────
//
// price_snapshots is the one mirrored table with UNBOUNDED retention, and the
// hub never prunes it: 36 coin pairs at the default 600s round interval write
// ~5,184 rows a day forever. Every one of them was applied on every bootstrap,
// one awaited INSERT at a time, BEFORE the price barrier could arm - so a fresh
// or restarted indexer's time-to-first-block was a function of how long the
// oracle had been running rather than of how far behind that indexer was
// (measured 2026-08: 411,609 rows held a 372-block TBTC reparse for ~13 min).
//
// THE BARRIER IS NOT THE PROBLEM and is untouched here. What the bootstrap must
// still drain is the set of rounds any block this node will process can read,
// and that set is bounded, because every consensus read of this table is
// anchored to the block being processed:
//   - db.getLatestPrice - the newest finalized round at/below the block
//     (reference_block on the reference chain, block_timestamp under H-3);
//   - db.getPricesInTimeRange - rounds within FIAT_DISPENSER_PRICE_WINDOW of the
//     block time (reverseOraclePriceMatch reaches two windows back);
//   - db.getOracleDataForVM - the newest ORACLE_VM_ROUND_WINDOW rounds at/below
//     the block, plus the roundFloor it hands the VM. That one is a ROUND count,
//     not a time span, and it is VM-visible: a mirror holding fewer rounds than
//     its peers computes a different roundFloor and forks the contract hash, so
//     it is the binding constraint on how far back the mirror must reach.
// So the bound is: everything at or after a HORIZON supplied by the consumer
// (the block time of the first block this indexer will ever parse, already set
// back by its own read windows - see XChainIndexer._priceMirrorHorizon), plus a
// margin of history below that horizon deep enough to cover the VM round window.
//
// Nothing is ever deleted by this bound: it only decides what a bootstrap
// INSERTS. An existing full-history mirror keeps every row it holds, and a
// consumer that supplies no horizon (the explorer's vendored display mirror)
// mirrors the whole table exactly as before.

// How many rounds of pre-horizon history the mirror aims to hold. Must stay
// STRICTLY ABOVE protocol/constants.js ORACLE_VM_ROUND_WINDOW (1200), the deepest
// round window any consensus read can see; the headroom absorbs skipped rounds and
// a raise of that constant landing before every node redeploys. Deliberately NOT
// imported from there: this file is vendored verbatim into xchain-explorer, whose
// protocol/constants.js is a different file that does not define it, so a require
// would resolve to `undefined` in the vendored copy and silently disable the floor.
// test/unit/hub_db_sync_price_bootstrap_bound.test.js asserts the lockstep against
// the real constant instead.
const PRICE_MIRROR_ROUND_MARGIN = 1500;

// The deepest round window a consensus read can reach (protocol/constants.js
// ORACLE_VM_ROUND_WINDOW). Held here as the drain's own acceptance threshold: a
// bootstrap that retained fewer pre-horizon rounds than this, while the hub served
// more, has cut into VM-visible history and refuses to certify (see bootstrapTable).
const PRICE_MIRROR_MIN_PRE_HORIZON_ROUNDS = 1200;

// Pre-horizon lookback a drain starts from, in seconds: PRICE_MIRROR_ROUND_MARGIN
// rounds at the hub's default 600s ORACLE_ROUND_INTERVAL (xchain-hub constants.js
// DEFAULT_ORACLE_ROUND_INTERVAL_MS). A deployment on a different cadence is NOT
// assumed to fit: the drain counts the rounds it actually retained and widens the
// span itself when it came up short, so this is a starting point, never a
// correctness assumption.
const PRICE_MIRROR_LOOKBACK_S = PRICE_MIRROR_ROUND_MARGIN * 600;

// Factor the lookback grows by after a short drain, and the ceiling past which the
// bound gives up and mirrors the table in full. Fail-open by construction: the
// worst case is the unbounded behavior this bound exists to improve on, never a
// mirror that is short of what consensus reads.
const PRICE_MIRROR_LOOKBACK_GROWTH = 4;
const PRICE_MIRROR_LOOKBACK_MAX_S  = PRICE_MIRROR_LOOKBACK_S * 64;

// Natural key of a price_snapshots row: its UNIQUE (round_number, coin_pair).
// String()-normalized on both sides so a wire number and a driver-returned
// BIGINT/string for the same round produce the same key. NUL-joined because no
// coin_pair can contain it, so no two distinct pairs can collide into one key.
function priceRoundKey(round, pair) {
    return String(round) + ' ' + String(pair);
}

// Memory bound on the served-key set the capability-snapshot reconciliation builds
// over a full re-page (reconcileForeignCapabilitySnapshots). One key per row the hub
// serves; the hub writes one row per (block boundary, capability, key, source) and never
// prunes, so this only trips on a pathological table. Above it the pass degrades to the
// snapshot_block-ceiling rule, which needs no set at all.
const CAPABILITY_SNAPSHOT_KEY_CAP = 500000;

// Natural key of a capability_snapshots row: its UNIQUE uq_cap_snap
// (snapshot_block, capability, signing_pubkey, source). Lowercased and NUL-joined:
// the mirror table is utf8_general_ci, so the DB itself cannot hold two rows whose
// keys differ only in case, and matching that here keeps a hub-served row and the
// same row read back (AnchorRecovery writes signing_pubkey lowercased) from deriving
// two different keys and making a healthy row look unserved. `source` defaults to ''
// exactly as the column does, so a hub that omits it keys the same on both sides.
function capabilitySnapshotKey(row) {
    return [row.snapshot_block, row.capability, row.signing_pubkey, (row.source == null ? '' : row.source)]
        .map(v => String(v).toLowerCase()).join(' ');
}

module.exports = {
    LOCAL_COLUMN_CACHE_TTL_MS, PENDING_PRICE_EVENT_CAP,
    PRICE_BATCH_APPLY_ROWS, BOOTSTRAP_PROGRESS_INTERVAL_MS,
    PRICE_FINALIZED_KEY_CAP, PRICE_MIRROR_ROUND_MARGIN, PRICE_MIRROR_MIN_PRE_HORIZON_ROUNDS,
    PRICE_MIRROR_LOOKBACK_S, PRICE_MIRROR_LOOKBACK_GROWTH, PRICE_MIRROR_LOOKBACK_MAX_S,
    priceRoundKey, CAPABILITY_SNAPSHOT_KEY_CAP, capabilitySnapshotKey,
};
