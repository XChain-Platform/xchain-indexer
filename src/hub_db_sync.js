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
 * XChain Indexer - Hub DB Sync Client
 *
 * Maintains a local read-only copy of the hub's price_snapshots and
 * oracle_prices tables. On startup, fetches a snapshot via REST. After
 * bootstrap, subscribes to a WebSocket channel for live row updates.
 *
 * Used in distributed deployments where the indexer is on a different
 * host from the hub. For single-host deployments, the indexer can simply
 * point its hubDb connection directly at the hub's MariaDB instead.
 *
 * Pure Node.js. Uses built-in http/https + the `ws` package only when present.
 *
 * Relationship to xchain-sync (deliberately separate, not accidental dup)
 * ----------------------------------------------------------------------
 * xchain-sync solves a superficially similar problem (snapshot-then-stream a
 * MariaDB table) but is a different abstraction: it fans *validated ledger*
 * data DOWNSTREAM from a master to many validator replicas, with Merkle
 * transparency, cross-source hash verification, and rollback. This module
 * pulls oracle config UPSTREAM from the hub (the producer) into a single
 * consumer (the indexer's own hub-DB mirror), and its real payload is the
 * `waitForPriceSyncHeight` consensus barrier wired into the block loop
 * (XChainIndexer.js), NOT the plumbing. The two are kept apart on purpose:
 * xchain-sync's replicatedTables.js excludes price_snapshots as "hub-mirrored"
 * and SnapshotBuilder defers to this file. See review finding e800fdf6.
 *
 * TRIGGER for revisiting: if a THIRD cross-service table (e.g. validator-set
 * or attestation-results) needs the same snapshot-then-stream treatment, do
 * NOT copy this file a third time. Extract the shared mechanics: the
 * subscribe-before-bootstrap ordering handshake, INSERT IGNORE applier,
 * reconnect/re-bootstrap, and retraction-by-known-column, into one small
 * applier library that both this module and the new consumer use. Merging the
 * two services wholesale is the wrong move (different trust direction, and the
 * consensus barrier belongs to the indexer loop, not to a replication fabric).
 *
 ********************************************************************/

const http   = require('http');
const https  = require('https');
const url    = require('url');
const crypto = require('crypto');
const { HUB_SCHEMA_VERSION } = require('./hub-schema-version');
const swq    = require('./stake_weighted_quorum.js');
const { isRetractionSigningActive } = require('./retraction_signing_activation.js');

let WebSocket = null;
try {
    WebSocket = require('ws');
} catch (e) {
    // ws is optional; if not installed, live updates are disabled but bootstrap still works
}

// Maps each mirrored hub table to the column holding the source-chain action_index.
// Used to apply reorg retractions (row:deleted events) against the local copy.
// Kept local (not taken from the wire) so the DELETE never interpolates an
// attacker-supplied column name.
const RETRACTION_COLUMNS = {
    price_snapshots: 'source_action_index',
    oracle_prices:   'action_index'
};

// ── Watermark grace margins: frozen protocol constants (/ Package 12) ──
// The four barrier grace margins (seconds) are NOT operational timeouts: they
// decide WHEN the block-loop consensus barriers open via the stream-watermark
// escape (_priceSyncSatisfied / _oracleSyncSatisfied / _matchSyncSatisfied /
// _callSyncSatisfied).
// A per-node divergence forks settlement: operator A with grace 60 settles a
// block without a retroactive-effective-time row that lands inside the window
// while operator B with grace 600 waits and settles it differently. An
// unparseable value yields NaN, making every `blockTime + NaN` comparison false
// and permanently wedging the tip. So every node MUST use identical values.
//
// These are NODE-LOCAL TIMING BARRIERS (a wait decision), never persisted or
// hashed state, so pinning them needs NO activation gate: a reindex replays with
// the mirror already far ahead of the tip, so the barrier opens immediately
// regardless of grace, and the value never enters any ledger row. There is no
// historical byte-shape that a height gate would have to preserve.
const HUB_SYNC_WATERMARK_GRACE_S = Object.freeze({
    // Covers the PRICE hourly batch window (3600s), the post-window
    // signing-round grace (300s, ORACLE_BATCH_GRACE_MS), and ~900s of
    // headroom for DOGE confirmation and indexing before the batch lands
    // locally: 3600 + 300 + 900 = 4800. The prior value (600) was calibrated
    // to the 10-minute round cadence batching replaces; left at 600 it opens
    // this barrier's escape hatch ~55 minutes before a batch window can have
    // finished, letting a chain-only node process blocks against a mirror
    // that is still missing the current window. Raising it means an isolated
    // chain-only node can now trail the tip by up to ~75 minutes at this
    // barrier instead of ~10 (it only ever LAGS, never diverges: both sides
    // of the fee-staleness comparison are chain-derived, so a node that waits
    // computes the same verdict as one that was live). Hub-connected nodes,
    // which is every validator and the documented non-validator topology,
    // never hit this escape hatch and are unaffected. Moves fleet-wide in
    // lockstep with batching like every other value in this
    // object, and needs no activation gate of its own by the reasoning below:
    // node-local, never persisted or hashed, and a reindex replays with the
    // mirror already far ahead of the tip so the barrier opens immediately
    // regardless of grace.
    price:  4800,
    oracle: 600,
    match:  120,
    // Calls carry their OWN margin, currently equal to match's, because the two
    // producers stamp effective_time differently: CrossChainDexEngine stamps the
    // finalization instant (_nowSeconds()) while CrossChainCallEngine stamps
    // now + a forward relay margin. Sharing match's value silently coupled a call
    // barrier to a match producer's timing. Changing this NUMBER is a protocol
    // change: every node must move in lockstep, reconciled against the hub's
    // call-stamping path first.
    call:   120,
    // Anchor-reward attestations. Unlike the four above, this barrier does not gate on a
    // row-content watermark at all (the rows carry no effective_time, and their arrival is
    // governed by DOGE confirmation and hub failover, not by any clock the block loop can
    // read). It gates purely on "the mirror has received everything the hub produced up to
    // this block's time", which is what makes the fleet-agreed maturity watermark in
    // anchor_reward_activation.js safe: a node that cannot certify that much DEFERS instead
    // of deriving a partial reward set. The value only has to cover ordinary stream lag,
    // because the maturity constant already absorbs the ~24h of DOGE burial, failover and
    // federation delay. Changing this NUMBER is a protocol change (it moves which nodes can
    // advance past a maturity boundary), so it moves fleet-wide or not at all.
    anchorAttest: 120,
    // Finalized ATTEST responses (attestation_responses), the mirror that replaced the
    // validator-paid on-chain response transaction. Like anchorAttest above, this value only
    // has to cover ordinary stream lag, because the real forward margin is carried by the
    // row itself: effective_time is chosen by the round leader as now + ATTEST_RESPONSE_FORWARD_S,
    // bounded by every follower before it signs, and INSIDE the signed canonical, so the
    // applying block is a function of signed data rather than of any node's clock or of this
    // number. What this grace buys is the difference between "the mirror holds no row for this
    // block" and "the mirror has not been told yet": below it the block loop defers instead of
    // settling a block that a row already bound. Changing this NUMBER is a protocol change (it
    // moves which nodes may advance past a block a response binds at), so it moves fleet-wide
    // or not at all.
    attestResponse: 120,
});

// Resolve one grace margin. `frozen` is the pinned protocol constant; `envKey`
// the operator override honored ONLY on regtest (test tunability). Off-regtest a
// differing override is IGNORED with a loud startup warning and the frozen value
// wins, mirroring resolveFeeDestination (src/coins/index.js). On regtest a SET
// override that is not a non-negative integer THROWS an actionable startup error
// (NaN / negative / fractional / non-numeric) rather than being swallowed and
// stamped as a silent value that later wedges every barrier with `+ NaN`.
function resolveWatermarkGrace(frozen, envKey, network){
    const override = process.env[envKey];
    if(override === undefined || override === '') return frozen;
    if(network !== 'regtest'){
        if(String(override) !== String(frozen))
            console.log('WARNING: ' + envKey + ' is set but IGNORED on ' + String(network) +
                '; using the frozen protocol grace constant ' + frozen + 's. Watermark graces are ' +
                'consensus inputs (a per-node value forks settlement) and are not operator-tunable off regtest.');
        return frozen;
    }
    if(!/^\d+$/.test(String(override).trim()))
        throw new Error('Invalid ' + envKey + '="' + override + '": watermark grace must be a ' +
            'non-negative integer number of seconds (frozen protocol default ' + frozen + ').');
    return parseInt(String(override).trim(), 10);
}

// ── Mirror-barrier hold ceiling: the NAMED bound on a barrier wait ──
//
// The graces above decide WHEN a barrier opens. Nothing above decides how long a
// barrier may hold ONE block before the mirror itself is treated as the fault, and
// that omission is what let testnet throughput sit below chain pace with every log
// line reading healthy: each defer is bounded by HUB_PRICE_SYNC_TIMEOUT_MS, the block
// loop retries, and the retry re-arms an identical wait. Per-attempt bounds compose
// into an unbounded total, so the wait had no ceiling at all, only a cadence.
//
// This is that ceiling: the longest one block may sit behind the hub-mirror barriers
// before the node stops calling it an ordinary defer, says so under a distinct name,
// and forces the mirror to reconnect and re-bootstrap (HubDbSync.requestResync). The
// remedy is aimed at the actual failure mode: every one of these barriers is satisfied
// by the stream watermark, the watermark only advances while _bootstrapDrained is set,
// and that flag is cleared by any disconnect until a re-bootstrap drains. A mirror
// whose drain never completes therefore freezes every barrier indefinitely while its
// socket looks alive, and only a fresh subscribe-then-bootstrap cycle clears it.
//
// OPERATIONAL, NOT CONSENSUS, and it is the difference that makes this safe. It never
// opens a barrier, never shortens a grace and never lets a block commit one second
// earlier: a node past the ceiling is still deferring, fail-closed, exactly as before.
// It changes only what the node LOGS, what /health reports, and whether it re-drives
// its own mirror. So unlike the graces, a per-node value cannot fork settlement, and
// the env override below is honored on every network rather than regtest alone.
//
// Sized well above one barrier-timeout cycle (60s default) and above the 5s reconnect
// plus a full bootstrap drain, so an ordinary slow drain finishes on its own and only
// a mirror that is genuinely not converging reaches the ceiling.
const HUB_SYNC_BARRIER_HOLD_CEILING_S = 900;

// Resolve the hold ceiling in MILLISECONDS. Operational, so an override is honored on
// every network; an unusable value (non-numeric, negative, fractional) falls back to
// the named default with a warning rather than throwing, because a bad value here can
// only mis-time a log line and must never keep an indexer from booting. 0 disables the
// ceiling (no forced resync, no named crossing), which is the documented off switch.
function resolveBarrierHoldCeilingMs(raw){
    const override = (raw === undefined) ? process.env.HUB_SYNC_BARRIER_HOLD_CEILING_S : raw;
    if(override === undefined || override === null || override === '')
        return HUB_SYNC_BARRIER_HOLD_CEILING_S * 1000;
    if(!/^\d+$/.test(String(override).trim())){
        console.log('WARNING: HUB_SYNC_BARRIER_HOLD_CEILING_S="' + override + '" is not a non-negative ' +
            'integer number of seconds; using the default ceiling ' + HUB_SYNC_BARRIER_HOLD_CEILING_S + 's.');
        return HUB_SYNC_BARRIER_HOLD_CEILING_S * 1000;
    }
    return parseInt(String(override).trim(), 10) * 1000;
}

// ── signed-retraction verification helpers ───────────────────────────

// Rebuild the retraction canonical from the wire event. MUST byte-match the
// producer in xchain-hub/src/RetractionConsensus.js canonicalRetraction():
//   XRETRACTV1|<table>|<source_chain>|<from>|<to or ''>|<generation or ''>|<snapshot_block>
function canonicalRetraction(event) {
    let to  = (event.to_action_index       !== undefined && event.to_action_index       !== null) ? String(event.to_action_index)       : '';
    let gen = (event.retraction_generation !== undefined && event.retraction_generation !== null) ? String(event.retraction_generation) : '';
    return 'XRETRACTV1|' + String(event.table) + '|' + String(event.source_chain) + '|' +
           String(event.from_action_index) + '|' + to + '|' + gen + '|' + String(event.snapshot_block);
}

// Ed25519 verify with Node's built-in crypto (raw 32-byte hex pubkey, 64-byte
// hex signature over the utf8 canonical). Kept dependency-free: this module is
// vendored byte-identical into xchain-explorer, which must not grow requires.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function verifyEd25519(payload, sigHex, pubkeyHex) {
    if (!/^[0-9a-f]{64}$/.test(pubkeyHex) || !/^[0-9a-f]{128}$/.test(sigHex)) return false;
    try {
        let key = crypto.createPublicKey({
            key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pubkeyHex, 'hex')]),
            format: 'der', type: 'spki'
        });
        return crypto.verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(sigHex, 'hex'));
    } catch (e) {
        return false;
    }
}

// Coerce a hub-served value for a parameterized INSERT into the local mirror.
// The hub serves rows as JSON, so DATETIME columns arrive as ISO-8601 strings
// (e.g. price_snapshots.created_at = '2026-06-16T10:33:01.000Z'). MariaDB in
// strict mode rejects that 'T'/'Z' form for a DATETIME column with
// ER_TRUNCATED_WRONG_VALUE (22007), which silently kills the mirror (fleet
// incident 2026-06-16): BTC indexers stalled at 'price mirror at 0' once the
// oracle resumed finalizing rounds and fresh price_snapshots began streaming.
// Reformat any ISO-8601 datetime string to MySQL 'YYYY-MM-DD HH:MM:SS' (UTC,
// matching how the hub stores it); leave every other value untouched.
//
// columnType is the LOCAL column's SHOW COLUMNS Type, lowercased (see
// _cachedColumnType). The rewrite is keyed on that TYPE rather than on the
// value's shape, because a shape-keyed rewrite also hits free-text columns:
// oracle_prices.memo is unvalidated operator input (PRICE v1 validates
// VALUE/FEE but never MEMO), so a memo that is literally an ISO timestamp was
// rewritten in every distributed mirror while a deployment pointing hubDb
// straight at the hub's own MariaDB kept the hub's bytes - topology-dependent
// mirror content, against the verbatim-parity contract the mirror SQL twins
// state (src/sql/oracle_prices.sql). An empty/unknown columnType falls back to
// the shape rewrite, so a cache miss (or a driver that serves no Type) can
// never regress the 22007 mirror-kill described above.
function coerceMirrorValue(v, columnType) {
    if (typeof v !== 'string') return v;
    if (columnType && !/^(datetime|timestamp)/.test(columnType)) return v;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) return v;
    // An offset-less ISO string is parsed as LOCAL time by ECMA-262, which would
    // shift the mirrored value by the node's timezone (per-node mirror drift).
    // The hub stores UTC, so treat a Z-less/offset-less match as UTC explicitly.
    let iso = /(?:Z|[+-]\d{2}:?\d{2})$/.test(v) ? v : v + 'Z';
    let d = new Date(iso);
    if (isNaN(d.getTime())) return v;
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Tables mirrored for the cross-chain DEX + cross-chain contract calls.
// cross_chain_matches carries finalized, validator-signed matches;
// cross_chain_calls carries quorum-signed XCALL dispatch/result relay rows;
// capability_snapshots carries the block-boundary cross_chain validator set the
// indexer verifies both against. Retraction of cross_chain_matches is two-sided
// (either order leg); cross_chain_calls retracts on its source-chain request;
// both handled specially in _applyRetraction; capability_snapshots are
// immutable history and never retracted.
const CROSS_CHAIN_TABLES = ['cross_chain_matches', 'cross_chain_calls', 'capability_snapshots'];

// Tables that must re-page from since_id=0 on EVERY bootstrap. A cursor of
// since_id = MAX(local id) is INSERT-shaped: it can only deliver rows with a NEW id,
// so it can never re-fetch an in-place UPGRADE that kept the same hub id. Three
// mirrored tables are upgraded in place on the hub (price_snapshots skipped->
// finalized, cross_chain_calls re-finalized, cross_chain_matches anchor_txid
// stamping AND retract->revive content); if the upgrade broadcast is missed while
// this mirror is disconnected, only a full re-page re-delivers the row so the
// idempotent _applyRow ODKUs converge it (#2491, #3211). capability_snapshots is here
// for a related reason (locally-assigned ids, #2270). The three keep hub-id parity
// (only capability_snapshots strips id in _applyRow); the re-page cost is O(table)
// per reconnect, accepted. cross_chain_matches additionally runs a reconciliation
// pass over the completed re-page (_reconcileRetractedMatches), because the one
// mutation the hub CANNOT re-serve is a retraction: the snapshot endpoint filters
// retracted rows out entirely, so there is no row to converge against.
// attestation_responses is here for capability_snapshots' SECOND reason alone, and it is
// REQUIRED rather than a precaution: nothing in that table is ever updated in place, but
// _applyRow strips its hub id (every hub that holds the finalized artifact writes its own
// row and gossips it, so the ids differ for one logical row), which makes the local ids
// LOCALLY assigned. A since_id = MAX(local id) cursor is then not a position in the
// followed hub's id space at all: it can ask for rows past the end of that hub's table and
// strand the mirror, and a wire id can land on a locally-assigned PK where the INSERT
// IGNORE drops a real row without an error, leaving a permanent mirror hole (#2270). The
// natural key (network, request_id) dedupes the re-page, and a missed response here is a
// permanent fork rather than a lag, so the O(table) re-page per bootstrap is cheap.
const FULL_REPAGE_TABLES = ['capability_snapshots', 'price_snapshots', 'cross_chain_calls', 'cross_chain_matches',
                            'attestation_responses'];

// Hub federation state tables. state_checkpoints carries quorum-signed per-chain
// state-hash commitments (the explorer/SDK verification source). Append-only,
// never retracted. A reorged height is superseded by a new row with a higher
// checkpoint_seq. Not on any settlement-critical path (no block-loop barrier).
// anchor_reward_attestations carries the hub's XANCPUB publisher-attestation
// quorum per attested reward tuple; the BTC indexer derives the COLLECT-spendable
// anchor/archive reward from it (mirror is transport, not trust: it re-verifies the
// sigs against its own local oracle_publish set). Append-only, id-parity INSERT IGNORE,
// never retracted (rows are written only post-quorum for a finalized checkpoint).
// attestation_responses carries the FINALIZED ATTEST response (one row per terminal round,
// status 'ok' or 'expired'). The legacy route for it is a validator-paid ATTEST v1
// transaction; the BTC indexer binds it to a block from its own signed effective_time and
// synthesizes the v1 action locally. Insert-only in every SIGNED column; the one exception is
// batch_action_index, the display link to the ATTEST v5/v6 batch that later carries the body
// on chain, which the hub stamps after that batch lands and re-broadcasts, so the apply is a
// first-stamp-wins upsert of that single column (see _applyRow). No re-page is needed for
// content convergence: the link is not a consensus input, and the stamp arrives as a
// broadcast rather than as something a cursor has to re-fetch.
// Never retracted either: the mirror row is inert without a pending local request, so a reorg
// that removes the request simply leaves nothing for it to bind to (spec §4.5). It is a
// NATURAL-KEY mirror on (network, request_id) rather than an id-parity one, unlike the two
// above; see the id strip in _applyRow and the FULL_REPAGE_TABLES entry that follows from it.
const HUB_STATE_TABLES = ['state_checkpoints', 'anchor_reward_attestations', 'attestation_responses'];

// TTL for the per-table local-column cache. Bounds how long a hub-side column
// rename can keep silently NULLing the mirror before _localColumns re-reads the
// schema and self-heals (see _localColumns).
const LOCAL_COLUMN_CACHE_TTL_MS = 5 * 60 * 1000;

// Cap on live price_snapshots events buffered while the price bootstrap drains
// (see _bufferPriceEvent). Rounds finalize on PBFT cadence, so even a
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
// keeps the "stop at the FIRST unappliable row" hole semantics _bootstrapTable
// depends on. Set HUB_SYNC_BATCH_APPLY=false to force the per-row path.
const PRICE_BATCH_APPLY_ROWS = 500;

// How often a long drain reports progress. A drain that finishes inside this
// interval stays silent, so nothing changes for the small mirrored tables.
const BOOTSTRAP_PROGRESS_INTERVAL_MS = 15000;

// The price_snapshots upsert, for `rowCount` rows at once. ONE builder for both
// the per-row applier and the bootstrap's batch, because the ODKU body is the
// consensus-relevant part (skipped -> finalized upgrades only, keyed on
// VALUES(status) so it is independent of assignment order) and two copies of it
// would be two chances to diverge. At rowCount 1 it emits exactly the statement
// _applyRow emitted before this batching existed.
function priceUpsertSql(cols, rowCount) {
    let updatable = cols.filter(c => c !== 'id' && c !== 'round_number' && c !== 'coin_pair' && c !== 'status');
    let sets = updatable.map(c => '`' + c + "` = IF(VALUES(status) = 'finalized', VALUES(`" + c + '`), `' + c + '`)');
    sets.push("status = IF(VALUES(status) = 'finalized', 'finalized', status)");
    let tuple = '(' + cols.map(() => '?').join(', ') + ')';
    let tuples = [];
    for (let i = 0; i < rowCount; i++) tuples.push(tuple);
    return 'INSERT INTO price_snapshots (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES ' + tuples.join(', ')
         + ' ON DUPLICATE KEY UPDATE ' + sets.join(', ');
}

// Memory bound on the served-key set the price reconciliation builds over a full
// re-page (_reconcileForeignPriceRounds). One key per FINALIZED (round, pair) the
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
// more, has cut into VM-visible history and refuses to certify (see _bootstrapTable).
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

class HubDbSync {

    constructor(hubDb, options) {
        this.hubDb     = hubDb;                            // Database instance pointing at the local hub DB
        this.hubUrl    = options.hubUrl   || process.env.HUB_API_URL || '';
        this.apiKey    = options.apiKey   || process.env.HUB_API_KEY || '';
        this.enabled   = !!this.hubUrl && !!this.hubDb;
        this.pollIntervalMs = parseInt(options.pollInterval || process.env.HUB_DB_SYNC_POLL_INTERVAL || '30000');
        this.ws        = null;
        this.running   = false;
        // True when the WebSocket path is unavailable and this mirror falls back to
        // periodic REST polling (#2476). In poll mode the stream watermark must NOT
        // advance: REST snapshot endpoints are append-only, so a poll cycle can never
        // observe an in-place upsert or a row:deleted retraction, and certifying the
        // mirror as live-complete would open the settlement barriers over data that can
        // be silently stale. Set in start() when the fallback is selected.
        this._pollMode = false;

        // Highest reference_block present in the local price_snapshots copy. Used by the
        // block-processing sync barrier (waitForPriceSyncHeight) so an indexer does not
        // validate native-coin fees for a block until its local price mirror has caught up
        // to that block; otherwise two operators with different sync states could read a
        // different latest price round and compute a different fee threshold, diverging the
        // ledger. Refreshed after every successful price_snapshots sync.
        this.priceSyncHeight = 0;
        this._priceWaiters   = [];                         // pending waitForPriceSyncHeight() resolvers

        // Highest block_timestamp among finalized rounds in the local price_snapshots copy.
        // Used by the time-keyed price barrier (waitForPriceSyncTime), which runs on EVERY chain
        // whenever sync is enabled and is not conditioned on the NATIVE_FEE_PRICE_TIME_GATE
        // flag-day (XChainIndexer.js:877-903). Non-reference chains' heights are not comparable
        // to the rounds' BTC reference_block anchor, so catch-up is judged by the rounds'
        // consensus timestamps against the block's time instead (H-3); on BTC the time barrier
        // is ADDITIVE to the height one, since height coverage does not imply time coverage.
        // Refreshed together with priceSyncHeight after every successful price_snapshots sync.
        this.priceSyncMaxTimestamp = 0;
        this._priceTimeWaiters     = [];                   // pending waitForPriceSyncTime() resolvers

        // Highest effective_at present in the local oracle_prices copy. Used by the
        // block-processing sync barrier (waitForOracleSyncTimestamp) so an indexer does not
        // settle FIAT dispensers for a block until its local oracle mirror has caught up to
        // that block's time; otherwise two operators with different sync states could read a
        // different set of effective oracle prices in reverseOraclePriceMatch() and settle a
        // FIAT dispenser at a different amount, diverging the ledger. Refreshed after every
        // successful oracle_prices sync. Unlike price_snapshots (foundational on BTC),
        // oracle_prices is optional: a deployment with no FIAT oracles never populates it, so
        // this stays null and the barrier must treat that as "nothing to wait on" (see
        // _oracleSyncSatisfied) rather than stalling every block forever.
        this.oracleSyncTimestamp = null;                   // null = mirror's max effective_at not yet known
        this.oracleBootstrapped  = false;                  // true once the mirror has been read at least once
        this._oracleWaiters      = [];                     // pending waitForOracleSyncTimestamp() resolvers

        // Highest effective_time present in the local cross_chain_matches copy. The
        // cross-chain settlement pass uses waitForMatchSync(block_time) so an indexer does
        // not settle a block until its match mirror has caught up to that block's time;
        // otherwise two operators of the same chain could settle a cross-chain match at
        // different blocks, diverging that chain's ledger. Mirrors oracleSyncTimestamp:
        // a NULL max (empty mirror) is valid and means "no cross-chain matches to wait on".
        this.matchSyncTimestamp = null;
        this.matchBootstrapped  = false;
        this._matchWaiters      = [];

        // Highest effective_time present in the local cross_chain_calls copy (the
        // XCALL relay's equivalent of the match barrier. The injection/callback
        // passes use waitForCallSync(block_time) so an indexer never applies a
        // block until its call mirror has caught up to that block's time. Same
        // NULL-is-valid semantics and watermark escape as the match barrier
        // (#1984 class: a quiet table must never freeze the tip).
        this.callSyncTimestamp = null;
        this.callBootstrapped  = false;
        this._callWaiters      = [];

        // Coin this indexer settles for (e.g. 'LTC'). Used to scope the snapshot-presence
        // barrier to matches this chain will actually settle. See waitForSnapshotSync.
        this.coin = options.coin || null;

        // Receive-side retraction guards (XCALL-RETRACT-1). row:deleted events
        // arrive unsigned over the hub stream, and the hub's push*reorg RPCs forward the
        // caller's claim verbatim, so a compromised HUB_API_KEY could fabricate reorg
        // retractions and have every mirror durably delete valid quorum-signed rows.
        // Two local checks bound that:
        //  - getOwnRollbackGeneration: async hook returning this indexer's OWN current
        //    push_generations value for its own coin (the source side of the item-5308
        //    fence). For retractions claiming a reorg of OUR chain we are the authority:
        //    a legitimate one originated from our own rollback and always carries a
        //    PRE-bump generation (< our current), so anything else is refused. Absent
        //    (explorer's vendored mirror, direct-hub-DB mode) the check is skipped.
        //  - trackedRollbackGeneration: last-observed retraction generation per
        //    (table, source_chain). Generations are monotonic per source chain, so a
        //    fenced event below the tracked value is a replay/stale duplicate; equal is
        //    idempotent redelivery and still applied. In-memory: a restart only widens
        //    back to the fence itself, never below it.
        this.getOwnRollbackGeneration = (typeof options.getOwnRollbackGeneration === 'function')
            ? options.getOwnRollbackGeneration : null;
        this.trackedRollbackGeneration = {};

        // signed retractions: the network this mirror serves (mainnet |
        // testnet | regtest), used to key the RETRACTION_SIGNING flag-day and the
        // stake-weighted-quorum activation when verifying a quorum-class
        // retraction's co-signature set. The gate itself is judged from the local
        // mirrored capability_snapshots high-water mark, NEVER from a wire field.
        // Absent (explorer's vendored display mirror, older wiring) the gate never
        // arms and the fences above stand alone, as before.
        this.network = options.network || null;

        // Pending waitForSnapshotSync() resolvers. Unlike the match barrier (a cached
        // scalar max(effective_time)), snapshot-presence is set-dependent: a match can
        // only be settled once the capability_snapshots row set for its snapshot_block is
        // mirrored, so satisfaction is recomputed by a live query per evaluation rather
        // than tracked as a scalar. Gating block advancement on it (defer-and-retry, like
        // the match barrier) keeps every operator settling a match at the same height even
        // if the snapshot mirrors in after the match. See _snapshotSyncSatisfied.
        this._snapshotWaiters   = [];

        // Stream-position watermark: the hub's "you have received everything I
        // produced up to ts" signal, carried by the WS heartbeat ({type:'watermark'}),
        // the ready message, and REST snapshot responses. This is what lets the
        // barriers below distinguish "my mirror is BEHIND the hub" (must defer,
        // settling now could fork the ledger) from "no new rows exist anywhere"
        // (must proceed, deferring deadlocks the chain). The previous row-content
        // watermarks (MAX(effective_at)/MAX(effective_time)) could not make that
        // distinction: the first sparse row armed the barrier and the tip deferred
        // forever until the NEXT row arrived (review items #1984/#1986, live-repro'd
        // on the / testbed 2026-06-09).
        //
        // Grace margins (seconds) cover rows whose effective time can precede their
        // insertion into the stream: oracle first-publishes are effective at their
        // action's block_time (source-chain indexing lag → retroactive arrival; see
        // the PriceAggregator retroactivity finding for the protocol-level fix),
        // price rounds finalize via PBFT some time after their anchor block, and
        // matches are stamped with the hub's wall clock (skew only).
        this.streamWatermark      = 0;
        // Frozen protocol constants (600/600/120/120), env-overridable only on regtest;
        // off-regtest the override is ignored with a warning and a bad value throws.
        // See HUB_SYNC_WATERMARK_GRACE_S / resolveWatermarkGrace above.
        this.priceWatermarkGraceS  = resolveWatermarkGrace(HUB_SYNC_WATERMARK_GRACE_S.price,  'HUB_SYNC_PRICE_GRACE_S',  this.network);
        this.oracleWatermarkGraceS = resolveWatermarkGrace(HUB_SYNC_WATERMARK_GRACE_S.oracle, 'HUB_SYNC_ORACLE_GRACE_S', this.network);
        this.matchWatermarkGraceS  = resolveWatermarkGrace(HUB_SYNC_WATERMARK_GRACE_S.match,  'HUB_SYNC_MATCH_GRACE_S',  this.network);
        this.callWatermarkGraceS   = resolveWatermarkGrace(HUB_SYNC_WATERMARK_GRACE_S.call,   'HUB_SYNC_CALL_GRACE_S',   this.network);
        this.anchorAttestWatermarkGraceS = resolveWatermarkGrace(HUB_SYNC_WATERMARK_GRACE_S.anchorAttest, 'HUB_SYNC_ANCHOR_ATTEST_GRACE_S', this.network);
        this._anchorAttestWaiters  = [];                   // pending waitForAnchorAttestationSync() resolvers
        // Finalized ATTEST responses. Named for the response mirror, NOT for the anchorAttest
        // pair above it, which means anchor-reward attestations and is a different barrier over
        // a different table.
        this.attestResponseWatermarkGraceS = resolveWatermarkGrace(HUB_SYNC_WATERMARK_GRACE_S.attestResponse, 'HUB_SYNC_ATTEST_RESPONSE_GRACE_S', this.network);
        this._attestResponseWaiters = [];                  // pending waitForAttestationResponseSync() resolvers

        // Named ceiling on a mirror-barrier hold. Held here as well as on the
        // indexer because requestResync() rate-limits itself by the same value: one forced
        // resync per ceiling window, so a mirror that cannot converge is re-driven on a
        // known cadence instead of being reconnect-stormed once per block-poll tick.
        this.barrierHoldCeilingMs = resolveBarrierHoldCeilingMs();
        this._lastResyncRequestAt = 0;
        this.forcedResyncCount    = 0;

        // Watermark advancement is gated on a completed bootstrap: WS heartbeats
        // certify only what was delivered ON THE SOCKET, so until the REST
        // bootstrap has fully drained every mirrored table (rows from before the
        // subscription), a heartbeat must not certify the mirror as caught-up.
        // Reset on disconnect; re-set after the reconnect re-bootstrap drains.
        this._bootstrapDrained = false;
        this._readyWatermark   = null;
        // Set when a live row event is rejected for a schema_version mismatch. While
        // true the watermark heartbeat must NOT advance, or the price-sync barrier
        // would open and settle a block against mirror data we refused to apply.
        // Cleared on a clean re-bootstrap (which only drains when versions match).
        this._schemaMismatchSeen = false;

        // Live price_snapshots events are BUFFERED, not applied, until the
        // current connection's price_snapshots bootstrap has fully drained
        // (#2422). The WS subscription opens BEFORE the REST bootstrap and
        // price_snapshots deliberately drains LAST behind a multi-minute pull,
        // so a live row (a freshly-finalized round) applied mid-drain lands
        // ABOVE rows only the still-draining bootstrap will deliver. Every
        // MAX()-based refresh would then overstate the mirror (priceSyncHeight
        // jumps to the fresh round while earlier rounds are still absent) and
        // the height barrier would open over a HOLED mirror: a per-operator
        // divergent native-fee price read. The same out-of-order row would
        // also contaminate the re-bootstrap cursor (since_id = local MAX(id)
        // silently skips the gap under it). Deferring the apply keeps the
        // local mirror a CONTIGUOUS prefix of the hub's table at all times,
        // which is what makes the reconnect self-heal
        // (_refreshAllSyncHeights) and the timeout self-heal safe to read
        // from it unguarded. _priceDrained is per-connection (reset on close,
        // like _bootstrapDrained); the buffer replays in arrival order once
        // the drain completes (see _bootstrapTable), then the live path
        // resumes. _wsEpoch bumps on every disconnect so a flush racing a
        // close can never stale-arm _priceDrained for the next connection.
        this._priceDrained         = false;
        this._pendingPriceEvents   = [];
        this._pendingPriceOverflow = false;
        this._wsEpoch              = 0;

        // price_snapshots bootstrap bound. Optional async hook returning the
        // unix-second HORIZON below which no block this consumer will ever process can
        // read a price round; the drain then applies rounds at/after it plus a margin of
        // history below it (see the constant block above). Absent, unresolvable or
        // non-positive => no bound at all, which is the unbounded full mirror: the
        // explorer's vendored display mirror passes nothing and is unchanged.
        this.getPriceMirrorHorizon = (typeof options.getPriceMirrorHorizon === 'function')
            ? options.getPriceMirrorHorizon : null;
        // How far below the horizon the current drain reaches, and the drain's own verdict
        // on whether that span was deep enough. Instance state, not constants, because a
        // short drain widens the span for the retry and a repeatedly short one disables the
        // bound outright.
        this._priceMirrorLookbackS     = PRICE_MIRROR_LOOKBACK_S;
        this._priceMirrorBoundDisabled = false;
        // Set when a block older than the bounded mirror's floor was seen; holds both price
        // barriers shut until a drain has mirrored price_snapshots in full again.
        this._priceMirrorRefloor       = false;
        // Timestamp below which the local price_snapshots copy is deliberately incomplete,
        // or 0 when it holds everything the hub served. Read by the price barriers: a block
        // older than this is a block whose price reads the mirror cannot answer, so the
        // bound is abandoned and the table re-mirrored in full rather than settled against
        // (see _notePriceMirrorFloor).
        this._priceMirrorFloorTs   = 0;

        // Serialization chain for the WebSocket message handler. Each incoming
        // message appends its async work to this promise so that a watermark
        // heartbeat cannot advance streamWatermark while a preceding row:inserted
        // apply is still awaiting its DB write. The chain is reset on reconnect
        // (the old connection's in-flight work is abandoned on close anyway).
        this._msgChain = Promise.resolve();

        // Heartbeat-timeout watchdog: the hub broadcasts a {type:'watermark'} frame
        // every WS_WATERMARK_INTERVAL_MS (10s server-side default; see HubDbBroadcaster). A
        // half-open TCP connection (NAT timeout, LB idle drop, hub host power loss)
        // fires neither 'close' nor 'error' on this socket, so without an explicit
        // liveness check the mirror can freeze silently for hours. _lastHeartbeatAt
        // is stamped in _advanceWatermark's caller (the 'watermark' message handler)
        // and on every fresh connection; _watchdogTimer polls it while the socket is
        // open and terminates a stalled socket so the existing close-handler
        // reconnect path self-heals. See review finding 0af6d951.
        //
        // The watchdog timeout MUST exceed the hub's heartbeat interval. That interval
        // is now self-describing: the hub stamps its actual cadence into the 'ready'
        // message (watermark_interval_ms), and the ready handler resizes the watchdog
        // from it, so an operator raising WS_WATERMARK_INTERVAL_MS on the hub can no
        // longer make this consumer terminate a healthy socket. The env value below is
        // only the pre-ready seed and the fallback for older hubs that omit the field.
        this._lastHeartbeatAt = null;
        this._watchdogTimer = null;
        this.watermarkIntervalMs = parseInt(options.watermarkIntervalMs || process.env.HUB_SYNC_WATERMARK_INTERVAL_MS || '10000');
        this.watermarkTimeoutMs = this.watermarkIntervalMs * 3;

        // Batched price applies and the drain's progress counter. Both are
        // reporting/throughput only - no barrier, floor or mirrored row depends on
        // either - so both carry a plain off switch rather than a fail-closed gate.
        this._batchApplyDisabled = (options.batchApply === false) ||
                                   (process.env.HUB_SYNC_BATCH_APPLY === 'false');
        this._batchApplyWarned   = false;
        this.batchApplyRows      = parseInt(options.batchApplyRows ||
                                            process.env.HUB_SYNC_BATCH_APPLY_ROWS || String(PRICE_BATCH_APPLY_ROWS));
        if (!Number.isFinite(this.batchApplyRows) || this.batchApplyRows < 2)
            this.batchApplyRows = PRICE_BATCH_APPLY_ROWS;
        this.bootstrapProgressMs = parseInt(options.bootstrapProgressMs ||
                                            process.env.HUB_SYNC_BOOTSTRAP_PROGRESS_MS || String(BOOTSTRAP_PROGRESS_INTERVAL_MS));
        if (!Number.isFinite(this.bootstrapProgressMs) || this.bootstrapProgressMs < 0)
            this.bootstrapProgressMs = BOOTSTRAP_PROGRESS_INTERVAL_MS;
    }

    // Advance the stream watermark (monotonic) and re-evaluate every pending
    // barrier waiter; a watermark advance can satisfy any of them.
    _advanceWatermark(ts) {
        ts = Number(ts);
        if (!Number.isFinite(ts) || ts <= this.streamWatermark) return;
        this.streamWatermark = ts;
        this._releasePriceWaiters();
        this._releasePriceTimeWaiters();
        this._releaseOracleWaiters();
        this._releaseMatchWaiters();
        this._releaseCallWaiters();
        this._releaseAnchorAttestWaiters();
        this._releaseAttestResponseWaiters();
    }

    // Adopt the hub's advertised heartbeat cadence (from the 'ready' message's
    // watermark_interval_ms) so the watchdog timeout self-sizes to 3x the hub's
    // ACTUAL interval instead of a locally-guessed env default. Backward compatible:
    // an older hub omits the field (value undefined/NaN) and this leaves the
    // env-seeded interval/timeout untouched. Returns true when a new interval was
    // adopted so the caller can re-arm the running watchdog at the new cadence.
    _adoptHubWatermarkInterval(watermarkIntervalMs) {
        let ms = Number(watermarkIntervalMs);
        if (!Number.isFinite(ms) || ms <= 0) return false;
        // Clamp both ends: the value arrives from the hub over the wire, so an
        // arbitrarily small interval would drive this client's watchdog timer
        // into a busy loop, and an arbitrarily large one would disable the
        // stall detection the watchdog exists to provide. The bounds sit far
        // outside any real heartbeat cadence, so a legitimate hub is never
        // clamped.
        const MIN_WATERMARK_INTERVAL_MS = 1000;
        const MAX_WATERMARK_INTERVAL_MS = 300000;
        ms = Math.min(Math.max(ms, MIN_WATERMARK_INTERVAL_MS), MAX_WATERMARK_INTERVAL_MS);
        this.watermarkIntervalMs = ms;
        this.watermarkTimeoutMs = ms * 3;
        return true;
    }

    // Start the heartbeat-timeout watchdog for the given live socket. Called once
    // the socket is open; cleared in the 'close'/'error' cleanup so it can never
    // fire against a dead socket object or leak a timer across reconnects.
    _startWatchdog(ws) {
        this._lastHeartbeatAt = Date.now();
        this._stopWatchdog();
        this._watchdogTimer = setInterval(() => {
            if (this._lastHeartbeatAt == null) return;
            const idleMs = Date.now() - this._lastHeartbeatAt;
            if (idleMs >= this.watermarkTimeoutMs) {
                console.warn('HubDbSync: no watermark heartbeat for ' + idleMs +
                    'ms (timeout ' + this.watermarkTimeoutMs + 'ms); terminating stalled socket');
                ws.terminate();
            }
        }, this.watermarkIntervalMs);
        if (typeof this._watchdogTimer.unref === 'function') this._watchdogTimer.unref();
    }

    // Clear the watchdog timer. Safe to call whether or not one is running.
    _stopWatchdog() {
        if (this._watchdogTimer) {
            clearInterval(this._watchdogTimer);
            this._watchdogTimer = null;
        }
    }

    // Start: open WebSocket and await the hub's ready acknowledgement (confirming
    // the subscription is registered), then bootstrap from REST snapshots. This
    // order ensures no rows can be broadcast between the snapshot response and our
    // subscription becoming active. Rows that arrive via the stream during the
    // bootstrap window are harmless duplicates (_applyRow uses INSERT IGNORE).
    async start() {
        if (!this.enabled) {
            console.log('HubDbSync: disabled (no hub URL or no local hub DB connection)');
            return;
        }
        this.running = true;

        if (WebSocket) {
            // Subscribe first so no row is missed between the REST snapshot and
            // when the hub registers us as a subscriber.
            try {
                await this._connectWebSocket();
            } catch (err) {
                console.warn('HubDbSync: WebSocket not ready before bootstrap:', err);
                // Continue: bootstrap still runs; _scheduleReconnect is already queued
            }
        } else {
            console.warn('HubDbSync: ws package not available, falling back to periodic polling');
            // Select the poll fallback BEFORE the first bootstrap so even that initial
            // drain fails closed (does not certify the watermark); see _bootstrapAll (#2476).
            this._pollMode = true;
        }

        // Bootstrap each tracked table after the subscription is confirmed active
        await this._bootstrapAll();

        if (!WebSocket) {
            this._startPolling();
        }
    }

    // Bootstrap every mirrored table. When ALL of them fully drain (each REST
    // snapshot returned fewer rows than its page limit and applied cleanly),
    // the mirror provably holds everything the hub had at the OLDEST of the
    // per-table response watermarks, then advance the stream watermark to it and
    // open the heartbeat gate.
    //
    // A partial drain leaves the gate closed and SCHEDULES A RETRY. The retry is
    // load-bearing in WS mode: there is no poll loop while the socket is healthy,
    // so without it one failed table would freeze the watermark at 0 until the
    // next reconnect (which on a stable connection is never the case; prod incident
    // 2026-06-11: BTC mainnet deferred every tip block in 60s loops because the
    // single-page bootstrap could not drain a >10k-row price_snapshots table and
    // nothing ever re-attempted it).
    async _bootstrapAll() {
        if (this._bootstrapping) return;                     // reconnect + retry timer may overlap
        this._bootstrapping = true;
        try {
            let marks = [];
            let allDrained = true;
            // price_snapshots bootstraps LAST so EVERY per-block barrier that gates block
            // processing (oracle, cross-chain match, cross-chain call, capability snapshot)
            // arms its empty-mirror fast path before the one heavy table drains. Each of those
            // barriers' "no-op on an empty mirror" path requires its OWN <x>Bootstrapped flag,
            // which only flips after that table's bootstrap completes; serialized behind a
            // multi-minute price_snapshots drain they all stay false, so a cold-start indexer at
            // chain tip with empty hub mirrors defers every block 60s on the FIRST unarmed
            // barrier (LTC-testnet 2026-06-16: a 37,032-row price_snapshots drain held the oracle
            // barrier at 'oracle mirror at null' for 3.5 min). Ordering price_snapshots first
            // only relocated that stall to the next barrier in sequence; draining it last lets
            // the small barrier tables (typically empty on non-BTC chains) arm in ~1s. The
            // price_snapshots barrier (waitForPriceSyncHeight) is BTC-only and runs FIRST in the
            // block loop, so BTC waits for price_snapshots there regardless of bootstrap order;
            // draining it last means BTC waits ONCE (its price barrier) instead of twice (price
            // then match). Consensus-neutral: the global stream watermark still advances only
            // after ALL tables drain, independent of order.
            for (let table of ['oracle_prices'].concat(CROSS_CHAIN_TABLES, HUB_STATE_TABLES, ['price_snapshots'])) {
                try {
                    let mark = await this._bootstrapTable(table);
                    if (mark === null) allDrained = false;
                    else marks.push(mark);
                } catch (err) {
                    allDrained = false;
                    console.warn('HubDbSync: ' + table + ' bootstrap failed:', err);
                }
            }
            if (allDrained && marks.length > 0) {
                this._bootstrapDrained = true;
                // A clean full drain proves the hub's schema_version matched (a
                // mismatch parks the bootstrap), so any earlier live mismatch is
                // resolved: re-open the watermark gate.
                this._schemaMismatchSeen = false;
                if (this._pollMode) {
                    // Poll-mode fail-closed (#2476): the REST snapshot endpoints are
                    // append-only, so a poll cycle observes new-id INSERTs but can NEVER
                    // receive an in-place upsert (skipped->finalized, anchor stamp,
                    // generation bump) or a row:deleted retraction the way the WS stream
                    // does. Advancing the watermark here would certify the mirror as
                    // live-complete through min(marks) and let the watermark-escape paths
                    // in the settlement barriers open over data that can be silently
                    // stale, forking the ledger. Freeze the watermark and warn every
                    // cycle instead; the barriers fall back to their content paths and
                    // DEFER rather than certify. Mirroring itself still ran above.
                    console.warn('HubDbSync: poll-mode mirror: watermark frozen, WS unavailable, ' +
                        'upserts/retractions cannot be received; settlement barriers will not certify');
                } else {
                    this._advanceWatermark(Math.min.apply(null, marks));
                }
            } else if (this.running) {
                console.warn('HubDbSync: bootstrap partial, retrying in ' + this.pollIntervalMs + 'ms (heartbeat gate stays closed)');
                setTimeout(() => {
                    if (this.running && !this._bootstrapDrained) this._bootstrapAll();
                }, this.pollIntervalMs);
            }
        } finally {
            this._bootstrapping = false;
        }
    }

    stop() {
        this.running = false;
        if (this.ws) {
            try { this.ws.close(); } catch (e) { /* ignore */ }
            this.ws = null;
        }
    }

    // Read-only status snapshot for /status: composed from state already tracked
    // on the instance, so a caller never reaches into private fields to answer
    // "is the mirror connected, and how far behind". Disabled reports configured:false
    // rather than a zeroed shape that would read as a live mirror stalled at genesis.
    mirrorStatus() {
        if (!this.enabled) {
            return { configured: false, connected: false, bootstrapped: false, streamWatermark: null, tables: {} };
        }
        let tables = {};
        // HUB_STATE_TABLES rides the global streamWatermark, not a per-table
        // scalar: that IS what gates each of them (§4.2).
        for (let table of HUB_STATE_TABLES) tables[table] = this.streamWatermark;
        tables.oracle_prices       = this.oracleSyncTimestamp;
        tables.cross_chain_matches = this.matchSyncTimestamp;
        tables.cross_chain_calls   = this.callSyncTimestamp;
        // capability_snapshots satisfaction is a live per-block query, never a
        // cached scalar (_snapshotSyncSatisfied); nothing in-memory to report.
        tables.capability_snapshots = null;
        tables.price_snapshots      = this.priceSyncMaxTimestamp;
        return {
            configured: true,
            connected: !!this.ws,
            bootstrapped: this._bootstrapDrained,
            streamWatermark: this.streamWatermark,
            tables: tables
        };
    }

    // Bootstrap: fetch a full snapshot of the table from the hub and apply it.
    // If the hub supplied max_ids in the ready message, runs a supplemental
    // catch-up fetch for any IDs between the snapshot ceiling and hub_ready_max_id
    // that may have arrived while the REST round-trip was in flight.
    // Returns the snapshot response's stream watermark when this table fully
    // drained (page not full, every row applied), or null otherwise; the caller
    // (_bootstrapAll) only advances the global watermark once every table drains.
    async _bootstrapTable(table) {
        const PAGE_LIMIT = 10000;
        const MAX_PAGES  = 1000;                             // runaway backstop (10M rows)

        // Prime (and validate) the local column cache once, up front. If the mirror
        // table does not exist yet, _localColumns throws (it refuses to cache an empty
        // column set); bail as "not drained" so _bootstrapAll schedules a retry once
        // the indexer's verifyTables() has created it. Doing this here (rather than
        // letting each row fail in _applyRow) avoids a SHOW COLUMNS storm + a misleading
        // "bootstrapped N rows" log when the whole page silently no-ops. Self-heals the
        // cold-start race without a process restart.
        try {
            await this._localColumns(table);
        } catch (e) {
            console.warn('HubDbSync: ' + table + ' not ready for bootstrap (' + e.message + '), will retry');
            return null;
        }

        // Clear anything the mirror holds for a network other than the one it serves,
        // BEFORE the cursor below is read from it, and keep the resolved scope for every
        // id read in this bootstrap. Null scope means the scope could not be proven, and
        // then nothing is deleted and every read stays unscoped (see _mirrorNetworkScope).
        let scope = await this._mirrorNetworkScope(table);
        if (scope) await this._purgeForeignNetworkRows(table, scope);

        // Determine the highest existing ID in the local copy so we only fetch newer rows.
        // EXCEPT the FULL_REPAGE_TABLES (see above): a since_id = MAX(local id) cursor is
        // INSERT-shaped and can never re-fetch an in-place upgrade (and capability_snapshots
        // also has locally-assigned ids). Re-page those from 0; the natural-key UNIQUE +
        // idempotent _applyRow (INSERT IGNORE / ODKU) dedupe, and the in-loop cursor still
        // advances off the hub's wire ids.
        //
        // The read is network-scoped where the table supports it: an id is the CURRENT
        // hub's auto-increment value, so a row from any other hub's id space is not a
        // position in this hub's stream and must not seed a cursor into it.
        let lastId = 0;
        if (!FULL_REPAGE_TABLES.includes(table)) {
            lastId = await this._localMaxId(table, scope);
        }

        // Second fence on the same class, for the id spaces no local column can separate
        // (two hubs on the SAME network, so every row scopes in; or the SAME hub after its
        // database was rebuilt, which restarts the auto-increment at 1). A cursor above
        // every id the hub holds cannot be a position in its stream: since_id asks for rows
        // past the end of its table and the drain reports zero rows on every attempt with
        // no other signal. The hub states its own MAX(id) per table in the subscription
        // ready message, so compare against that and start the cursor over when the local
        // one sits above it.
        //
        // ABSENT IS NOT ZERO, and conflating them is what let a rebuilt hub strand this
        // mirror forever. An older hub that advertises nothing leaves the key ABSENT and
        // must stay on the fail-open path (the field is additive). A hub that advertises
        // 0 has SUCCESSFULLY read its own empty table: HubDbBroadcaster only assigns a
        // number when the query returns, and leaves the key absent when it throws. So 0 is
        // a measurement, and it is the single strongest signal a rebuild produces, because
        // a freshly rebuilt hub advertises exactly 0 until its first row lands. Gating this
        // fence on `readyCeiling > 0` discarded precisely that measurement, so the one
        // state the fence exists for was the one state it could not see.
        //
        // THE CURSOR IS ONLY HALF OF IT. Re-paging from 0 fixes where we READ but not what
        // we HOLD, and for these tables that is not enough in two compounding ways. Readers
        // take the newest row (state_checkpoints readers take MAX(checkpoint_seq)), so rows
        // from the old id space keep winning over everything the re-page delivers. And the
        // apply is id-parity INSERT IGNORE, so a stale row SITTING ON an id the rebuilt hub
        // now reuses silently drops the real row - the same mechanism _purgeForeignNetworkRows
        // documents below. Both are fixed only by clearing the table for this scope first.
        //
        // Deletion clears the bar that method sets ("provable from the row and this mirror's
        // own configuration, with no dependence on what one snapshot response happened to
        // contain"). The ceiling is the SOURCE's authoritative statement about its own id
        // space, not the contents of a page: a paging hole, a filtered endpoint or a partial
        // drain cannot move it. It is unfiltered for exactly the tables this fence governs -
        // FULL_REPAGE_TABLES never reach here (their cursor is already 0), which is what
        // keeps the two status-filtered ceilings the broadcaster computes, cross_chain_matches
        // and cross_chain_calls, out of this comparison; they would understate.
        //
        // Fail-safe direction: a false trip costs one full re-page of a small append-only
        // table and converges to an exact copy of the source, which is what the mirror is
        // for. Not tripping strands the mirror silently and permanently.
        let readyCeiling = (this._readyMaxIds && this._readyMaxIds[table] != null)
            ? Number(this._readyMaxIds[table]) : NaN;
        if (lastId > 0 && Number.isFinite(readyCeiling) && lastId > readyCeiling) {
            console.warn('HubDbSync: local ' + table + ' cursor ' + lastId + ' sits above the hub ceiling ' +
                readyCeiling + ', so the local rows are not from this hub id space' +
                (readyCeiling === 0 ? ' (the hub reports an EMPTY table, the signature of a rebuilt hub database)' : '') +
                '; clearing the mirror for this scope and re-paging from 0');
            await this._purgeRebuiltSourceRows(table, scope, lastId, readyCeiling);
            lastId = 0;
        }

        // Page until a SHORT page. The previous single-fetch version treated any
        // full page as "not drained" and never fetched the rest. On a hub table
        // larger than one page (prod price_snapshots: 13k+ rounds) the drain was
        // structurally impossible, so the heartbeat gate never opened and the
        // stream watermark froze at 0 (the 2026-06-11 tip-deferral incident).
        let applied = 0;
        let applyErrors = 0;
        let lastPageCount = 0;
        let watermark = null;
        // cross_chain_matches only: the ODKU converges every mutation the hub can SERVE, but
        // the bootstrap endpoint filters `status <> 'retracted'` (hub api.js), so a match the
        // hub retracted while this mirror was disconnected is simply ABSENT from every page -
        // there is no row to converge against, and the stale local copy keeps settling
        // forever. Collect what the full re-page did serve so the reconciliation pass below
        // can close that half of #3211.
        let servedMatchIds = (table === 'cross_chain_matches') ? new Set() : null;
        let maxServedId    = 0;
        // price_snapshots only: the same problem with the opposite cause. Its snapshot
        // endpoint is UNFILTERED (hub api.js: SELECT * ... WHERE id > ?), so a complete
        // re-page is the hub's whole table, which makes "the hub does not hold this round
        // as finalized" provable from the drain alone. Nothing else can prove it here: the
        // table carries no `network` column, so _mirrorNetworkScope returns null and BOTH
        // purges above are structurally unreachable for it (and the id-ceiling fence never
        // even runs, because FULL_REPAGE forces the cursor to 0). Collect the finalized
        // (round_number, coin_pair) keys the hub actually served so the pass below can
        // clear what it did not. See _reconcileForeignPriceRounds.
        let servedPriceKeys   = (table === 'price_snapshots') ? new Set() : null;
        let priceKeysComplete = true;
        let maxServedRound    = 0;
        // price_snapshots only: the bootstrap bound. `priceHorizon` is the block
        // time of the oldest block this consumer can still process, 0 when no bound applies.
        // `priceFloor` is how far below it this drain reaches. Rows older than the floor are
        // SERVED (so every warrant that rests on the drain having seen the hub's whole table
        // - the reconciliation below above all - is untouched) but not APPLIED.
        let priceHorizon = (table === 'price_snapshots') ? await this._resolvePriceMirrorHorizon() : 0;
        let priceFloor   = (priceHorizon > 0) ? (priceHorizon - this._priceMirrorLookbackS) : 0;
        // Distinct FINALIZED rounds below the horizon the hub served, and how many of them
        // this drain kept. Finalized-only because that is the exact set every consensus read
        // filters on, so it is what the acceptance check below must measure.
        let preHorizonServed   = (priceHorizon > 0) ? new Set() : null;
        let preHorizonRetained = (priceHorizon > 0) ? new Set() : null;
        let priceSkipped       = 0;

        // Progress counter. `fetched` counts every row the hub served this drain, which is
        // the number that has to be seen moving on a cold start even where `applied` lags
        // behind it. The hub states its own MAX(id) per table in the subscription ready
        // message, so where that is known the line also carries how far through the id
        // space this drain has reached.
        let fetched        = 0;
        let pagesFetched   = 0;
        let drainStartedAt = Date.now();
        let lastProgressAt = drainStartedAt;
        let reportProgress = () => {
            if (!(this.bootstrapProgressMs > 0)) return;
            let now = Date.now();
            if ((now - lastProgressAt) < this.bootstrapProgressMs) return;   // short drains stay silent
            lastProgressAt = now;
            let elapsedS = Math.max(1, Math.round((now - drainStartedAt) / 1000));
            let ceiling  = Number(this._readyMaxIds && this._readyMaxIds[table]);
            let share    = (Number.isFinite(ceiling) && ceiling > 0 && lastId > 0)
                             ? ' (~' + Math.min(99, Math.floor((lastId / ceiling) * 100)) + '% of the hub id space)'
                             : '';
            console.log('HubDbSync: bootstrapping ' + table + ': ' + fetched + ' row(s) fetched, ' +
                applied + ' applied, page ' + pagesFetched + ', through id ' + lastId + share +
                ', ' + elapsedS + 's elapsed (' + Math.round(fetched / elapsedS) + ' rows/s)');
        };

        // Rows held back for the batch, in wire order. The flush applies them as ONE
        // statement where it can and one at a time where it cannot, then runs the SAME
        // per-row bookkeeping and cursor advance either way - so the drain's accounting,
        // and its stop-at-the-first-unappliable-row rule, are what they were before
        // batching existed, whichever path ran.
        let pending      = [];
        let flushPending = async () => {
            if (pending.length === 0) return true;
            let batch   = pending.map(p => p.row);
            // A batch cannot express a per-row hold, so a drain under the mirror
            // horizon takes the per-row path. Batching is an optimization only, and
            // this is the same fallback a statement the driver rejects already takes.
            let batched = (batch.length > 1 && !(priceHorizon > 0)) ? await this._applyRowsBatched(table, batch) : false;
            let ok      = true;
            for (let entry of pending) {
                let row = entry.row;
                // Decide the bound BEFORE the apply, and record the round on both
                // sides of it. A row with no usable block_timestamp (0/absent) is never
                // bounded out - the bound only ever narrows on evidence.
                let boundOut = false;
                if (priceHorizon > 0) {
                    let rowTs = Number(row.block_timestamp);
                    if (Number.isFinite(rowTs) && rowTs > 0 && rowTs < priceHorizon) {
                        let finalizedRound = (String(row.status) === 'finalized');
                        if (finalizedRound) preHorizonServed.add(String(row.round_number));
                        if (rowTs < priceFloor) boundOut = true;
                        else if (finalizedRound) preHorizonRetained.add(String(row.round_number));
                    }
                }
                try {
                    if (boundOut) priceSkipped++;
                    else if (!batched) await this._applyRow(table, row);
                    if (servedMatchIds) {
                        servedMatchIds.add(String(row.match_id));
                        let sid = Number(row.id);
                        if (Number.isFinite(sid) && sid > maxServedId) maxServedId = sid;
                    }
                    if (servedPriceKeys) {
                        let rn = Number(row.round_number);
                        if (Number.isFinite(rn) && rn > maxServedRound) maxServedRound = rn;
                        // Only FINALIZED rows are recorded: every consensus read of this
                        // table filters status='finalized' (getLatestPrice, getPrice's
                        // MAX(round_number) join, _refreshPriceSyncHeight), so that is
                        // exactly the set whose contamination is load-bearing, and a hub
                        // that serves a round as skipped is stating it holds no finalized
                        // row there.
                        if (String(row.status) === 'finalized') {
                            if (servedPriceKeys.size >= PRICE_FINALIZED_KEY_CAP) priceKeysComplete = false;
                            else servedPriceKeys.add(priceRoundKey(row.round_number, row.coin_pair));
                        }
                    }
                    if (!boundOut) applied++;
                } catch (err) {
                    applyErrors++;
                    console.warn('HubDbSync: failed to apply row in ' + table + ':', err);
                    // Stop the page at the FIRST unappliable row. Advancing the cursor past it
                    // (here, or by applying a later row in this page and raising the local
                    // MAX(id)) would make the next retry's since_id = SELECT MAX(id) skip it
                    // forever, and once the retry drains cleanly the heartbeat gate opens over a
                    // PERMANENT mirror hole (BOOTSTRAP-HOLE-1). Leaving it (and everything after
                    // it) unapplied keeps local MAX(id) below the hole, so the retry re-fetches
                    // from it and fails closed until it applies. A persistent bad row wedges this
                    // table's barrier (defer) rather than silently forking - the module's
                    // fail-closed contract, same as the schema-mismatch path.
                    //
                    // A batch cannot hide such a row: _applyRowsBatched only reports success on a
                    // statement the driver accepted, and any other outcome sends every row in the
                    // chunk back through this loop one at a time, where the bad one still stops it.
                    ok = false;
                    break;
                }
                // Advance the cursor only for a row that actually applied - or that the
                // mirror bound deliberately declined, which is equally "handled" and can
                // leave no hole: price_snapshots is a FULL_REPAGE table, so its cursor
                // restarts at 0 on every drain and never carries this position forward.
                let rowId = Number(row.id);
                if (Number.isFinite(rowId) && rowId > lastId) lastId = rowId;
            }
            pending = [];
            reportProgress();
            return ok;
        };

        // One line up front for a table big enough to take a while, so a cold start shows
        // the drain BEGINNING rather than only its result. The counter above then reports
        // every bootstrapProgressMs until it lands.
        let announcedCeiling = Number(this._readyMaxIds && this._readyMaxIds[table]);
        if (Number.isFinite(announcedCeiling) && announcedCeiling > PAGE_LIMIT)
            console.log('HubDbSync: draining ' + table + ' from id ' + lastId +
                ' (the hub reports ' + announcedCeiling + ' as its highest id)');

        for (let page = 0; page < MAX_PAGES; page++) {
            let path = '/hub-db/snapshot/' + table + '?since_id=' + lastId + '&limit=' + PAGE_LIMIT;
            let result = await this._httpGet(path);
            if (!result || !Array.isArray(result.rows)) return null;

            // Schema-version handshake: the hub stamps each snapshot page with its
            // mirror schema_version. A mismatch means the hub's row shape differs from
            // what this indexer was built for, so applying these rows could drop a
            // consensus-relevant column and fork the ledger. Fail closed: return "not
            // drained" without applying, so _bootstrapAll retries and the barrier stays
            // shut, deferring blocks rather than settling against mismatched mirror data.
            // The != null guard keeps older hubs that send no version working unchanged.
            if (result.schema_version != null && result.schema_version !== HUB_SCHEMA_VERSION) {
                console.error('HubDbSync: hub snapshot schema_version ' + result.schema_version +
                    ' != local ' + HUB_SCHEMA_VERSION + ' for ' + table +
                    '; refusing to bootstrap. Restart this indexer after upgrading the hub.');
                return null;
            }

            pagesFetched++;
            for (let row of result.rows) {
                fetched++;
                pending.push({ row: row });
                // Flush on the chunk boundary; a failed flush already stopped at the bad row
                // and left the cursor below it, so this page is over.
                if (pending.length >= this.batchApplyRows && !(await flushPending())) break;
            }
            // Whatever the chunk boundary left behind. Skipped after a failure so the
            // already-cleared buffer is not re-walked and the hole is not stepped over.
            if (applyErrors === 0) await flushPending();
            lastPageCount = result.rows.length;
            // The LAST page's watermark is the hub's most recent "complete through ts"
            // statement covering everything fetched so far.
            if (Number.isFinite(Number(result.watermark))) watermark = Number(result.watermark);
            if (applyErrors > 0) break;                      // hole hit: stop paging, retry from it
            if (result.rows.length < PAGE_LIMIT) break;      // short page = drained
        }
        console.log('HubDbSync: bootstrapped ' + applied + ' rows into ' + table +
            (priceSkipped > 0 ? ' (' + priceSkipped + ' row(s) below the ' + priceFloor +
                ' mirror floor left unapplied)' : ''));

        // Defense-in-depth: if the hub told us its max_id at subscription time and our
        // local copy is still behind that ceiling, the REST snapshot window may have
        // missed rows that arrived right before the snapshot was served. Issue a targeted
        // catch-up for that narrow gap. Rows already local are ignored (INSERT IGNORE).
        // Skip the catch-up when the page loop already hit a hole (applyErrors>0): the table is
        // not drained regardless, and fetching past the hole would only widen it.
        // The FULL_REPAGE_TABLES are exempt: they always re-page from 0 (which already
        // covers the window this catch-up exists for), and their since_id=MAX(id) compare
        // is either meaningless (capability_snapshots' locally-assigned ids) or blind to the
        // in-place upgrades this catch-up would otherwise try to chase (#2491).
        let hubReadyMaxId = this._readyMaxIds && this._readyMaxIds[table];
        if (hubReadyMaxId && applyErrors === 0 && !FULL_REPAGE_TABLES.includes(table)) {
            // Same network scope as the cursor read: an unscoped MAX(id) here compares a
            // foreign hub's id against this hub's ceiling and reaches the opposite verdict
            // about whether a gap exists.
            let localMax = await this._localMaxId(table, scope);
            if (localMax < hubReadyMaxId) {
                console.log('HubDbSync: gap detected in ' + table + ' (local=' + localMax +
                            ' hub_ready=' + hubReadyMaxId + '), fetching catch-up rows');
                try {
                    let catchUpPath = '/hub-db/snapshot/' + table + '?since_id=' + localMax + '&limit=10000';
                    let catchUp = await this._httpGet(catchUpPath);
                    if (catchUp && Array.isArray(catchUp.rows)) {
                        // Same schema fail-closed as the page loop: a mismatched catch-up page
                        // could drop a consensus-relevant column, so refuse it and mark the
                        // table not-drained (CATCHUP-SCHEMA-BYPASS-1).
                        if (catchUp.schema_version != null && catchUp.schema_version !== HUB_SCHEMA_VERSION) {
                            console.error('HubDbSync: catch-up schema_version ' + catchUp.schema_version +
                                ' != local ' + HUB_SCHEMA_VERSION + ' for ' + table + '; skipping catch-up');
                            applyErrors++;
                        } else {
                            for (let row of catchUp.rows) {
                                // Count a swallowed catch-up apply error: leaving it silent left a
                                // hole while the gate still opened (CATCHUP-SCHEMA-BYPASS-1).
                                try { await this._applyRow(table, row); }
                                catch (e) {
                                    applyErrors++;
                                    console.warn('HubDbSync: catch-up apply failed for ' + table + ':', e);
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.warn('HubDbSync: catch-up fetch failed for ' + table + ':', err);
                }
            }
        }

        // Fully drained only if the final page wasn't full and everything applied.
        let fullyDrained = lastPageCount < PAGE_LIMIT && applyErrors === 0;

        // Mirror-bound acceptance check. The lookback is a SPAN IN SECONDS but the constraint it
        // has to satisfy is a COUNT OF ROUNDS (getOracleDataForVM's window), and only the
        // hub's own data says how many rounds a span holds - a deployment on a longer round
        // interval fits far fewer. So the drain measures what it actually kept and refuses to
        // certify a table it cut too thin: widen the span and report not-drained, which leaves
        // the barrier shut and sends _bootstrapAll around again (a re-page is idempotent -
        // every apply is an INSERT IGNORE/ODKU on the natural key). Past the ceiling the bound
        // gives up entirely and the next drain mirrors the table in full, because a bounded
        // mirror that cannot prove its own depth is worth less than a slow one.
        if (fullyDrained && priceHorizon > 0 &&
            preHorizonRetained.size < preHorizonServed.size &&
            preHorizonRetained.size < PRICE_MIRROR_MIN_PRE_HORIZON_ROUNDS) {
            let widened = this._priceMirrorLookbackS * PRICE_MIRROR_LOOKBACK_GROWTH;
            if (widened > PRICE_MIRROR_LOOKBACK_MAX_S) {
                this._priceMirrorBoundDisabled = true;        // full mirror from here on
                console.warn('HubDbSync: price mirror bound gave up after reaching its ' +
                    PRICE_MIRROR_LOOKBACK_MAX_S + 's ceiling with only ' + preHorizonRetained.size +
                    ' pre-horizon round(s); the next drain mirrors price_snapshots in full');
            } else {
                this._priceMirrorLookbackS = widened;
                console.warn('HubDbSync: price mirror bound kept only ' + preHorizonRetained.size +
                    ' of the ' + preHorizonServed.size + ' round(s) the hub holds below the horizon, ' +
                    'short of the ' + PRICE_MIRROR_MIN_PRE_HORIZON_ROUNDS + ' a consensus read can ' +
                    'reach; widening the lookback to ' + widened + 's and re-draining');
            }
            this._priceMirrorFloorTs = 0;
            return null;
        }

        // The floor the barriers police (see _notePriceMirrorFloor). Set only on a drain that
        // both bounded something and passed the check above; a full drain clears it.
        if (table === 'price_snapshots' && fullyDrained) {
            this._priceMirrorFloorTs = (priceSkipped > 0) ? priceFloor : 0;
            // A drain that bounded nothing IS the full mirror the re-floor was waiting for.
            if (priceSkipped === 0) this._priceMirrorRefloor = false;
        }

        // Reconcile the retractions the bootstrap can never re-deliver (#3211). Only after a
        // COMPLETE re-page: a partial drain has not seen every row the hub holds, so a
        // "missing" match may simply be on a page we never fetched.
        if (fullyDrained && servedMatchIds) await this._reconcileRetractedMatches(servedMatchIds, maxServedId);

        // Only arm this table's barrier state once it FULLY drained. The per-table refresh
        // sets <x>Bootstrapped = true and caches its scalar; on a PARTIAL drain (rows fetched
        // but thrown on apply, so the local table is empty or holed) that would arm the
        // barrier's empty-mirror NULL fast path and the `ts >= blockTime` content path -
        // NEITHER of which is gated on the global stream watermark - and the oracle/match/call
        // barriers would open against an incomplete mirror and fork (BOOTSTRAP-FLAG-PARTIAL-DRAIN;
        // unlike the price-height barrier, which has no empty fast path and safely DEFERS). A
        // partial drain returns null below, so _bootstrapAll retries with the gate shut. The
        // reconnect self-heal (_refreshAllSyncHeights) still refreshes from a complete local
        // mirror on its own path; this only withholds arming on an incomplete bootstrap.
        if (fullyDrained) {
            // Pass armBootstrap=true: this is the only path allowed to arm the
            // per-barrier <x>Bootstrapped flags, because only here has the table
            // fully drained. The refreshers otherwise default arming to
            // _bootstrapDrained so reconnect / live-row refreshes cannot arm from
            // a holed mirror (see #1788).
            if (table === 'price_snapshots') {
                // Clear the rounds this hub does not hold BEFORE the buffered replay and
                // before the height refresh. Ordering is load-bearing in both directions:
                // every live round that arrived during the drain is still BUFFERED (not
                // applied), so the pass cannot mistake one for a foreign row; and the
                // refresh below must read the cleaned table, or the barrier arms off a
                // height the mirror is about to lose.
                await this._reconcileForeignPriceRounds(servedPriceKeys, priceKeysComplete, maxServedRound);
                // Replay the live rounds buffered during this drain (#2422),
                // serialized through the message chain: every already-received
                // event is guaranteed buffered ahead of this task and no new
                // event can interleave mid-flush; the task flips _priceDrained
                // before the next event task runs, so the live apply path
                // resumes exactly at the replay boundary with no ordering gap.
                // A failed or disconnect-raced flush reports the table
                // not-drained (return null) so _bootstrapAll retries from the
                // still-contiguous local max, the same fail-closed contract as
                // the page loop (BOOTSTRAP-HOLE-1).
                let flushed = false;
                let epoch = this._wsEpoch;
                this._msgChain = this._msgChain.then(async () => {
                    flushed = await this._flushPendingPriceEvents();
                    if (flushed && epoch === this._wsEpoch) this._priceDrained = true;
                    else flushed = false;
                });
                await this._msgChain;
                if (!flushed) return null;
                await this._refreshPriceSyncHeight();
            }
            if (table === 'oracle_prices')       await this._refreshOracleSyncTimestamp(true);
            if (table === 'cross_chain_matches') await this._refreshMatchSyncTimestamp(true);
            if (table === 'cross_chain_calls')   await this._refreshCallSyncTimestamp(true);
            // A new match/call (new required snapshot_block) or an arriving snapshot can change
            // snapshot-presence: re-evaluate the snapshot barrier on any cross-chain table.
            if (CROSS_CHAIN_TABLES.indexOf(table) !== -1) await this._releaseSnapshotWaiters();
        }

        if (!fullyDrained) return null;
        return watermark !== null ? watermark : 0;
    }

    // The unix-second horizon for this drain's price_snapshots bound, or 0 when
    // the whole table is to be mirrored. 0 on every path that cannot PROVE a horizon: no
    // consumer hook (the explorer's display mirror), a hook that throws or returns a
    // non-positive/non-finite value, or a bound this instance has already given up on.
    // Fail-open is the only safe direction here: a wrong horizon costs a mirror that is
    // short of what a consensus read needs, and no drain is worth that.
    async _resolvePriceMirrorHorizon() {
        if (!this.getPriceMirrorHorizon || this._priceMirrorBoundDisabled) return 0;
        let horizon;
        try {
            horizon = await this.getPriceMirrorHorizon();
        } catch (e) {
            console.warn('HubDbSync: price mirror horizon unavailable (' + e.message +
                '); mirroring price_snapshots in full');
            return 0;
        }
        horizon = Number(horizon);
        if (!Number.isFinite(horizon) || horizon <= 0) return 0;
        // A horizon at or below the lookback would put the floor at/below zero, which is
        // every row there has ever been: no bound, and say so rather than pretending to one.
        if (horizon <= this._priceMirrorLookbackS) return 0;
        return horizon;
    }

    // Police the floor of a bounded price mirror. The bound is derived from the
    // OLDEST block this node expected to process; if it is ever asked to gate a block older
    // than that, the premise is gone - the mirror is missing rounds that block's price reads
    // can select, and a read against it would answer differently from a peer holding the
    // history. So abandon the bound, shut BOTH price barriers (and only those - the
    // oracle/match/call mirrors are complete and must keep serving), and re-mirror the table
    // in full. Fail-closed: blocks defer while the re-drain runs rather than settling against
    // a mirror that is knowingly short. Idempotent - the first call clears the floor, so the
    // re-drain is scheduled once however many waiters trip it.
    _notePriceMirrorFloor(blockTime) {
        if (!(this._priceMirrorFloorTs > 0)) return;
        blockTime = Number(blockTime);
        if (!Number.isFinite(blockTime) || blockTime <= 0) return;
        if (blockTime >= this._priceMirrorFloorTs) return;
        console.error('HubDbSync: block time ' + blockTime + ' is below the bounded price mirror floor ' +
            this._priceMirrorFloorTs + ' - this node is processing blocks older than the history its ' +
            'price mirror holds. Abandoning the bound and re-mirroring price_snapshots in full ' +
            '(blocks defer until it drains).');
        this._priceMirrorBoundDisabled = true;
        this._priceMirrorFloorTs       = 0;
        this._priceMirrorRefloor       = true;
        if (this.running) {
            Promise.resolve()
                .then(() => this._bootstrapAll())
                .catch(err => console.warn('HubDbSync: full price re-mirror failed to start:', err));
        }
    }

    // The network this mirror may hold rows for, or null when that cannot be proven.
    //
    // A hub is deployed per network and stamps its own network on every federation-state
    // row it serves, so a mirrored row carrying a different one was served by a hub this
    // mirror no longer follows. Two conditions must both hold before anything is scoped
    // on that basis: the consumer told this client which network it serves (the display
    // mirror in the explorer does not, and a null return leaves the unscoped behavior
    // exactly as it is), and the LOCAL mirror table actually carries the column. The
    // second check reads the primed column cache rather than a hardcoded table list, so
    // a table that gains or loses the column is picked up from the schema itself.
    async _mirrorNetworkScope(table) {
        if (typeof this.network !== 'string' || this.network === '') return null;
        let cols;
        try { cols = await this._localColumns(table); } catch (e) { return null; }
        return (cols && typeof cols.has === 'function' && cols.has('network')) ? this.network : null;
    }

    // Highest local id for a mirrored table, restricted to `scope`'s network when one was
    // proven. Returns 0 when nothing matches or the read fails (the table may not exist
    // yet), which starts the caller's cursor at the beginning of the hub's table.
    async _localMaxId(table, scope) {
        try {
            let sql  = 'SELECT MAX(id) AS max_id FROM ' + table + (scope ? ' WHERE network = ?' : '');
            let rows = await this.hubDb.doQuery(sql, scope ? [scope] : undefined);
            if (rows && rows.length > 0 && rows[0].max_id) return Number(rows[0].max_id);
        } catch (e) {
            // Table may not exist yet; the caller starts at 0.
        }
        return 0;
    }

    // Delete mirrored rows belonging to a network other than the one this mirror serves.
    //
    // Pointing an indexer at a hub for a different network leaves every row the earlier
    // hub served sitting in the mirror, carrying that hub's id space, and three separate
    // things break while they are there. Readers scope every query by network
    // (db.getPendingAnchorRewardAttestations), so the rows can never be consumed. The
    // bootstrap cursor is a MAX(id) over the table, so a foreign row with a higher id
    // than anything the current hub holds makes since_id ask for rows past the end of the
    // hub's table and the drain reports zero rows on every bootstrap for the life of the
    // mirror. And those foreign ids SIT ON the ids the current hub's own rows carry, where
    // the id-parity INSERT IGNORE apply drops the real row without an error, so scoping
    // the cursor on its own would still leave the mirror empty of the rows it should hold.
    //
    // Deletion is safe here in a way that "delete what the hub did not serve" is not:
    // belonging to another network is a property of the ROW, provable from the row and
    // this mirror's own configuration, with no dependence on what one snapshot response
    // happened to contain. A filtered snapshot endpoint, a paging hole or a partial drain
    // can each make a valid row look unserved; none of them can make it change network.
    async _purgeForeignNetworkRows(table, network) {
        let result;
        try {
            result = await this.hubDb.doQuery('DELETE FROM ' + table + ' WHERE network <> ?', [network]);
        } catch (e) {
            console.warn('HubDbSync: could not clear foreign-network rows from ' + table + ':', e);
            return 0;
        }
        // doQuery collapses a non-transactional query error into [], which carries no
        // affectedRows and is otherwise indistinguishable from a clean zero-row delete.
        // Say so: an unreported purge leaves the cursor poisoned and the table draining
        // zero rows, which is precisely the silent stall this method exists to end.
        let removed = Number(result && result.affectedRows);
        if (!Number.isFinite(removed)) {
            console.warn('HubDbSync: foreign-network purge of ' + table + ' reported no result; ' +
                'if the mirror keeps draining zero rows, this read is where to look');
            return 0;
        }
        if (removed <= 0) return 0;
        console.warn('HubDbSync: removed ' + removed + ' row(s) from ' + table + ' belonging to a network ' +
            'other than ' + network + '; a mirror holds only what the hub it follows serves, and those rows ' +
            'block both the id cursor and the id-parity apply');
        return removed;
    }

    // Clear a mirrored table whose local rows belong to an id space the hub no longer has.
    //
    // The trigger is the caller's ceiling comparison: the hub advertised its own MAX(id)
    // for this table and the local cursor sits above it. On an append-only, never-retracted
    // table (the only kind this fence governs) that is not possible while both sides share
    // an id space, so the source's has been replaced - a rebuilt hub database restarting
    // its auto-increment at 1, or a different hub on the same network.
    //
    // Why the whole scope and not just the rows above the ceiling. The rows above it are
    // provably gone from the source, but the ones at or below it are the worse half: after
    // a rebuild, local id 5 and hub id 5 are DIFFERENT ROWS that merely share a number, and
    // the id-parity INSERT IGNORE apply then drops the hub's real row on arrival without an
    // error. Leaving them would re-page the whole table and still mirror almost none of it.
    //
    // Scoped exactly like the cursor that detected the problem, so on a mirror serving one
    // network this touches only that network's rows and leaves a null scope unscoped rather
    // than widening the delete beyond what was proven.
    async _purgeRebuiltSourceRows(table, scope, localMax, ceiling) {
        // NO PROVEN SCOPE, NO DELETE. Without a network this would be an unqualified
        // DELETE FROM <table>, and the caller reaches here on evidence about an ID SPACE,
        // which is a far thinner warrant than a whole-table wipe. Two consumers land here
        // with a null scope: one that named no network (the explorer's display mirror) and
        // one whose mirror table has no network column, and neither has proven which rows
        // are even in scope. _mirrorNetworkScope and _purgeForeignNetworkRows already take
        // exactly this position, and it would be strange for the more speculative delete to
        // be the bolder one. The cursor still restarts, which is the pre-existing behaviour
        // for these consumers and leaves them no worse than before.
        if (!scope) {
            console.warn('HubDbSync: ' + table + ' cursor ' + localMax + ' sits above the hub ceiling ' +
                ceiling + ', but this mirror has no proven network scope, so the retired rows are LEFT IN ' +
                'PLACE (an unscoped delete here would clear the whole table). Re-paging only; if this mirror ' +
                'keeps serving rows the hub does not have, give it a network.');
            return 0;
        }
        let result;
        try {
            result = await this.hubDb.doQuery('DELETE FROM ' + table + ' WHERE network = ?', [scope]);
        } catch (e) {
            console.warn('HubDbSync: could not clear the stale id space from ' + table + ':', e);
            return 0;
        }
        // Same reasoning as the foreign-network purge: doQuery collapses a non-transactional
        // error into [], which is indistinguishable from a clean zero-row delete. Say so,
        // because an unreported purge here leaves the id-parity collision in place and the
        // re-page below then applies almost nothing, which is the silent stall this exists to end.
        let removed = Number(result && result.affectedRows);
        if (!Number.isFinite(removed)) {
            console.warn('HubDbSync: rebuilt-source purge of ' + table + ' reported no result; ' +
                'if the mirror keeps serving rows the hub does not have, this read is where to look');
            return 0;
        }
        if (removed <= 0) return 0;
        console.warn('HubDbSync: removed ' + removed + ' row(s) from ' + table + ' carrying a retired id space ' +
            '(local cursor ' + localMax + ' above the hub ceiling ' + ceiling + '); the mirror will be rebuilt ' +
            'from the hub in full');
        return removed;
    }

    // Converge the half of a retract/revive the bootstrap cannot re-deliver (#3211).
    //
    // The hub never DELETEs a retracted match: retractMatchesForReorg UPDATEs it to
    // status='retracted' and broadcasts a deletion event, and the snapshot endpoint then
    // filters those rows out (`status <> 'retracted'`) so a bootstrapping mirror matches a
    // streamed one. That works only while the mirror SAW the deletion. A mirror that was
    // disconnected across the retraction - or that legitimately refused the event under the
    // receive-side guards - holds a finalized row the hub has retracted, and
    // no later delivery can fix it: the row is absent from every bootstrap page, so the
    // convergence ODKU never gets a version to compare against. The mirror keeps settling a
    // match the hub retracted, which is a money-bearing fork from a streamed peer.
    //
    // After a COMPLETE re-page, a local finalized row whose id is at or below the highest id
    // the hub served, and whose match_id the hub did not serve at all, can only be such a
    // retraction: ids are hub-parity and ascending, the hub never deletes, and the pages
    // covered every non-retracted row up to that ceiling. Rows ABOVE the ceiling are exempt -
    // they are newer than this snapshot and may simply have arrived after it.
    //
    // Converge by marking status='retracted', NOT by deleting:
    //   - consensus reads filter status='finalized' (db.getEffectiveUnsettledMatches), so the
    //     settlement effect is identical to the DELETE the streamed path applies;
    //   - a REVIVE is still able to win it back, because the convergence ODKU compares a
    //     later effective_time (a delete would leave the revive to INSERT, which is also
    //     fine, but marking keeps the row's provenance and matches AnchorRecovery's already
    //     documented retracted-row carve-out);
    //   - a mistaken mark is fail-CLOSED (a match stops settling), where a mistaken delete
    //     would also lose the signed row itself.
    async _reconcileRetractedMatches(servedMatchIds, maxServedId) {
        if (!Number.isFinite(maxServedId) || maxServedId <= 0) return;   // nothing served, nothing to judge
        let locals;
        try {
            locals = await this.hubDb.doQuery(
                "SELECT id, match_id FROM cross_chain_matches WHERE id <= ? AND status = 'finalized'", [maxServedId]);
        } catch (e) {
            console.warn('HubDbSync: match retraction reconciliation skipped (read failed):', e);
            return;
        }
        let stale = (locals || []).filter(r => !servedMatchIds.has(String(r.match_id))).map(r => Number(r.id));
        if (stale.length === 0) return;
        // Chunked so one oversized IN list can never blow the statement limit.
        for (let i = 0; i < stale.length; i += 500) {
            let chunk = stale.slice(i, i + 500);
            try {
                await this.hubDb.doQuery(
                    "UPDATE cross_chain_matches SET status = 'retracted' WHERE id IN (" +
                    chunk.map(() => '?').join(',') + ") AND status = 'finalized'", chunk);
            } catch (e) {
                console.warn('HubDbSync: match retraction reconciliation failed for a chunk:', e);
                return;
            }
        }
        console.warn('HubDbSync: reconciled ' + stale.length + ' cross_chain_matches row(s) the hub has retracted ' +
                     'but this mirror still held as finalized (missed retraction converged, #3211)');
        await this._refreshMatchSyncTimestamp();
    }

    // Clear finalized price rounds this hub does not hold.
    //
    // Repointing an indexer at a different hub - another network, a rebuilt database, a
    // re-genesised testnet - leaves every round the previous hub served sitting in the
    // mirror. price_snapshots is the one mirrored table with NO defence against that.
    // It carries no `network` column, so _mirrorNetworkScope returns null and both
    // _purgeForeignNetworkRows and _purgeRebuiltSourceRows are unreachable for it; and
    // being a FULL_REPAGE table its cursor is forced to 0, so the id-ceiling fence that
    // detects a retired id space never runs. The re-page then converges only the keys the
    // two hubs SHARE, because _applyRow's upsert is keyed on (round_number, coin_pair):
    // a foreign round the new hub has never reached is simply never addressed.
    //
    // Those survivors are not inert. Every consensus read takes the NEWEST finalized row
    // by round_number - db.getLatestPrice (ORDER BY round_number DESC LIMIT 1, the native
    // fee gate's price source) and the getPrice() preload (MAX(round_number) per pair) -
    // so a foreign round numbered above anything the new hub has reached wins every read
    // for the life of the mirror, and its old block_timestamp then fails the staleness
    // guard. That is the observed shape: a correctly-configured LTC testnet indexer
    // serving a 4.4-day-old XCHAIN/USD and a frozen LTC/USD with the fee gate shut, on a
    // mirror that was never going to converge, until the table was purged by hand.
    //
    // What makes the delete provable, and why it is a stronger warrant than the two
    // purges above rather than a weaker one: the hub's price_snapshots snapshot endpoint
    // applies NO filter (`SELECT * FROM price_snapshots WHERE id > ?`), unlike the
    // status-filtered match/call feeds. So a COMPLETE drain - short final page, zero apply
    // errors, which is the only state this runs in - has seen every row the hub holds. A
    // local finalized row at a key that drain did not serve as finalized is therefore a
    // row the hub does not have: either a round it never produced, or one it holds as
    // skipped/disputed, which the status-gated upsert deliberately refuses to downgrade.
    // Neither is recoverable by any later delivery, exactly like the retraction
    // _reconcileRetractedMatches converges.
    //
    // Delete rather than mark: unlike a match, a price round has no status consensus
    // treats as a tombstone (a 'skipped' row IS a legitimate hub row), and the hub's own
    // row for that key re-arrives on the next drain if it exists. Local `skipped` rows are
    // left alone: no consensus read sees them, and the upsert converges them in place.
    async _reconcileForeignPriceRounds(servedKeys, keysComplete, maxServedRound) {
        if (!servedKeys) return;
        let locals, stale;
        if (!keysComplete) {
            // The set overflowed its memory cap, so absence from it proves nothing. Fall
            // back to the weaker half that needs no set: the drain saw every row the hub
            // holds, so no round above the highest it served exists there. This still
            // clears the shape that poisons the ORDER BY round_number DESC readers, and
            // leaves any lower-numbered foreign round for the operator.
            console.warn('HubDbSync: price round reconciliation exceeded its key cap (' +
                PRICE_FINALIZED_KEY_CAP + '); falling back to the round-ceiling rule ' +
                '(rounds above ' + maxServedRound + ' only)');
            try {
                locals = await this.hubDb.doQuery(
                    "SELECT id FROM price_snapshots WHERE status = 'finalized' AND round_number > ?",
                    [maxServedRound]);
            } catch (e) {
                console.warn('HubDbSync: price round reconciliation skipped (read failed):', e);
                return;
            }
            stale = (locals || []).map(r => Number(r.id)).filter(Number.isFinite);
        } else {
            try {
                locals = await this.hubDb.doQuery(
                    "SELECT id, round_number, coin_pair FROM price_snapshots WHERE status = 'finalized'");
            } catch (e) {
                console.warn('HubDbSync: price round reconciliation skipped (read failed):', e);
                return;
            }
            locals = locals || [];
            stale = locals
                .filter(r => !servedKeys.has(priceRoundKey(r.round_number, r.coin_pair)))
                .map(r => Number(r.id))
                .filter(Number.isFinite);
            // Sanity fence on the KEY DERIVATION itself, not on the data. Every finalized
            // row this drain served was applied to the local table moments ago, so it must
            // read back into the served set. If the hub served finalized rounds and NOT ONE
            // local finalized row matched, the two sides are not producing the same key
            // (a column rename, a driver type change) and this pass would empty a healthy
            // mirror. Refuse, loudly: a stalled reconciliation is recoverable, a wiped
            // price history under a mirror the operator believes is converging is not.
            if (servedKeys.size > 0 && locals.length > 0 && stale.length === locals.length) {
                console.error('HubDbSync: price round reconciliation refused: the hub served ' +
                    servedKeys.size + ' finalized round(s) but NONE of the ' + locals.length +
                    ' local finalized row(s) matched a served key. That is a key-derivation ' +
                    'mismatch, not contamination; leaving the mirror untouched.');
                return;
            }
        }
        if (stale.length === 0) return;
        // Chunked so one oversized IN list can never blow the statement limit.
        for (let i = 0; i < stale.length; i += 500) {
            let chunk = stale.slice(i, i + 500);
            try {
                await this.hubDb.doQuery(
                    'DELETE FROM price_snapshots WHERE id IN (' + chunk.map(() => '?').join(',') + ')', chunk);
            } catch (e) {
                console.warn('HubDbSync: price round reconciliation failed for a chunk:', e);
                return;
            }
        }
        console.warn('HubDbSync: removed ' + stale.length + ' finalized price_snapshots row(s) this hub does ' +
            'not hold (a repointed or rebuilt hub leaves the previous one\'s rounds behind, and the newest ' +
            'round_number wins every price read); the mirror now holds only what this hub serves');
        await this._refreshPriceSyncHeight();
    }

    // Re-read EVERY barrier height/timestamp from the local mirror and release the
    // now-satisfied waiters. The in-memory heights only advance on stream/bootstrap
    // events, so a dropped socket can leave them frozen behind a mirror that is
    // actually current, so deferred blocks wait out the full 60s self-heal
    // timeout (per-block, biting faster chains hardest). Calling this on the
    // reconnect edge clears those waiters immediately from data already local.
    // Cheap (MAX()/MAX-timestamp reads) and idempotent; each refresh is internally
    // guarded so one failure can't abort the others.
    async _refreshAllSyncHeights() {
        try { await this._refreshPriceSyncHeight(); }     catch (e) { /* internally guarded */ }
        try { await this._refreshOracleSyncTimestamp(); } catch (e) { /* internally guarded */ }
        try { await this._refreshMatchSyncTimestamp(); }  catch (e) { /* internally guarded */ }
        try { await this._refreshCallSyncTimestamp(); }   catch (e) { /* internally guarded */ }
        try { await this._releaseSnapshotWaiters(); }     catch (e) { /* internally guarded */ }
    }

    // Recompute the highest finalized price block present in the local price_snapshots
    // copy and release any barrier waiters that are now satisfied. Called after every
    // successful sync of the table (bootstrap, poll, live insert, reorg retraction).
    async _refreshPriceSyncHeight() {
        let height = 0, maxTs = 0;
        try {
            let rows = await this.hubDb.doQuery(
                "SELECT MAX(reference_block) AS h, MAX(block_timestamp) AS ts FROM price_snapshots WHERE status = 'finalized'"
            );
            if (rows.length > 0 && rows[0].h  != null) height = Number(rows[0].h);
            if (rows.length > 0 && rows[0].ts != null) maxTs  = Number(rows[0].ts);
        } catch (e) {
            return;                                         // table not ready yet; leave height untouched
        }
        this.priceSyncHeight       = height;
        this.priceSyncMaxTimestamp = maxTs;
        this.priceBootstrapped     = true;                  // mirror read successfully at least once
        this._releasePriceWaiters();
        this._releasePriceTimeWaiters();
    }

    // Whether the price mirror is caught up enough to safely process a block at
    // (blockHeight, blockTime). Two satisfied cases:
    //   1. A finalized round anchored at or past this height is local; every round
    //      eligible at this height is therefore local (rows arrive id-ordered, and
    //      live rows are buffered until the bootstrap drain completes, so the
    //      local mirror is always a CONTIGUOUS run of the hub's table ending at its
    //      newest row; a fresh round streamed mid-drain can no longer raise the
    //      height over still-missing earlier rounds. See _bufferPriceEvent, #2422).
    //      Under the bootstrap bound that run starts at the mirror floor
    //      rather than at the hub's first row, which is sound for exactly the blocks
    //      the floor was derived from and no others - hence _notePriceMirrorFloor,
    //      which vetoes this case outright once a block below the floor turns up.
    //   2. The hub's stream watermark has passed this block's time plus a grace
    //      margin covering PBFT finalization lag (the hub has told us everything
    //      it produced through that instant, so the set of rounds at or before this
    //      height is FINAL (a round anchored ≤ H is finalized within grace of
    //      time(H); none can appear later). This is what lets a fresh distributed
    //      BTC indexer bootstrap on a chain with no rounds yet (#1986) and lets
    //      the tip proceed deterministically through an oracle round gap, while a
    //      genuinely-behind mirror (hub unreachable → watermark frozen) still
    //      defers). blockTime may be absent (legacy callers), so then only case 1.
    _priceSyncSatisfied(blockHeight, blockTime) {
        // A mirror that was bounded and has since been asked for a block below its
        // floor holds neither case: its height says "caught up" while rounds that block can
        // read are absent. Defer until the full re-mirror lands. Never set on an unbounded
        // mirror, so this costs nothing on the default path.
        if (this._priceMirrorRefloor) return false;
        if (this.priceSyncHeight >= blockHeight) return true;
        if (this.priceBootstrapped && Number.isFinite(blockTime) &&
            this.streamWatermark >= blockTime + this.priceWatermarkGraceS) return true;
        return false;
    }

    // Resolve any pending waiters whose target is now covered.
    _releasePriceWaiters() {
        if (this._priceWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._priceWaiters) {
            if (this._priceSyncSatisfied(w.height, w.blockTime)) {
                clearTimeout(w.timer);
                w.resolve(this.priceSyncHeight);
            } else {
                stillWaiting.push(w);
            }
        }
        this._priceWaiters = stillWaiting;
    }

    // Block-processing sync barrier. Resolves once the local price_snapshots copy holds a
    // finalized round anchored at reference_block >= blockHeight (i.e. this node has caught
    // up to the hub for that block, so every round eligible at this block is already local).
    // Rejects after timeoutMs so the caller can DEFER the block and retry; never validate
    // native-coin fees against a stale local mirror.
    //
    // Price rounds are anchored to the oracle reference chain's block height (reference_block),
    // so this comparison is only meaningful for an indexer whose own chain IS that reference
    // chain. Callers on other chains must not gate on this; see XChainIndexer.
    waitForPriceSyncHeight(blockHeight, timeoutMs, blockTime) {
        blockHeight = Number(blockHeight);
        blockTime   = Number(blockTime);
        // Nothing to wait on when sync is disabled (single-host: the local hub DB is the hub
        // itself, always current) or the target is not a finite height.
        if (!this.enabled || !Number.isFinite(blockHeight)) return Promise.resolve(this.priceSyncHeight);
        // Before judging the block, judge the mirror against the block.
        this._notePriceMirrorFloor(blockTime);
        if (this._priceSyncSatisfied(blockHeight, blockTime)) return Promise.resolve(this.priceSyncHeight);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { height: blockHeight, blockTime: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                // Self-heal before giving up: the in-memory priceSyncHeight only
                // advances when a stream/bootstrap event drives _refreshPriceSyncHeight,
                // so a missed refresh on a stream/reconnect edge can leave it frozen
                // behind a local mirror DB that is actually current, and then EVERY
                // tip block deferred the full timeout even though the data was present
                // (BTC mainnet 2026-06-13: in-memory stuck at the restart block while
                // price_snapshots had caught up; only a process restart cleared it).
                // Re-read the DB here; _refreshPriceSyncHeight resolves+clears this
                // waiter via _releasePriceWaiters if the mirror has since caught up.
                try { await this._refreshPriceSyncHeight(); } catch (e) { /* fall through to reject */ }
                if (this._priceSyncSatisfied(blockHeight, blockTime)) return;   // already resolved by the refresh
                this._priceWaiters = this._priceWaiters.filter(w => w !== waiter);
                reject(new Error('price sync barrier timed out after ' + ms + 'ms waiting for block ' +
                                 blockHeight + ' (price mirror at ' + this.priceSyncHeight +
                                 ', stream watermark at ' + this.streamWatermark + ')'));
            }, ms);
            this._priceWaiters.push(waiter);
        });
    }

    // Whether the price mirror is caught up enough to safely process a block at
    // blockTime. Applies on EVERY chain (BTC included, additively with the
    // height-keyed barrier) and is not gated on the NATIVE_FEE_PRICE_TIME_GATE
    // flag-day; H-3 named the fee-query half of that work, not this barrier.
    // Two satisfied cases, mirroring _priceSyncSatisfied:
    //   1. The mirror already holds a finalized round whose consensus timestamp
    //      is at/past this block's time, so every round eligible at this block
    //      (block_timestamp <= blockTime) is already local.
    //   2. The hub's stream watermark has passed this block's time plus the
    //      grace margin: the hub has sent everything it produced through that
    //      instant, so the eligible set is FINAL. This is also what lets a
    //      chain proceed deterministically when no rounds exist yet, while a
    //      genuinely-behind mirror (hub unreachable → watermark frozen) defers.
    _priceTimeSyncSatisfied(blockTime) {
        if (!Number.isFinite(blockTime)) return true;       // nothing to gate on
        if (this._priceMirrorRefloor)    return false;      // see _priceSyncSatisfied
        if (this.priceBootstrapped && this.priceSyncMaxTimestamp >= blockTime) return true;
        if (this.priceBootstrapped &&
            this.streamWatermark >= blockTime + this.priceWatermarkGraceS) return true;
        return false;
    }

    // Resolve any pending time-keyed waiters whose target is now covered.
    _releasePriceTimeWaiters() {
        if (this._priceTimeWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._priceTimeWaiters) {
            if (this._priceTimeSyncSatisfied(w.ts)) {
                clearTimeout(w.timer);
                w.resolve(this.priceSyncMaxTimestamp);
            } else {
                stillWaiting.push(w);
            }
        }
        this._priceTimeWaiters = stillWaiting;
    }

    // Block-processing sync barrier for every time-keyed reader of price_snapshots:
    // native-coin fee validation on non-reference chains (H-3) AND FIAT dispenser
    // settlement, which reads by time on all chains. Resolves once the local
    // price_snapshots copy holds every finalized round with block_timestamp <= this
    // block's time, so a time-gated selection reads the same round on every indexer of
    // this chain. Rejects after timeoutMs so the caller can DEFER the block and retry;
    // never settle or validate against a stale local mirror. Runs on BTC too, ADDITIVELY
    // with the height-keyed waitForPriceSyncHeight barrier above, which is retained for
    // the height-selected fee query below the flag-day (XChainIndexer.js:877-932).
    waitForPriceSyncTime(blockTime, timeoutMs) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.priceSyncMaxTimestamp);
        this._notePriceMirrorFloor(blockTime);            // same check as the height barrier
        if (this._priceTimeSyncSatisfied(blockTime))       return Promise.resolve(this.priceSyncMaxTimestamp);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                // Same self-heal as waitForPriceSyncHeight: re-read the mirror
                // before giving up, in case a refresh was missed on a stream edge.
                try { await this._refreshPriceSyncHeight(); } catch (e) { /* fall through to reject */ }
                if (this._priceTimeSyncSatisfied(blockTime)) return;   // resolved by the refresh
                this._priceTimeWaiters = this._priceTimeWaiters.filter(w => w !== waiter);
                reject(new Error('price time-sync barrier timed out after ' + ms + 'ms waiting for block time ' +
                                 blockTime + ' (mirror max round timestamp ' + this.priceSyncMaxTimestamp +
                                 ', stream watermark at ' + this.streamWatermark + ')'));
            }, ms);
            this._priceTimeWaiters.push(waiter);
        });
    }

    // Recompute the highest effective_at present in the local oracle_prices copy and release
    // any barrier waiters that are now satisfied. Called after every successful sync of the
    // table (bootstrap, poll, live insert, reorg retraction). A NULL max (empty mirror) is a
    // valid result; it means this deployment has no oracle prices, which oracleBootstrapped
    // distinguishes from "not synced yet".
    async _refreshOracleSyncTimestamp(armBootstrap = this._bootstrapDrained) {
        let ts = null;
        try {
            let rows = await this.hubDb.doQuery('SELECT MAX(effective_at) AS ts FROM oracle_prices');
            if (rows.length > 0 && rows[0].ts !== null) ts = Number(rows[0].ts);
        } catch (e) {
            return;                                         // table not ready yet; leave state untouched
        }
        this.oracleSyncTimestamp = ts;                      // number, or null when the mirror holds no oracle prices
        // Arm the empty-mirror barrier flag only when a full bootstrap drain is in
        // effect. A refresh from the reconnect edge (_refreshAllSyncHeights, before
        // re-bootstrap) or a single live row arriving mid-partial-bootstrap defaults
        // armBootstrap to _bootstrapDrained (false then), so it cannot arm the NULL
        // fast path in _oracleSyncSatisfied against a holed mirror and fork (#1788).
        if (armBootstrap) this.oracleBootstrapped = true;   // read at least once AND fully drained
        this._releaseOracleWaiters();
    }

    // Whether the local oracle mirror is caught up enough to safely settle a block at blockTime.
    // Two distinct "satisfied" cases:
    //   1. The mirror has been read and holds no oracle prices at all; nothing to gate on.
    //   2. The mirror holds prices whose newest effective_at is at or past this block's time,
    //      so every price effective at or before blockTime is already local.
    _oracleSyncSatisfied(blockTime) {
        if (this.oracleBootstrapped && this.oracleSyncTimestamp === null) return true;
        if (this.oracleSyncTimestamp !== null && this.oracleSyncTimestamp >= blockTime) return true;
        // Stream watermark: the hub has sent us every row it produced through
        // blockTime + grace, so the set of prices effective at or before this
        // block is final, so quiet oracles must not stall the chain (#1984). The
        // grace margin covers first-publish rows arriving after their (retro-
        // active) effective_at; see the PriceAggregator retroactivity finding.
        if (this.oracleBootstrapped && this.streamWatermark >= blockTime + this.oracleWatermarkGraceS) return true;
        return false;
    }

    // Resolve any pending waiters whose target time is now covered.
    _releaseOracleWaiters() {
        if (this._oracleWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._oracleWaiters) {
            if (this._oracleSyncSatisfied(w.ts)) {
                clearTimeout(w.timer);
                w.resolve(this.oracleSyncTimestamp);
            } else {
                stillWaiting.push(w);
            }
        }
        this._oracleWaiters = stillWaiting;
    }

    // Block-processing sync barrier for FIAT dispenser settlement. Resolves once the local
    // oracle_prices copy holds every price effective at or before this block's median time
    // (block_time), so reverseOraclePriceMatch() reads the same effective price set on every
    // indexer. Rejects after timeoutMs so the caller can DEFER the block and retry; never
    // settle a FIAT dispenser against a stale local oracle mirror.
    //
    // Oracle prices are keyed by wall-clock effective_at (not a chain block height), so unlike
    // waitForPriceSyncHeight this comparison is meaningful (and required) on every chain.
    // Resolves immediately when sync is disabled (single-host: the local hub DB is the hub
    // itself, always current) or when the mirror is known to hold no oracle prices at all.
    waitForOracleSyncTimestamp(blockTime, timeoutMs) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.oracleSyncTimestamp);
        if (this._oracleSyncSatisfied(blockTime))          return Promise.resolve(this.oracleSyncTimestamp);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                // Self-heal before giving up, same as waitForPriceSyncHeight: the in-memory
                // oracleSyncTimestamp only advances when a stream/bootstrap event drives
                // _refreshOracleSyncTimestamp, so a missed refresh on a stream/reconnect
                // edge can leave it stale behind a local mirror that is actually current,
                // and then every block deferred the full timeout even though the data was
                // present. Re-read the DB here; _refreshOracleSyncTimestamp resolves+clears
                // this waiter via _releaseOracleWaiters if the mirror has since caught up.
                try { await this._refreshOracleSyncTimestamp(); } catch (e) { /* fall through to reject */ }
                if (this._oracleSyncSatisfied(blockTime)) return;   // already resolved by the refresh
                this._oracleWaiters = this._oracleWaiters.filter(w => w !== waiter);
                reject(new Error('oracle sync barrier timed out after ' + ms + 'ms waiting for block_time ' +
                                 blockTime + ' (oracle mirror at ' + this.oracleSyncTimestamp + ')'));
            }, ms);
            this._oracleWaiters.push(waiter);
        });
    }

    // Apply a run of price_snapshots rows in ONE multi-row upsert.
    //
    // Returns true only when every row in `rows` landed in that single statement;
    // false means "not applied, use the per-row path", and the caller then applies
    // the same rows through _applyRow in order. Never throws for that reason: the
    // decision to batch must never be able to fail a drain that the per-row path
    // would have completed.
    //
    // Applicability is deliberately narrow. price_snapshots only (the one mirrored
    // table large enough for the round-trips to dominate), only when every row
    // presents the identical mirrored column list (so one placeholder tuple is
    // correct for all of them), and only when `status` is among those columns,
    // which is the same condition _applyRow's price branch requires before it uses
    // the ODKU upgrade path. Anything else declines.
    //
    // Rows sharing a natural key inside one statement are safe: MariaDB evaluates
    // the ODKU per row against what the statement has already written, and the
    // skipped -> finalized upgrade is keyed on VALUES(status), so a chunk holding
    // both states for one round converges to the same row either order.
    async _applyRowsBatched(table, rows) {
        if (table !== 'price_snapshots') return false;
        if (this._batchApplyDisabled) return false;
        if (!Array.isArray(rows) || rows.length < 2) return false;

        let allowed;
        try {
            allowed = await this._localColumns(table);
        } catch (e) {
            return false;                                    // not ready: the per-row path reports it
        }

        let cols = Object.keys(rows[0]).filter(c => allowed.has(c));
        if (cols.length === 0 || !cols.includes('status')) return false;
        let signature = cols.join('');

        let args = [];
        for (let row of rows) {
            let rowCols = Object.keys(row).filter(c => allowed.has(c));
            if (rowCols.join('') !== signature) return false;
            for (let c of cols) args.push(coerceMirrorValue(row[c], this._cachedColumnType(table, c)));
        }

        let result;
        try {
            result = await this.hubDb.doQuery(priceUpsertSql(cols, rows.length), args);
        } catch (e) {
            result = null;                                   // treated as "did not land", below
        }
        // doQuery SWALLOWS a query error for a non-transactional statement and returns its
        // `[]` default; a statement that ran comes back as the driver's OK result object.
        // An array (or a throw, or nothing) therefore means this batch did not land, and the
        // caller must re-apply these rows one at a time - where a genuine failure is visible
        // per row and stops the page at the offending row, as it always did.
        if (!result || Array.isArray(result)) {
            if (!this._batchApplyWarned) {
                this._batchApplyWarned = true;
                console.warn('HubDbSync: batched ' + table + ' upsert did not land; falling back to ' +
                    'per-row applies for this drain (set HUB_SYNC_BATCH_APPLY=false to disable batching)');
            }
            return false;
        }
        return true;
    }

    // Apply a row to the local hub DB (INSERT IGNORE to keep idempotent).
    // Columns are FILTERED to the local mirror table's schema: the hub may serve
    // columns the mirror deliberately does not carry (e.g. state_checkpoints'
    // hub-side anchor_txid audit column; see src/sql/state_checkpoints.sql), and
    // the hub side can gain columns before this indexer updates. Without the
    // filter, one new hub column turns every mirrored insert for that table into
    // ER_BAD_FIELD_ERROR and silently kills the mirror (fleet incident 2026-06-11:
    // anchor_txid landed with the ANCHOR rollout and stopped all state_checkpoints
    // mirroring). Unknown columns are dropped, never errors.
    async _applyRow(table, row) {
        let allowed = await this._localColumns(table);
        let cols = Object.keys(row).filter(c => allowed.has(c));
        // capability_snapshots is a NATURAL-KEY mirror (uq_cap_snap: snapshot_block,
        // capability, signing_pubkey, source; no reader keys on id). `source` is the
        // fourth key column on purpose: a key delegated by two sources yields
        // one row per source, and a 3-column key collapses them on INSERT IGNORE and
        // drops the second source. Hub ids are hub-LOCAL
        // (every hub persists these rows independently via an id-less INSERT IGNORE)
        // and AnchorRecovery rebuilds the table id-less too, so a wire id can collide
        // with a locally-assigned PK and INSERT IGNORE would silently drop the row -
        // a permanent mirror hole (#2270). Drop the id and let local AUTO_INCREMENT
        // assign; _bootstrapTable pages this table from since_id=0 for the same reason.
        // cross_chain_matches/calls keep hub id parity deliberately (settlement-order key).
        //
        // attestation_responses strips id for the same reason arrived at by a different route.
        // Its ids are hub-LOCAL because the artifact is written more than once: the responsible
        // set reaches quorum on one hub, the result is gossiped to the rest of the federation
        // (ATTEST_RESULT), and every hub that verifies it inserts its OWN row, so two hubs carry
        // different ids for one logical row and a hub failover would re-deliver the same response
        // under a new id. Row identity is the natural key UNIQUE (network, request_id) - which is
        // also what makes the re-delivery a harmless INSERT IGNORE no-op - and no reader keys on
        // id. Keeping a wire id would let it collide with a locally-assigned PK and have INSERT
        // IGNORE silently drop a real response, and a dropped response here is not a stale read:
        // the applier never binds it, the callback never fires on this node alone, and the node
        // forks. FULL_REPAGE_TABLES membership follows directly from this strip.
        if (table === 'capability_snapshots' || table === 'attestation_responses') cols = cols.filter(c => c !== 'id');
        if (cols.length === 0) return;
        let placeholders = cols.map(() => '?').join(', ');
        let args = cols.map(c => coerceMirrorValue(row[c], this._cachedColumnType(table, c)));

        // price_snapshots needs an in-place upgrade path, not plain INSERT IGNORE.
        // It carries UNIQUE (round_number, coin_pair). The hub writes a 'skipped'
        // placeholder when a BTC round had no local submissions, and the bootstrap
        // endpoint serves it, so a replica can already hold the skipped row. When
        // the hub later finalizes that round from a peer-chain validated round
        // (PriceAggregator.receiveValidatedRound upserts skipped→finalized and
        // broadcasts it), a plain INSERT IGNORE here would drop the upgrade and
        // strand the replica at price=NULL while the master shows finalized;
        // exactly the ledger divergence the price-sync barrier guards against.
        // Upgrade only when the INCOMING row is finalized (keyed on VALUES(status),
        // stable regardless of ODKU assignment order), so an already-finalized
        // local row is never clobbered and re-delivery stays idempotent.
        if (table === 'price_snapshots' && cols.includes('status')) {
            // priceUpsertSql(cols, 1) is this branch's original statement, moved out so the
            // bootstrap's multi-row batch emits the same ODKU body by construction.
            await this.hubDb.doQuery(priceUpsertSql(cols, 1), args);
            return;
        }

        // cross_chain_calls needs the same in-place upgrade path as price_snapshots,
        // not plain INSERT IGNORE. It carries UNIQUE (call_id, phase). A replica can
        // already hold an older row for that key (an earlier-stream survivor). Note a
        // source-chain reorg does NOT leave a status='retracted' row: _applyRetraction
        // DELETEs the mirrored row outright on the deletion event, so a retracted key is
        // simply absent locally, never locally queryable with a retracted status. When
        // the hub later re-finalizes the re-mined call (CrossChainCallEngine._writeFinalizedRow
        // upserts the current quorum's content via ON DUPLICATE KEY UPDATE and rebroadcasts),
        // a plain INSERT IGNORE here would drop the upgrade and strand the replica on the
        // stale row. Because effective_time is in the signed canonical and
        // gates the injection block, a divergent copy would inject at a different block.
        // Upgrade only when the INCOMING row is finalized (keyed on VALUES(status),
        // stable regardless of ODKU assignment order), so an already-finalized local
        // row is never clobbered and re-delivery stays idempotent.
        // push_generation is the item-5308 reorg FENCE, not ordinary content, so it is held
        // OUT of the status gate and only ever moves UP, the same rule cross_chain_matches
        // applies to a_/b_push_generation. Inside the gate a finalized row carrying a LOWER
        // generation lowered it, and the fenced retraction (DELETE ... WHERE push_generation
        // <= gen) then matched a row re-published ABOVE that fence and blew a permanent hole
        // in the mirror. The lowering is reachable because cross_chain_calls live rows apply
        // DURING the REST bootstrap drain (only price_snapshots buffers, #2422), so a page
        // fetched before a re-publish can land after the live re-published row.
        if (table === 'cross_chain_calls' && cols.includes('status')) {
            let fence     = cols.includes('push_generation');
            let updatable = cols.filter(c => c !== 'id' && c !== 'call_id' && c !== 'phase' && c !== 'status'
                                             && c !== 'push_generation');
            let sets = updatable.map(c => '`' + c + "` = IF(VALUES(status) = 'finalized', VALUES(`" + c + '`), `' + c + '`)');
            sets.push("status = IF(VALUES(status) = 'finalized', 'finalized', status)");
            if (fence)
                sets.push('`push_generation` = GREATEST(COALESCE(`push_generation`, 0), COALESCE(VALUES(`push_generation`), 0))');
            let query = 'INSERT INTO cross_chain_calls (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES (' + placeholders + ')'
                      + ' ON DUPLICATE KEY UPDATE ' + sets.join(', ');
            await this.hubDb.doQuery(query, args);
            return;
        }

        // oracle_prices needs the same in-place upgrade path, but keyed on its
        // push_generation rather than a status column (it has no skipped->finalized
        // lifecycle). It carries UNIQUE (source_chain, action_index). After a
        // source-chain reorg a PRICE is re-mined at a RECYCLED action_index
        // (getNextActionIndex assigns MAX+1 over survivors, not an immutable counter)
        // and re-published with a BUMPED push_generation. If the replica still holds
        // the stale lower-generation row at that key, a plain INSERT IGNORE no-ops and
        // leaves push_generation at the old value; the deferred generation-fenced
        // retraction (push_generation <= pre-bump) then deletes the freshly re-published
        // row, and the hub never re-sends the deduped row, so the oracle price is
        // permanently absent on this replica until a full bootstrap. Upgrade in place
        // when the incoming generation is >= the local one, lifting push_generation so
        // the fenced delete is a no-op against it (the same ordering-independent
        // convergence price_snapshots and cross_chain_calls get via their status upgrade).
        // >= (not >) keeps re-delivery of the same generation idempotent.
        if (table === 'oracle_prices' && cols.includes('push_generation')) {
            let updatable = cols.filter(c => c !== 'id' && c !== 'source_chain' && c !== 'action_index' && c !== 'push_generation');
            let sets = updatable.map(c => '`' + c + '` = IF(VALUES(`push_generation`) >= `push_generation`, VALUES(`' + c + '`), `' + c + '`)');
            // push_generation is BOTH the gate and an assignment target, and MariaDB reads the
            // already-updated value in a later ODKU assignment, so it must stay LAST: lifting
            // it earlier would make every following column compare the incoming generation
            // against itself (the cross_chain_matches ordering trap, #3211).
            sets.push('push_generation = IF(VALUES(`push_generation`) >= `push_generation`, VALUES(`push_generation`), `push_generation`)');
            let query = 'INSERT INTO oracle_prices (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES (' + placeholders + ')'
                      + ' ON DUPLICATE KEY UPDATE ' + sets.join(', ');
            await this.hubDb.doQuery(query, args);
            return;
        }

        // cross_chain_matches needs an in-place upgrade path, not plain INSERT IGNORE.
        // TWO distinct mutations reach a match after it was first mirrored:
        //
        //   1. anchor_txid is stamped LATER (StateAnchorPublisher._backfillBatch, first-
        //      stamp-wins COALESCE) when the ANCHOR v1 archive publishes, and the hub
        //      re-broadcasts the stamped row. A plain INSERT IGNORE would no-op against
        //      the already-mirrored row and leave anchor_txid NULL on streamed mirrors
        //      forever, while a fresh REST bootstrap serves the stamp (divergent mirrors).
        //
        //   2. RETRACT -> REVIVE. Match content is NOT immutable per match_id. A source-
        //      chain reorg retracts the crossing (the hub UPDATEs status='retracted' and
        //      broadcasts a deletion event this mirror applies as a DELETE); when the SAME
        //      crossing re-forms at the same BTC snapshot_block, _deriveMatchId yields the
        //      IDENTICAL match_id and CrossChainDexEngine._insertMatchRow revives the row
        //      with THIS round's effective_time / finalizing_view / validator_signatures,
        //      then re-broadcasts it. A mirror that missed either half - disconnected over
        // the deletion, or the receive-side guards legitimately refused
        //      an unfenced/unsigned retraction - kept the pre-reorg row, and an anchor_txid-
        //      only ODKU could NEVER converge it: neither the live re-broadcast nor the
        //      FULL_REPAGE bootstrap (which re-delivers the row through this same path)
        //      moved the stale effective_time, which GATES the settlement block
        //      (db.getEffectiveUnsettledMatches), or the stale signature set. That is a
        //      permanent money-bearing divergence from a mirror-fed peer, the same class
        //      the price_snapshots / cross_chain_calls / oracle_prices paths already close
        //      (#3211).
        //
        // Convergence is ORDERING-INDEPENDENT: each delivery is judged against the local
        // row's own version, so a late/duplicate/out-of-order event is a no-op rather than a
        // regression. The version order is the hub's own (effective_time, status-rank) with
        // rank finalized=0 < anything-else=1: a revive always carries a strictly greater
        // effective_time (the proposing leader stamps _nowSeconds(), and followers refuse a
        // value more than an hour off), while a retraction leaves effective_time untouched -
        // so at EQUAL effective_time the retracted version is the later one and wins,
        // converging a missed retraction to a status consensus reads skip. `>=` on the tie
        // keeps re-delivery of the identical row idempotent.
        //
        // This is transport convergence, not trust: the settlement pass re-verifies every
        // match's 2f+1 signatures against the local capability_snapshots before applying it,
        // and a hostile hub could already replace content with a delete+insert.
        if (table === 'cross_chain_matches' && cols.includes('anchor_txid')) {
            if (cols.includes('effective_time') && cols.includes('status')) {
                let wins = '(VALUES(`effective_time`) > `effective_time` OR (VALUES(`effective_time`) = `effective_time`'
                         + " AND IF(VALUES(`status`) = 'finalized', 0, 1) >= IF(`status` = 'finalized', 0, 1)))";
                // The per-leg reorg fences are monotonic, independent of which version wins:
                // LOWERING a_push_generation / b_push_generation would let a stale fenced
                // retraction (DELETE ... WHERE gen <= fence) match this row and blow a
                // permanent hole in the mirror, so they only ever move up.
                let fences    = ['a_push_generation', 'b_push_generation'].filter(c => cols.includes(c));
                let pinned    = new Set(['id', 'match_id', 'anchor_txid'].concat(fences));
                let updatable = cols.filter(c => !pinned.has(c));
                // ASSIGNMENT ORDER IS LOAD-BEARING. MariaDB evaluates ON DUPLICATE KEY UPDATE
                // assignments left to right and later expressions read the ALREADY-UPDATED
                // value, so the two columns the gate reads must be assigned LAST, `status`
                // then `effective_time`:
                //   - every other column then compares against the row's ORIGINAL version;
                //   - `status` likewise (effective_time is still original when it runs);
                //   - `effective_time` runs with status already settled, which re-evaluates
                //     the gate to the SAME verdict (if the incoming row won, status now
                //     equals VALUES(status), so the tie branch holds; if it lost, nothing
                //     moved), so it lands consistently with the rest of the row.
                // Assigned in the naive column order instead, a strictly-newer REVIVE lifted
                // effective_time first and every later column then saw a tie against itself,
                // leaving status stuck at 'retracted' with the new content: a half-applied
                // row. Verified against MariaDB on the regtest stack, not just by reading.
                let gated = updatable.filter(c => c !== 'status' && c !== 'effective_time');
                let sets  = gated.map(c => '`' + c + '` = IF(' + wins + ', VALUES(`' + c + '`), `' + c + '`)');
                for (let c of ['status', 'effective_time'])
                    sets.push('`' + c + '` = IF(' + wins + ', VALUES(`' + c + '`), `' + c + '`)');
                for (let f of fences)
                    sets.push('`' + f + '` = GREATEST(COALESCE(`' + f + '`, 0), COALESCE(VALUES(`' + f + '`), 0))');
                sets.push('anchor_txid = COALESCE(anchor_txid, VALUES(anchor_txid))');
                let query = 'INSERT INTO cross_chain_matches (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES (' + placeholders + ')'
                          + ' ON DUPLICATE KEY UPDATE ' + sets.join(', ');
                await this.hubDb.doQuery(query, args);
                return;
            }
            // Older hub (or a mirror whose local table lacks effective_time/status): no
            // version to compare, so keep the narrow anchor-stamp upgrade and never guess.
            let query = 'INSERT INTO cross_chain_matches (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES (' + placeholders + ')'
                      + ' ON DUPLICATE KEY UPDATE anchor_txid = COALESCE(anchor_txid, VALUES(anchor_txid))';
            await this.hubDb.doQuery(query, args);
            return;
        }

        // attestation_responses is insert-only in every column the responsible set signed,
        // and upsertable in exactly ONE that it did not: batch_action_index, the link to the
        // ATTEST v5/v6 batch that carries this response's body on chain. That batch lands on
        // DOGE long after the row was mirrored, so the hub stamps the column and re-broadcasts
        // the row; a plain INSERT IGNORE would drop the stamp and leave the link NULL on every
        // streamed mirror forever while a fresh bootstrap served it, the divergent-mirror shape
        // the cross_chain_matches anchor_txid path above closes.
        //
        // COALESCE, so the FIRST stamp wins and no other column is assignable at all. Row
        // identity here is the natural key, not the payload, so an assignable signed column
        // would let a re-delivery of one hub's copy silently replace a body this node already
        // verified and applied. The link is safe to move because nothing consensus reads it:
        // no state-hash preimage carries it and the applier never reads it.
        if (table === 'attestation_responses' && cols.includes('batch_action_index')) {
            let query = 'INSERT INTO attestation_responses (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES (' + placeholders + ')'
                      + ' ON DUPLICATE KEY UPDATE batch_action_index = COALESCE(batch_action_index, VALUES(batch_action_index))';
            await this.hubDb.doQuery(query, args);
            if (row.batch_action_index != null) await this._linkAppliedResponseToBatch(row);
            return;
        }

        let query = 'INSERT IGNORE INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + placeholders + ')';
        await this.hubDb.doQuery(query, args);
    }

    // Carry a stamped batch link onto the local ATTEST v1 row the applier minted for this
    // response. Keyed on the request id, which is the only identifier the two sides share:
    // the batch is parsed on the DOGE indexer and names its responses by request_id, while
    // the v1 row was minted locally on BTC at whatever block the mirror row bound at.
    //
    // The value written is the one now STORED in the mirror rather than the one that just
    // arrived, so the first-stamp-wins rule above decides both copies at once and a second
    // batch claiming the same response cannot move them apart.
    //
    // Best effort by design. Both columns are display links, never consensus inputs, so a
    // failure here must not fail the drain (which would defer blocks); and a response whose
    // v1 has not been applied yet matches no row, which is the case the applier closes by
    // copying the link off the mirror row when it mints the v1.
    //
    // The local indexer connection is reached through the Database back-reference rather than
    // a constructor option, so this file stays the canonical copy other services vendor: the
    // explorer runs this same client against a pool that has no indexer and no attests table,
    // and simply skips the link.
    async _linkAppliedResponseToBatch(row) {
        let db = this.hubDb && this.hubDb.indexer && this.hubDb.indexer.indexerDb;
        if (!db || typeof db.setAttestationResponseBatchIndex !== 'function') return;
        try {
            let stored = await this.hubDb.doQuery(
                'SELECT batch_action_index FROM attestation_responses WHERE network = ? AND request_id = ? LIMIT 1',
                [String(row.network == null ? '' : row.network), String(row.request_id == null ? '' : row.request_id)]);
            let linked = (stored && stored[0]) ? stored[0].batch_action_index : null;
            if (linked == null) return;
            await db.setAttestationResponseBatchIndex(row.request_id, linked);
        } catch (e) {
            console.warn('HubDbSync: could not link attestation response ' +
                String(row.request_id) + ' to its on-chain batch:', e);
        }
    }

    // Local mirror table columns, cached per table with a short TTL. Table names
    // come only from the fixed internal mirror lists (the price_snapshots/
    // oracle_prices pair, CROSS_CHAIN_TABLES, HUB_STATE_TABLES), never from hub
    // input. The TTL (vs the former process-lifetime cache) bounds how long a
    // hub-side column rename/addition can keep silently NULLing the mirror: a
    // lifetime cache never re-learned the new column, so a row carrying it was
    // dropped by the _applyRow filter until a manual restart. After the TTL the
    // next apply re-reads SHOW COLUMNS and self-heals. A SHOW COLUMNS every few
    // minutes per table is negligible. We do NOT invalidate eagerly on a dropped
    // column because the hub legitimately serves columns the mirror omits by
    // design (see _applyRow), which would otherwise trigger a re-fetch storm.
    async _localColumns(table) {
        if (!this._localColumnCache) this._localColumnCache = {};
        let entry = this._localColumnCache[table];
        if (!entry || (Date.now() - entry.fetchedAt) > LOCAL_COLUMN_CACHE_TTL_MS) {
            let rows = await this.hubDb.doQuery('SHOW COLUMNS FROM ' + table);
            // doQuery swallows a missing-table error (1146) for non-transactional
            // reads and returns [] instead of throwing. Caching an empty set here
            // would poison the mirror: every _applyRow would filter to zero columns
            // and silently no-op, so a table that is merely not-created-yet (startup
            // race with the indexer's verifyTables() on a fresh reset) would never
            // mirror a row until a restart (prod rollout attempt 2026-06-17). A real
            // mirror table always has columns, so an empty result means "not ready":
            // do NOT cache it, and throw so the caller treats this bootstrap as
            // not-drained and retries.
            if (!rows || rows.length === 0)
                throw new Error('local mirror table ' + table + ' not available yet (no columns)');
            // `types` rides along on the SAME SHOW COLUMNS result the column
            // filter is built from, so type-aware value coercion costs no extra
            // query. The return value stays entry.cols: both callers and every
            // test stub of this method treat it as a plain Set of field names.
            entry = this._localColumnCache[table] = {
                cols:      new Set(rows.map(r => r.Field)),
                types:     new Map(rows.map(r => [r.Field, String(r.Type == null ? '' : r.Type).toLowerCase()])),
                fetchedAt: Date.now()
            };
        }
        return entry.cols;
    }

    // Local column TYPE for a table already primed in the column cache. It keys
    // mirror value coercion on the schema instead of on the value's shape.
    // Returns '' (read as "unknown") when the table or column is absent from the
    // cache or the driver served no Type, which keeps the coercion's legacy
    // shape-based fallback in play. Never issues a query: _applyRow awaits
    // _localColumns for the same table first, so the entry is primed by then,
    // and a test that stubs _localColumns simply lands on the fallback.
    _cachedColumnType(table, col) {
        let entry = this._localColumnCache && this._localColumnCache[table];
        if (!entry || !entry.types) return '';
        return entry.types.get(col) || '';
    }

    // Apply a reorg retraction to the local hub DB copy. The hub deletes price
    // rows seeded from rolled-back PRICE actions; we mirror that delete so this
    // indexer stops reading prices that were never finalized on-chain.
    // event: { table, source_chain, from_action_index, to_action_index?, retraction_generation? }
    // When the broadcaster supplies to_action_index the hub applied a CLOSED-range delete
    // (a deferred retraction, item 5296); we MUST mirror the same bound or the replica diverges
    // from the hub by deleting re-published rows the hub kept. Absent (live retraction) =>
    // open-ended `>= from`, exactly as before.
    // retraction_generation (item 5308): when present, the hub fenced its delete to rows with
    // push_generation <= it; we mirror the SAME fence so a row re-published at a recycled
    // action_index (higher generation) survives on the replica too (ordering-independent
    // convergence: a late delete is a no-op against the higher-generation re-published row).
    // Absent (older hub) => no fence, prior behavior. For cross_chain_matches the fence is
    // per-leg (a_push_generation / b_push_generation), matching the hub's per-leg retraction.
    async _applyRetraction(event) {
        let from = Number(event.from_action_index);
        if (!Number.isFinite(from)) return;                    // malformed, skip
        let to = (event.to_action_index !== undefined && event.to_action_index !== null)
                 ? Number(event.to_action_index) : null;
        let bounded = (to !== null && Number.isFinite(to));
        let gen = (event.retraction_generation !== undefined && event.retraction_generation !== null)
                  ? Number(event.retraction_generation) : null;
        let fenced = (gen !== null && Number.isFinite(gen) && gen >= 0);
        // Receive-side guards (XCALL-RETRACT-1,; see the constructor note).
        // 1. Quorum-class tables (their insertions carry 2f+1 proof) never accept an
        //    unfenced open delete: every current source stamps the item-5308 fence, so
        //    an unfenced event is either a pre-5308 relic or a fabricated wipe. The
        //    same applies to ANY table's retraction claiming a reorg of OUR OWN chain
        //    when we can check (our own retractions are always fenced).
        let quorumClass = (event.table === 'cross_chain_calls' || event.table === 'cross_chain_matches');
        let ownChain = !!(this.coin && event.source_chain === this.coin && this.getOwnRollbackGeneration);
        if ((quorumClass || ownChain) && !fenced) {
            console.error('HubDbSync: refusing UNFENCED retraction of ' + event.table +
                ' (source_chain ' + event.source_chain + ', from ' + from +
                '): quorum-class deletions require a retraction_generation fence');
            return;
        }
        if (fenced) {
            // 2. Our own chain: only a rollback WE performed can legitimately retract
            //    rows sourced from this chain, and it always carries a pre-bump
            //    generation. Refuse anything at/above our current generation. Fail
            //    closed on a read error: for our own chain this delete is only the
            //    idempotent backstop behind rollback.js's local pre-delete.
            if (ownChain) {
                let own = null;
                try { own = Number(await this.getOwnRollbackGeneration()); } catch (e) { own = null; }
                if (own === null || !Number.isFinite(own) || gen >= own) {
                    console.error('HubDbSync: refusing retraction of ' + event.table + ' for OWN chain ' +
                        this.coin + ' at generation ' + gen + ' (own rollback generation ' + own +
                        '): no local rollback produced this fence');
                    return;
                }
            }
            // 3. Monotonicity: a fence below the last one observed for this
            //    (table, source_chain) is a stale replay; skip it. Equal = redelivery,
            //    idempotent under the fence, still applied.
            let trackKey = event.table + '|' + event.source_chain;
            let tracked = this.trackedRollbackGeneration[trackKey];
            if (tracked !== undefined && gen < tracked) {
                console.warn('HubDbSync: skipping stale retraction of ' + event.table +
                    ' (source_chain ' + event.source_chain + ') at generation ' + gen +
                    ' < last-observed rollback generation ' + tracked);
                return;
            }
            this.trackedRollbackGeneration[trackKey] = gen;
        }
        // 4. Signed retractions (full fix): once this mirror's own
        //    capability_snapshots high-water mark has crossed the
        //    RETRACTION_SIGNING flag-day era, a quorum-class deletion must carry
        //    a 2f+1 `cross_chain` co-signature set over the XRETRACTV1 canonical,
        //    verified against the mirrored snapshot at the event's snapshot_block
        //    (streamed ahead of the deletion on the same ordered socket). The gate
        //    is judged from LOCAL state so an attacker cannot slip below it by
        //    omitting or understating wire fields. Pre-bootstrap (no snapshot rows
        //    at all) or with no network wired there is no signer set to verify
        //    against and the fences above stand alone (legacy tier).
        if (quorumClass && this.network) {
            let gateBlock = null;
            try {
                let rows = await this.hubDb.doQuery(
                    "SELECT MAX(snapshot_block) AS sb FROM capability_snapshots WHERE capability = 'cross_chain'");
                if (rows.length > 0 && rows[0].sb !== null) gateBlock = Number(rows[0].sb);
            } catch (e) { gateBlock = null; }                  // mirror table not ready yet
            if (gateBlock !== null && isRetractionSigningActive(gateBlock, this.network)) {
                let ok = await this._verifyRetractionSignatures(event);
                if (!ok) {
                    console.error('HubDbSync: refusing UNVERIFIED retraction of ' + event.table +
                        ' (source_chain ' + event.source_chain + ', from ' + from +
                        '): quorum-class deletions require a valid 2f+1 co-signature set');
                    return;
                }
            }
        }
        // cross_chain_matches is two-sided: a match is retracted when EITHER order leg on
        // the reorged chain was rolled back. The settlement pass then rolls back any leg it
        // already applied for that match (its cross_chain_settlements row drops with the block).
        if (event.table === 'cross_chain_matches') {
            let leg = (col, gcol) => '(' + col + '_chain = ? AND ' + col + '_action_index >= ?' +
                (bounded ? ' AND ' + col + '_action_index <= ?' : '') +
                (fenced ? ' AND ' + gcol + ' <= ?' : '') + ')';
            let legArgs = () => {
                let p = [event.source_chain, from];
                if (bounded) p.push(to);
                if (fenced) p.push(gen);
                return p;
            };
            await this.hubDb.doQuery(
                'DELETE FROM cross_chain_matches WHERE ' + leg('a', 'a_push_generation') + ' OR ' + leg('b', 'b_push_generation'),
                legArgs().concat(legArgs()));
            await this._refreshMatchSyncTimestamp();
            return;
        }
        // cross_chain_calls retracts on its source-chain request (the XCALL v0 row
        // that was reorged away). Both phases drop: a dispatch whose request
        // vanished must never produce an execution or a callback here.
        if (event.table === 'cross_chain_calls') {
            let tail = 'source_chain = ? AND source_action_index >= ?' +
                (bounded ? ' AND source_action_index <= ?' : '') +
                (fenced ? ' AND push_generation <= ?' : '');
            let args = [event.source_chain, from];
            if (bounded) args.push(to);
            if (fenced) args.push(gen);
            await this.hubDb.doQuery('DELETE FROM cross_chain_calls WHERE ' + tail, args);
            await this._refreshCallSyncTimestamp();
            return;
        }
        let column = RETRACTION_COLUMNS[event.table];
        if (!column) return;                                   // unknown table, skip
        let query = 'DELETE FROM ' + event.table + ' WHERE source_chain = ? AND ' + column + ' >= ?' +
            (bounded ? ' AND ' + column + ' <= ?' : '') +
            (fenced ? ' AND push_generation <= ?' : '');
        let args = [event.source_chain, from];
        if (bounded) args.push(to);
        if (fenced) args.push(gen);
        await this.hubDb.doQuery(query, args);
    }

    // Verify a quorum-class retraction's co-signature set. The event
    // must carry snapshot_block (itself at/after the flag-day era, so a signed
    // set can never be minted below the gate) plus retraction_signatures; each
    // signature is checked over the rebuilt XRETRACTV1 canonical against the
    // mirrored `cross_chain` capability snapshot at that block, with the same
    // quorum predicate the settlement pass applies to match insertions
    // (stake-weighted at/above SWQ activation, else count 2f+1/majority).
    async _verifyRetractionSignatures(event) {
        let sb = Number(event.snapshot_block);
        if (!Number.isFinite(sb) || sb < 0) return false;
        if (!isRetractionSigningActive(sb, this.network)) return false;
        let sigs = event.retraction_signatures;
        if (!Array.isArray(sigs) || sigs.length === 0) return false;

        let rows;
        try {
            rows = await this.hubDb.doQuery(
                "SELECT signing_pubkey, amount, source FROM capability_snapshots WHERE capability = 'cross_chain' AND snapshot_block = ?", [sb]);
        } catch (e) { return false; }
        if (!rows || rows.length === 0) return false;          // no snapshot at that block -> nothing to verify against

        let validators = rows.map(r => ({
            pubkey: String(r.signing_pubkey).toLowerCase(),
            source: String(r.source != null ? r.source : ''),
            weight: String(r.amount != null ? r.amount : '0')
        }));
        let snapPubkeys = new Set(validators.map(v => v.pubkey));

        let canonical = canonicalRetraction(event);
        let validSigners = [], seen = new Set();
        for (let s of sigs) {
            let pk  = String(s && s.pubkey || '').toLowerCase();
            let sig = String(s && s.sig || '').toLowerCase();
            if (!pk || seen.has(pk)) continue;
            if (!snapPubkeys.has(pk)) continue;
            if (!verifyEd25519(canonical, sig, pk)) continue;
            // Mark seen only AFTER the signature verifies (Pkg 13 /), matching
            // the hub producer twin (RetractionConsensus._handleFinalized) and the
            // sibling tallies in anchor.js / recovery.js / StateAnchorPublisher. Marking
            // on first encounter lets a garbage-then-valid pair for one snapshot member
            // consume the dedupe slot and suppress the real signature, under-counting the
            // quorum and refusing a retraction the hub itself finalized.
            seen.add(pk);
            validSigners.push(pk);
        }
        let weighted = swq.isStakeWeightedQuorumActive(sb, this.network);
        let n = validators.length;
        return weighted
            ? swq.meetsStakeThreshold(validators, validSigners)
            : (validSigners.length >= ((n <= 1) ? 1 : Math.max(2 * Math.floor((n - 1) / 3) + 1, Math.ceil((n + 1) / 2))));
    }

    // ── Cross-chain match sync barrier (mirrors the oracle_prices barrier) ──────

    // Recompute the highest effective_time present in the local cross_chain_matches copy
    // (finalized only) and release satisfied waiters. A NULL max (empty mirror) is valid.
    async _refreshMatchSyncTimestamp(armBootstrap = this._bootstrapDrained) {
        let ts = null;
        try {
            // Scope the watermark to matches that touch THIS coin (either leg), matching
            // the settlement query (db.js: WHERE ... AND (a_chain = ? OR b_chain = ?)) and
            // the snapshot-presence barrier. A global MAX(effective_time) could be bumped
            // past this block's time by an unrelated other-chain match (both legs on other
            // chains, still mirrored here because the hub broadcasts every match), letting
            // waitForMatchSync pass before every match effective for this coin is mirrored
            // locally, so two indexers settling the same chain could settle the same match at
            // divergent blocks and fork. Symmetric to the cross_chain_calls fix (item 4573).
            let where = "WHERE status = 'finalized'";
            let args  = [];
            if (this.coin) { where += " AND (a_chain = ? OR b_chain = ?)"; args = [this.coin, this.coin]; }
            let rows = await this.hubDb.doQuery(
                "SELECT MAX(effective_time) AS ts FROM cross_chain_matches " + where, args);
            if (rows.length > 0 && rows[0].ts !== null) ts = Number(rows[0].ts);
        } catch (e) {
            return;                                             // table not ready yet
        }
        this.matchSyncTimestamp = ts;
        // Arm only under a full bootstrap drain; reconnect / live-row refreshes
        // default armBootstrap to _bootstrapDrained so they cannot arm the NULL
        // fast path from a holed mirror and fork (#1788).
        if (armBootstrap) this.matchBootstrapped = true;
        this._releaseMatchWaiters();
    }

    _matchSyncSatisfied(blockTime) {
        if (this.matchBootstrapped && this.matchSyncTimestamp === null) return true;
        if (this.matchSyncTimestamp !== null && this.matchSyncTimestamp >= blockTime) return true;
        // Stream watermark: matches are stamped with the hub's wall clock at
        // finalization and broadcast immediately, so a watermark past this
        // block's time (plus clock-skew grace) means every match effective at
        // or before it is already local. Without this, the FIRST finalized
        // cross-chain match anywhere froze every distributed replica on every
        // chain until the next match arrived (#1984, live-repro'd: an LTC⇄DOGE
        // match stalled the BTC replica for 6+ cycles).
        if (this.matchBootstrapped && this.streamWatermark >= blockTime + this.matchWatermarkGraceS) return true;
        return false;
    }

    _releaseMatchWaiters() {
        if (this._matchWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._matchWaiters) {
            if (this._matchSyncSatisfied(w.ts)) {
                clearTimeout(w.timer);
                w.resolve(this.matchSyncTimestamp);
            } else {
                stillWaiting.push(w);
            }
        }
        this._matchWaiters = stillWaiting;
    }

    // Block-processing barrier for the cross-chain settlement pass. Resolves once the local
    // cross_chain_matches copy holds every match effective at or before this block's time, so
    // every operator of this chain settles the same matches at the same block. Rejects after
    // timeoutMs so the caller can DEFER the block and retry; never settle against a stale
    // match mirror. Resolves immediately when sync is disabled or the mirror holds no matches.
    waitForMatchSync(blockTime, timeoutMs) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.matchSyncTimestamp);
        if (this._matchSyncSatisfied(blockTime))           return Promise.resolve(this.matchSyncTimestamp);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                // Self-heal before giving up, same as waitForPriceSyncHeight: a missed
                // refresh on a stream/reconnect edge can leave matchSyncTimestamp stale
                // behind a local mirror that is actually current. Re-read the DB here;
                // _refreshMatchSyncTimestamp resolves+clears this waiter via
                // _releaseMatchWaiters if the mirror has since caught up.
                try { await this._refreshMatchSyncTimestamp(); } catch (e) { /* fall through to reject */ }
                if (this._matchSyncSatisfied(blockTime)) return;   // already resolved by the refresh
                this._matchWaiters = this._matchWaiters.filter(w => w !== waiter);
                reject(new Error('match sync barrier timed out after ' + ms + 'ms waiting for block_time ' +
                                 blockTime + ' (match mirror at ' + this.matchSyncTimestamp + ')'));
            }, ms);
            this._matchWaiters.push(waiter);
        });
    }

    // ── Cross-chain call sync barrier (mirrors the match barrier exactly) ──────

    async _refreshCallSyncTimestamp(armBootstrap = this._bootstrapDrained) {
        let ts = null;
        try {
            // Scope the watermark to calls that touch THIS coin (target or source),
            // matching the snapshot-presence barrier below. A global MAX(effective_time)
            // could be bumped past this block's time by an unrelated other-chain call,
            // letting the barrier pass before every call effective for this coin is
            // mirrored locally, so two indexers settling the same chain could inject the
            // same XEXEC at divergent positions and fork (item 4573).
            let where = "WHERE status = 'finalized'";
            let args  = [];
            if (this.coin) { where += " AND (target_chain = ? OR source_chain = ?)"; args = [this.coin, this.coin]; }
            let rows = await this.hubDb.doQuery(
                "SELECT MAX(effective_time) AS ts FROM cross_chain_calls " + where, args);
            if (rows.length > 0 && rows[0].ts !== null) ts = Number(rows[0].ts);
        } catch (e) {
            return;                                             // table not ready yet
        }
        this.callSyncTimestamp = ts;
        // Arm only under a full bootstrap drain; reconnect / live-row refreshes
        // default armBootstrap to _bootstrapDrained so they cannot arm the NULL
        // fast path from a holed mirror and fork (#1788).
        if (armBootstrap) this.callBootstrapped = true;
        this._releaseCallWaiters();
    }

    _callSyncSatisfied(blockTime) {
        if (this.callBootstrapped && this.callSyncTimestamp === null) return true;
        if (this.callSyncTimestamp !== null && this.callSyncTimestamp >= blockTime) return true;
        // Stream watermark escape: a relay row is broadcast the moment the hub
        // finalizes it, so a watermark past this block's time plus the grace means
        // every relay row effective at/before it is already local. Without this
        // the FIRST cross-chain call anywhere would freeze every replica until
        // the next one arrived (the #1984 bug class).
        //
        // Uses callWatermarkGraceS, NOT the match grace it used to borrow: the two
        // producers stamp effective_time differently (CrossChainCallEngine stamps
        // now + a forward relay margin, so a call row lands ahead of the time it
        // applies at; CrossChainDexEngine stamps the finalization instant), so the
        // two barriers must be tunable apart even while the values are equal.
        if (this.callBootstrapped && this.streamWatermark >= blockTime + this.callWatermarkGraceS) return true;
        return false;
    }

    _releaseCallWaiters() {
        if (this._callWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._callWaiters) {
            if (this._callSyncSatisfied(w.ts)) {
                clearTimeout(w.timer);
                w.resolve(this.callSyncTimestamp);
            } else {
                stillWaiting.push(w);
            }
        }
        this._callWaiters = stillWaiting;
    }

    // Block-processing barrier for the cross-chain call passes. Resolves once the local
    // cross_chain_calls copy holds every relay row effective at or before this block's
    // time, so every operator injects/delivers the same calls at the same block. Rejects
    // after timeoutMs so the caller can DEFER the block and retry.
    waitForCallSync(blockTime, timeoutMs) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.callSyncTimestamp);
        if (this._callSyncSatisfied(blockTime))            return Promise.resolve(this.callSyncTimestamp);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                // Self-heal before giving up, same as waitForPriceSyncHeight: a missed
                // refresh on a stream/reconnect edge can leave callSyncTimestamp stale
                // behind a local mirror that is actually current. Re-read the DB here;
                // _refreshCallSyncTimestamp resolves+clears this waiter via
                // _releaseCallWaiters if the mirror has since caught up.
                try { await this._refreshCallSyncTimestamp(); } catch (e) { /* fall through to reject */ }
                if (this._callSyncSatisfied(blockTime)) return;   // already resolved by the refresh
                this._callWaiters = this._callWaiters.filter(w => w !== waiter);
                reject(new Error('call sync barrier timed out after ' + ms + 'ms waiting for block_time ' +
                                 blockTime + ' (call mirror at ' + this.callSyncTimestamp + ')'));
            }, ms);
            this._callWaiters.push(waiter);
        });
    }

    // ── Anchor-reward attestation mirror-completeness barrier ──────────────────
    //
    // The BTC indexer mints a COLLECT-spendable reward from mirrored
    // anchor_reward_attestations rows, and the block a given reward materializes at is
    // fixed fleet-wide (snapshot_block + ANCHOR_REWARD_MIRROR_MATURITY). That fixed height
    // is only safe if a node which has NOT received the row by then declines to advance
    // rather than deriving a smaller set: otherwise the lagging node commits a block whose
    // ledger hash differs from its peers' for the same BTC block, which is exactly the
    // divergence the maturity re-keying exists to remove.
    //
    // No row-content watermark is possible here. These rows carry no effective_time, and
    // their arrival is governed by DOGE confirmation depth and hub failover, neither of
    // which is comparable to a BTC block height or time. So the barrier gates on the STREAM
    // watermark alone: "the hub has told me I hold everything it produced up to this
    // block's time." That is a strictly stronger claim than the maturity window needs (the
    // rows in question were written roughly a day earlier), which is the point.
    //
    // Disabled sync is satisfied by definition: with no mirror the indexer reads the hub's
    // MariaDB directly, so there is no delivery lag to wait out. Poll mode is NOT satisfied
    // and never will be, because the stream watermark deliberately freezes there (a REST
    // poll cannot observe an in-place upsert), and the barrier's timeout then defers the
    // block, which is the correct fail-closed outcome for a node that cannot certify
    // completeness at all.
    _anchorAttestSyncSatisfied(blockTime) {
        if (!this.enabled) return true;
        blockTime = Number(blockTime);
        if (!Number.isFinite(blockTime)) return true;
        return this.streamWatermark >= blockTime + this.anchorAttestWatermarkGraceS;
    }

    _releaseAnchorAttestWaiters() {
        if (!this._anchorAttestWaiters || this._anchorAttestWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._anchorAttestWaiters) {
            if (this._anchorAttestSyncSatisfied(w.ts)) {
                clearTimeout(w.timer);
                w.resolve(this.streamWatermark);
            } else {
                stillWaiting.push(w);
            }
        }
        this._anchorAttestWaiters = stillWaiting;
    }

    // Block-processing barrier for the anchor-reward derive pass. Resolves once this
    // mirror is certified caught up through blockTime; rejects after timeoutMs so the
    // caller DEFERS the block and retries it (never advancing past a maturity boundary it
    // cannot prove it holds the rows for).
    waitForAnchorAttestationSync(blockTime, timeoutMs) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.streamWatermark);
        if (this._anchorAttestSyncSatisfied(blockTime))    return Promise.resolve(this.streamWatermark);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(() => {
                this._anchorAttestWaiters = this._anchorAttestWaiters.filter(w => w !== waiter);
                reject(new Error('anchor-reward attestation mirror barrier timed out after ' + ms +
                                 'ms waiting for block_time ' + blockTime +
                                 ' (stream watermark at ' + this.streamWatermark + ')'));
            }, ms);
            this._anchorAttestWaiters.push(waiter);
        });
    }

    // ── Finalized ATTEST response mirror-completeness barrier ──────────────────
    //
    // Distinct from the anchor-reward barrier directly above, which covers
    // anchor_reward_attestations. This one covers attestation_responses: the finalized
    // ATTEST results that replaced the validator-paid on-chain response transaction.
    //
    // A mirror row binds at the first BTC block whose protocol time reaches the row's
    // signed effective_time, and that block fires the contract callback, mints the
    // synthetic v1 action and moves the reward split. A node that has not received the row
    // by then does not merely lag: it settles that block with the callback un-fired and
    // every downstream ledger hash different from its peers', permanently. So a node that
    // cannot certify it holds everything the hub produced up to this block's time DEFERS.
    //
    // There is deliberately NO escape hatch on this barrier: no content watermark, no
    // empty-mirror short circuit, no bootstrapped-flag fast path. An empty mirror is
    // indistinguishable from a mirror that has not been told about the row that binds at
    // this very block, and the price barrier's chain-only escape has no analogue here
    // because the equivalent completeness proof is batch coverage (§6.3), not a clock.
    // Poll mode is never satisfied either, because the stream watermark freezes there by
    // design, and the resulting timeout defers the block, which is the correct fail-closed
    // outcome for precisely the node whose mirror may be stale.
    //
    // Disabled sync is satisfied by definition: with no mirror the indexer reads the hub's
    // MariaDB directly, so there is no delivery lag to wait out.
    _attestResponseSyncSatisfied(blockTime) {
        if (!this.enabled) return true;
        blockTime = Number(blockTime);
        if (!Number.isFinite(blockTime)) return true;
        return this.streamWatermark >= blockTime + this.attestResponseWatermarkGraceS;
    }

    _releaseAttestResponseWaiters() {
        if (!this._attestResponseWaiters || this._attestResponseWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._attestResponseWaiters) {
            if (this._attestResponseSyncSatisfied(w.ts)) {
                clearTimeout(w.timer);
                w.resolve(this.streamWatermark);
            } else {
                stillWaiting.push(w);
            }
        }
        this._attestResponseWaiters = stillWaiting;
    }

    // Block-processing barrier for the ATTEST response applier. Resolves once this mirror
    // is certified caught up through blockTime; rejects after timeoutMs so the caller
    // DEFERS the block and retries it, never binding a response set it cannot prove is
    // complete.
    waitForAttestationResponseSync(blockTime, timeoutMs) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.streamWatermark);
        if (this._attestResponseSyncSatisfied(blockTime))  return Promise.resolve(this.streamWatermark);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(() => {
                this._attestResponseWaiters = this._attestResponseWaiters.filter(w => w !== waiter);
                reject(new Error('attestation response mirror barrier timed out after ' + ms +
                                 'ms waiting for block_time ' + blockTime +
                                 ' (stream watermark at ' + this.streamWatermark + ')'));
            }, ms);
            this._attestResponseWaiters.push(waiter);
        });
    }

    // ── Cross-chain capability-snapshot presence barrier ───────────────────────
    // Companion to the match barrier. A match is only settleable once the cross_chain
    // capability snapshot at its snapshot_block has mirrored in (cross_settle verifies
    // the match's signatures against that snapshot. If it is absent, cross_settle would
    // skip the match while the block advances, so the match settles at whatever later
    // block the snapshot first appears locally, a per-operator-variable height that
    // diverges the ledger. This barrier defers the block (never advancing) until every
    // cross-chain match effective at/before this block's time, for this coin, has its
    // snapshot present), so all operators settle each match at the same height.
    //
    // Scope is PRESENCE only (≥1 snapshot row for the block). Deterministic quorum-N
    // under partial snapshot arrival is a separate, narrower concern sealed by the
    // multi-node design (see cross_settle's N-handling); in the happy path the hub
    // broadcasts the snapshot rows before the match row, so presence implies the set.

    // True when sync is disabled, or when every finalized match effective at/before
    // blockTime for this coin has its cross_chain snapshot mirrored locally. A query
    // error (table not ready) reads as NOT satisfied so the barrier waits rather than
    // letting a block settle against a missing snapshot.
    async _snapshotSyncSatisfied(blockTime) {
        if (!this.enabled) return true;
        blockTime = Number(blockTime);
        if (!Number.isFinite(blockTime)) return true;
        try {
            // Any finalized, effective match (for this coin) whose snapshot_block has no
            // mirrored cross_chain capability_snapshots row → not yet satisfied. coin is
            // optional: without it, fall back to a (safe) superset over all chains.
            let coinClause = this.coin ? 'AND (m.a_chain = ? OR m.b_chain = ?)' : '';
            let args = this.coin ? [blockTime, this.coin, this.coin] : [blockTime];
            let missing = await this.hubDb.doQuery(
                "SELECT 1 FROM cross_chain_matches m " +
                "WHERE m.status = 'finalized' AND m.effective_time <= ? " + coinClause + " " +
                "AND NOT EXISTS (SELECT 1 FROM capability_snapshots s " +
                "                WHERE s.snapshot_block = m.snapshot_block AND s.capability = 'cross_chain') " +
                "LIMIT 1", args);
            if (missing.length > 0) return false;
            // Same presence rule for XCALL relay rows this chain will act on
            // (dispatches targeting it + results it originated); xexec.js /
            // xcall.processResult verify signatures against these snapshots.
            let callClause = this.coin ? 'AND (c.target_chain = ? OR c.source_chain = ?)' : '';
            let callArgs = this.coin ? [blockTime, this.coin, this.coin] : [blockTime];
            let missingCalls = await this.hubDb.doQuery(
                "SELECT 1 FROM cross_chain_calls c " +
                "WHERE c.status = 'finalized' AND c.effective_time <= ? " + callClause + " " +
                "AND NOT EXISTS (SELECT 1 FROM capability_snapshots s " +
                "                WHERE s.snapshot_block = c.snapshot_block AND s.capability = 'cross_chain') " +
                "LIMIT 1", callArgs);
            return missingCalls.length === 0;
        } catch (e) {
            return false;                                      // table not ready → wait, don't advance
        }
    }

    async _releaseSnapshotWaiters() {
        if (this._snapshotWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._snapshotWaiters) {
            if (await this._snapshotSyncSatisfied(w.ts)) {
                clearTimeout(w.timer);
                w.resolve(true);
            } else {
                stillWaiting.push(w);
            }
        }
        this._snapshotWaiters = stillWaiting;
    }

    // Block-processing barrier: resolves once every effective cross-chain match for this
    // coin has its capability snapshot mirrored. Rejects after timeoutMs so the caller
    // DEFERS the block (counter not advanced) and retries; never settling a match whose
    // snapshot is missing. Resolves immediately when sync is disabled or already satisfied.
    async waitForSnapshotSync(blockTime, timeoutMs) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return true;
        if (await this._snapshotSyncSatisfied(blockTime))     return true;

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                // Self-heal before giving up, same intent as the scalar barriers above.
                // Snapshot-presence is set-dependent (recomputed by a live query rather
                // than a cached scalar), but release is still event-driven: a snapshot
                // that mirrored in without firing a cross-chain event would leave this
                // waiter armed until the timeout. Re-evaluate against the mirror here;
                // _releaseSnapshotWaiters resolves+clears this waiter if satisfied now.
                try { await this._releaseSnapshotWaiters(); } catch (e) { /* fall through to reject */ }
                if (await this._snapshotSyncSatisfied(blockTime)) return;   // already resolved by the refresh
                this._snapshotWaiters = this._snapshotWaiters.filter(w => w !== waiter);
                reject(new Error('snapshot sync barrier timed out after ' + ms + 'ms waiting for block_time ' +
                                 blockTime + ' (a cross-chain match is missing its capability snapshot)'));
            }, ms);
            this._snapshotWaiters.push(waiter);
        });
    }

    // Route one live row event (row:inserted / row:deleted) from the
    // subscription stream. Split from the socket handler so the buffering
    // decision is unit-testable; always invoked through _msgChain, so calls
    // are serialized against each other and against the drain-time flush.
    // Order matters: the schema fail-closed check runs first (a mismatched
    // row must freeze the watermark gate even mid-bootstrap and must never be
    // buffered for a later replay), then price_snapshots events are BUFFERED
    // while this connection's price bootstrap has not drained (#2422; see the
    // constructor note: applying them early holes the mirror under the
    // still-draining REST pull and every MAX()-based refresh would open the
    // height barrier over the hole), and only then does the normal
    // apply-and-refresh path run.
    async _handleRowEvent(event) {
        if (event.schema_version != null && event.schema_version !== HUB_SCHEMA_VERSION) {
            // Schema-version mismatch: the hub is broadcasting a mirror row shape
            // this indexer was not built for, so applying it (or its retraction)
            // risks dropping a consensus-relevant column and forking the ledger.
            // Fail closed: do not apply, do not advance the watermark, so the
            // barrier stays shut and the block is deferred rather than settled
            // against mismatched mirror data. The != null guard keeps older hubs
            // that send no version working unchanged.
            console.error('HubDbSync: hub schema_version ' + event.schema_version +
                ' != local ' + HUB_SCHEMA_VERSION + ' for ' + event.table +
                '; refusing to apply row. Restart this indexer after upgrading the hub.');
            // Freeze the watermark gate until a clean re-bootstrap, so a
            // following heartbeat cannot certify the stream as caught-up
            // while we are dropping rows we cannot apply.
            this._schemaMismatchSeen = true;
            return;
        }
        if (event.table === 'price_snapshots' && !this._priceDrained) {
            this._bufferPriceEvent(event);
            return;
        }
        if (event.type === 'row:inserted' && event.table && event.row) {
            await this._applyRow(event.table, event.row);
            if (event.table === 'price_snapshots')     await this._refreshPriceSyncHeight();
            if (event.table === 'oracle_prices')       await this._refreshOracleSyncTimestamp();
            if (event.table === 'cross_chain_matches') await this._refreshMatchSyncTimestamp();
            if (event.table === 'cross_chain_calls')   await this._refreshCallSyncTimestamp();
            if (CROSS_CHAIN_TABLES.indexOf(event.table) !== -1) await this._releaseSnapshotWaiters();
        } else if (event.type === 'row:deleted' && event.table) {
            await this._applyRetraction(event);
            if (event.table === 'price_snapshots')     await this._refreshPriceSyncHeight();
            if (event.table === 'oracle_prices')       await this._refreshOracleSyncTimestamp();
            if (event.table === 'cross_chain_matches') await this._refreshMatchSyncTimestamp();
            if (event.table === 'cross_chain_calls')   await this._refreshCallSyncTimestamp();
            if (event.table === 'cross_chain_matches' || event.table === 'cross_chain_calls') await this._releaseSnapshotWaiters();
        }
    }

    // Queue a live price_snapshots event for replay after the price bootstrap
    // drains (#2422). Inserts AND deletions buffer: replaying a fenced
    // retraction before the insert it retracts would no-op the delete and then
    // re-insert the retracted row, so arrival order is consensus-relevant. On
    // overflow the buffer is abandoned and flagged: the flush then reports the
    // table not-drained so _bootstrapAll re-pages the dropped rows straight
    // from the hub (they are in its DB) instead of opening the gate over the
    // loss; dropped deletions are redelivered by the hub's deferred-retraction
    // path (item 5296), same as deletions missed while disconnected.
    _bufferPriceEvent(event) {
        if (this._pendingPriceOverflow) return;
        if (this._pendingPriceEvents.length >= PENDING_PRICE_EVENT_CAP) {
            console.error('HubDbSync: pending price_snapshots event buffer overflow (' +
                PENDING_PRICE_EVENT_CAP + '); discarding and forcing a re-drain');
            this._pendingPriceOverflow = true;
            this._pendingPriceEvents = [];
            return;
        }
        this._pendingPriceEvents.push(event);
    }

    // Replay the live price_snapshots events buffered during the bootstrap
    // drain, in arrival order. Returns true when every buffered event applied
    // (re-receives of rows the final drain pages already fetched are harmless:
    // the price upsert is idempotent). On a failure it stops AT the failed
    // event, keeping it and the tail buffered, and returns false so the caller
    // reports the table not-drained: local MAX(id) stays at the contiguous
    // drain frontier, the retry re-fetches the failed row over REST, and a
    // persistently bad row wedges the barrier (defer) rather than silently
    // forking, the module's fail-closed contract (BOOTSTRAP-HOLE-1).
    async _flushPendingPriceEvents() {
        if (this._pendingPriceOverflow) {
            this._pendingPriceOverflow = false;
            this._pendingPriceEvents = [];
            return false;
        }
        while (this._pendingPriceEvents.length > 0) {
            let event = this._pendingPriceEvents[0];
            try {
                if (event.type === 'row:inserted' && event.row) {
                    await this._applyRow('price_snapshots', event.row);
                } else if (event.type === 'row:deleted') {
                    await this._applyRetraction(event);
                }
            } catch (err) {
                console.warn('HubDbSync: failed to replay buffered price_snapshots event:', err);
                return false;
            }
            this._pendingPriceEvents.shift();
        }
        return true;
    }

    // Open the WebSocket subscription for live row updates. Returns a Promise that
    // resolves once the hub sends a 'ready' acknowledgement confirming the subscription
    // is registered server-side. start() awaits this before running the REST bootstrap,
    // eliminating the race where rows inserted between the REST response and the upgrade
    // complete were silently dropped. After ready, the connection stays open and
    // processes live events. Rejects if the socket closes before ready is received.
    _connectWebSocket() {
        return new Promise((resolve, reject) => {
            if (!WebSocket || !this.running) {
                return reject(new Error('WebSocket unavailable or sync stopped'));
            }
            let parsed = url.parse(this.hubUrl);
            let wsScheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
            let wsUrl = wsScheme + '//' + parsed.host + '/hub-db/subscribe';

            let headers = {};
            if (this.apiKey) headers['Authorization'] = 'Bearer ' + this.apiKey;

            let ws;
            try {
                ws = new WebSocket(wsUrl, { headers: headers });
            } catch (e) {
                console.warn('HubDbSync: WebSocket connect failed:', e);
                this._scheduleReconnect();
                return reject(e);
            }
            this.ws = ws;

            // Resolved once either ready or an error fires; prevents double-settle
            let settled = false;
            const settle = (fn, val) => {
                if (settled) return;
                settled = true;
                fn(val);
            };

            ws.on('open', () => {
                console.log('HubDbSync: WebSocket connected to ' + wsUrl);
                this._startWatchdog(ws);
            });

            ws.on('message', (data) => {
                // Liveness stamp at frame ARRIVAL (#2477). The watchdog measures
                // TRANSPORT liveness, so stamp on ANY inbound frame here, BEFORE the
                // frame is enqueued to _msgChain. Stamping inside the chain instead (behind
                // awaited row applies) measured PROCESSING: a row-apply backlog longer than
                // watermarkTimeoutMs would terminate a healthy socket and force a
                // re-bootstrap, a self-reinforcing loop. The hub emits a watermark at least
                // every interval, so any frame arriving is sufficient proof of liveness;
                // watermark ADVANCEMENT stays serialized behind row applies in _msgChain.
                this._lastHeartbeatAt = Date.now();
                let event;
                try {
                    event = JSON.parse(data.toString());
                } catch (err) {
                    console.warn('HubDbSync: failed to parse WebSocket message:', err);
                    return;
                }

                // ready frames are synchronous (no DB I/O) and must resolve the
                // outer Promise immediately, so they bypass the serialization chain.
                if (event.type === 'ready') {
                    // Hub has registered our subscription. Capture hub-side max IDs
                    // (included by HubDbBroadcaster for gap detection after bootstrap).
                    if (event.max_ids && typeof event.max_ids === 'object') {
                        this._readyMaxIds = event.max_ids;
                    }
                    // Self-size the heartbeat watchdog from the hub's ACTUAL cadence when
                    // advertised (watermark_interval_ms), so the client timeout > hub
                    // interval invariant holds without a matching env knob on every
                    // consumer. Re-arm the watchdog (already started on 'open' with the
                    // env-seeded cadence) only when a valid new interval was adopted, so
                    // both the poll cadence and the timeout track the hub.
                    if (this._adoptHubWatermarkInterval(event.watermark_interval_ms))
                        this._startWatchdog(ws);
                    // NOTE: the ready watermark is NOT advanced here. At this point
                    // the REST bootstrap has not run, so rows the hub produced before
                    // this subscription may not be local yet. Bootstrap responses
                    // carry their own watermark (advanced only on a full drain).
                    if (event.watermark) this._readyWatermark = Number(event.watermark);
                    settle(resolve, event);
                    return;
                }

                // All other frames (watermark heartbeats and row events) are
                // serialized through _msgChain so a watermark frame can never
                // advance streamWatermark while a preceding row:inserted apply
                // is still awaiting its DB write.
                this._msgChain = this._msgChain.then(async () => {
                    try {
                        if (event.type === 'watermark') {
                            // Liveness is stamped at frame ARRIVAL in the raw ws.on('message')
                            // handler above (#2477), not here: stamping inside this serialized
                            // chain (behind awaited row applies) let a row-apply backlog
                            // terminate a healthy socket. Only stream-watermark ADVANCEMENT
                            // stays serialized here.
                            // Stream-position heartbeat: every row event produced up to ts has
                            // been delivered on this socket. Safe to advance only once the
                            // bootstrap has drained (rows from before the subscription).
                            // Do not advance while a live schema mismatch is outstanding:
                            // rows are being refused below, so certifying the stream as
                            // caught-up would settle blocks against data we did not apply.
                            if (this._bootstrapDrained && !this._schemaMismatchSeen) this._advanceWatermark(event.ts);
                        } else if (event.type === 'row:inserted' || event.type === 'row:deleted') {
                            // Schema fail-closed check, price-event buffering
                            // (#2422), and the apply-and-refresh path all live
                            // in _handleRowEvent (extracted for testability).
                            await this._handleRowEvent(event);
                        }
                    } catch (err) {
                        console.warn('HubDbSync: failed to handle WebSocket message:', err);
                    }
                });
            });

            ws.on('close', () => {
                console.log('HubDbSync: WebSocket disconnected, reconnecting in 5s');
                this._stopWatchdog();
                this.ws = null;
                // Rows produced while disconnected won't arrive on the socket;
                // close the heartbeat gate (and freeze the watermark) until the
                // reconnect re-bootstrap has drained the gap.
                this._bootstrapDrained = false;
                // Price events buffered for the drain die with the socket: their
                // inserts re-page via the re-bootstrap and their deletions are
                // redelivered by the hub's deferred-retraction path (item 5296).
                // Reset the per-connection price-drain state so live price rows
                // buffer again until the reconnect re-bootstrap drains (#2422),
                // and bump the epoch so a flush racing this close cannot
                // stale-arm _priceDrained for the next connection.
                this._priceDrained = false;
                this._pendingPriceEvents = [];
                this._pendingPriceOverflow = false;
                this._wsEpoch++;
                // Reset the serialization chain so the new connection starts clean
                // rather than waiting on in-flight work from the dead socket.
                this._msgChain = Promise.resolve();
                settle(reject, new Error('WebSocket closed before ready'));
                this._scheduleReconnect();
            });

            ws.on('error', (err) => {
                console.warn('HubDbSync: WebSocket error:', err.message);
                // close fires after error and will call _scheduleReconnect
                settle(reject, err);
            });
        });
    }

    // Force a fresh subscribe-then-bootstrap cycle on this mirror.
    //
    // Called by the block loop when one block has been held at a mirror-completeness
    // barrier for longer than the named hold ceiling. Every one of those barriers opens
    // on the stream watermark, the watermark only advances while _bootstrapDrained is
    // set, and nothing else in this module ever re-arms that flag once a drain has
    // stalled: the socket can stay open and heartbeating (so the watchdog is satisfied)
    // while the mirror certifies nothing, indefinitely. Tearing the socket down puts the
    // mirror back through the ONE path that does re-arm it, which the close handler
    // already implements and exercises on every ordinary disconnect
    // (_scheduleReconnect -> _connectWebSocket -> _refreshAllSyncHeights -> _bootstrapAll).
    //
    // This opens NO barrier and commits NO block: a mirror that is genuinely missing
    // rows keeps deferring after the resync, which is the fail-closed outcome. It only
    // ensures the wait is bounded by a re-drive rather than by nothing at all.
    //
    // Safe to fire while a re-bootstrap is already draining, which is the case it is most
    // likely to hit: _bootstrapTable pages from the LOCAL max id as since_id, so a restarted
    // drain resumes where the applied rows end rather than starting over. The cost of a
    // mistimed resync is one in-flight page refetched, and the throttle below caps that at
    // one per ceiling window.
    //
    // Rate-limited to one resync per ceiling window, and a no-op on a disabled or
    // stopped mirror, so the block loop can call it on every deferring poll tick.
    // Returns true when a resync was actually kicked.
    requestResync(reason) {
        if (!this.enabled || !this.running) return false;
        if (!Number.isFinite(this.barrierHoldCeilingMs) || this.barrierHoldCeilingMs <= 0) return false;
        const now = Date.now();
        if (this._lastResyncRequestAt && (now - this._lastResyncRequestAt) < this.barrierHoldCeilingMs) return false;
        this._lastResyncRequestAt = now;
        this.forcedResyncCount++;
        console.warn('HubDbSync: forcing a mirror resync (' + String(reason || 'barrier hold ceiling reached') + ')');
        if (this.ws) {
            // terminate() over close(): a half-open socket may never complete a closing
            // handshake, and the 'close' handler runs either way to schedule the reconnect.
            try {
                if (typeof this.ws.terminate === 'function') this.ws.terminate();
                else if (typeof this.ws.close === 'function') this.ws.close();
            } catch (err) {
                console.warn('HubDbSync: forced resync could not terminate the socket:', err && err.message);
            }
            return true;
        }
        // No live socket: poll mode, or a reconnect already pending. Re-drive the
        // bootstrap directly so a stuck poll-mode mirror still gets a fresh pull.
        Promise.resolve()
            .then(() => this._bootstrapAll())
            .catch(err => console.warn('HubDbSync: forced resync bootstrap failed:', err && err.message));
        return true;
    }

    _scheduleReconnect() {
        if (!this.running) return;
        setTimeout(async () => {
            if (!this.running) return;

            // Await the hub's ready acknowledgement before re-bootstrapping, for the
            // same reason as start(): no row must fall in the gap between the REST
            // snapshot and the subscription becoming active on the hub side.
            try {
                await this._connectWebSocket();
            } catch (err) {
                // _connectWebSocket already queued another _scheduleReconnect via the
                // close handler; nothing more to do here.
                return;
            }

            // Proactively re-sync the barrier heights from the LOCAL mirror the
            // instant the socket is back (before re-bootstrap). The disconnect may
            // have frozen the in-memory heights behind a mirror that is already
            // current (or close to it); refreshing here clears any block deferred
            // only on that staleness immediately, instead of making each wait for
            // re-bootstrap to redeliver rows or fall through to the 60s timeout.
            await this._refreshAllSyncHeights();

            // Re-bootstrap to fill in rows missed while disconnected. _bootstrapTable
            // uses the local max-ID as since_id, so it fetches only genuinely-missing
            // rows; re-receives are harmless thanks to INSERT IGNORE in _applyRow.
            // A full drain re-opens the heartbeat gate and advances the watermark.
            await this._bootstrapAll();
        }, 5000);
    }

    // Polling fallback when ws is not available. Poll-mode mirrors do NOT get the
    // same liveness semantics as the WS heartbeat (#2476): the REST snapshot
    // endpoints are append-only, so a poll cycle can observe new-id INSERTs but can
    // never receive an in-place upsert or a row:deleted retraction. _bootstrapAll
    // therefore refuses to advance the stream watermark while _pollMode is set, so
    // the settlement barriers fail closed (defer) rather than certify against a
    // mirror that may be silently stale. Bootstrapping/mirroring still runs each cycle.
    _startPolling() {
        let poll = async () => {
            if (!this.running) return;
            try {
                await this._bootstrapAll();
            } catch (err) {
                console.warn('HubDbSync: poll error:', err);
            }
            if (this.running) setTimeout(poll, this.pollIntervalMs);
        };
        setTimeout(poll, this.pollIntervalMs);
    }

    // Make a JSON GET request to the hub
    _httpGet(path) {
        return new Promise((resolve, reject) => {
            let parsed = url.parse(this.hubUrl);
            let isHttps = parsed.protocol === 'https:';
            let lib = isHttps ? https : http;
            let opts = {
                hostname: parsed.hostname,
                port:     parsed.port || (isHttps ? 443 : 80),
                path:     path,
                method:   'GET',
                headers:  {},
                timeout:  30000
            };
            if (this.apiKey) opts.headers['x-api-key'] = this.apiKey;

            let req = lib.request(opts, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        return reject(new Error('HTTP ' + res.statusCode));
                    }
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(new Error('invalid JSON: ' + e.message));
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
            req.end();
        });
    }
}

// Remove SQL `--` line comments while respecting quoted strings, so a ';'
// appearing inside comment prose is never mistaken for a statement terminator.
// Faithful copy of the indexer db.js stripSqlLineComments logic; lives here so
// ensureTables() stays self-contained in the vendored client.
function stripSqlLineComments(sql) {
    let out = '';
    let quote = null;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (quote) {
            out += ch;
            if (ch === quote) {
                if (sql[i + 1] === quote) { out += sql[++i]; }
                else { quote = null; }
            }
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
        if (ch === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') { i++; }
            if (i < sql.length) { out += '\n'; }
            continue;
        }
        out += ch;
    }
    return out;
}

// Quote-aware SQL statement splitter. Strips `--` line comments, then breaks on
// ';' only outside quoted strings, so a ';' inside a string literal never tears a
// statement into invalid fragments. Faithful copy of the indexer db.js
// splitSqlStatements logic; lives here so ensureTables() stays self-contained in
// the vendored client.
function splitSqlStatements(sql) {
    const stripped = stripSqlLineComments(sql);
    const statements = [];
    let current = '';
    let quote = null;
    for (let i = 0; i < stripped.length; i++) {
        const ch = stripped[i];
        if (quote) {
            current += ch;
            if (ch === quote) {
                if (stripped[i + 1] === quote) { current += stripped[++i]; }
                else { quote = null; }
            }
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
        if (ch === ';') { statements.push(current); current = ''; continue; }
        current += ch;
    }
    statements.push(current);
    return statements.map((s) => s.trim()).filter(Boolean);
}

// Create the mirror tables from the vendored SQL twin files in sqlDir, for
// consumers that (unlike the indexer, whose verifyTables() owns its schema)
// have no table-creation machinery of their own, e.g. the explorer's embedded
// mirror. Must complete before HubDbSync.start(): starting against a missing
// table poisons the per-table column cache (see _localColumns / the 2026-06-17
// cold-start regression). dbConn is the same doQuery-bearing object the
// HubDbSync constructor takes. Retries each file with exponential backoff so a
// transient DB blip at boot doesn't leave half-built schema.
async function ensureTables(dbConn, sqlDir) {
    const fs   = require('fs');
    const path = require('path');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const files = fs.readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).sort();
    if (files.length === 0)
        throw new Error('ensureTables: no .sql files found in ' + sqlDir);
    const MAX_ATTEMPTS = 5;
    for (const file of files) {
        const table   = file.slice(0, -'.sql'.length);
        const data    = fs.readFileSync(path.join(sqlDir, file), 'utf8');
        const queries = splitSqlStatements(data);
        let lastErr = null;
        let done = false;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt++) {
            try {
                // The SQL twins use bare CREATE TABLE (byte-identical to the
                // indexer originals, whose verifyTables() gates on existence
                // before running them), so gate here the same way: an existing
                // table means this file already ran and re-running would fail
                // with ER_TABLE_EXISTS_ERROR on every restart. Probed inside
                // the retry loop so a transient blip on the probe itself also
                // retries (caught live in the keyed-feed drill 2026-07-06).
                const existing = await dbConn.doQuery('SHOW TABLES LIKE ?', [table]);
                if (existing && existing.length > 0) { done = true; break; }
                for (const query of queries)
                    await dbConn.doQuery(query);
                done = true;
            } catch (err) {
                lastErr = err;
                if (attempt >= MAX_ATTEMPTS) break;
                const backoffMs = Math.min(30000, 500 * Math.pow(2, attempt - 1));
                console.log('ensureTables: error creating ' + file + ' (attempt ' + attempt + '/' + MAX_ATTEMPTS + '): '
                    + (err && err.message) + '. Retrying in ' + backoffMs + 'ms...');
                await sleep(backoffMs);
            }
        }
        if (!done)
            throw new Error('ensureTables: failed to create ' + file + ' after ' + MAX_ATTEMPTS
                + ' attempts: ' + (lastErr ? lastErr.message : 'unknown'));
    }
}

module.exports = HubDbSync;
module.exports.ensureTables = ensureTables;
// Exported so tests assert against the frozen source of truth rather than
// restating its numbers, which would let a future change here pass a stale test.
module.exports.HUB_SYNC_WATERMARK_GRACE_S = HUB_SYNC_WATERMARK_GRACE_S;
// Exported for the direct-hub-DB (no-mirror) call barrier in XChainIndexer.js, which
// opens on the SAME frozen call grace as _callSyncSatisfied's watermark escape. It has
// to resolve that grace through this exact function, not a private copy: the regtest
// override, the off-regtest ignore-with-warning and the invalid-value throw are part of
// the constant's contract, and two nodes resolving it differently fork settlement.
module.exports.resolveWatermarkGrace = resolveWatermarkGrace;

// The named ceiling on a mirror-barrier hold, and its resolver. Exported so
// XChainIndexer reads the SAME value the resync rate-limiter uses: a block loop that
// declared a crossing on one number while the mirror throttled on another would either
// storm the hub or never re-drive it at all.
module.exports.HUB_SYNC_BARRIER_HOLD_CEILING_S = HUB_SYNC_BARRIER_HOLD_CEILING_S;
module.exports.resolveBarrierHoldCeilingMs     = resolveBarrierHoldCeilingMs;
// The batch's chunk size and the drain's progress cadence, plus the shared upsert
// builder: exported so the test can prove the batched statement and the per-row
// statement are the same statement, which is the only thing keeping the ODKU body
// from being maintained twice.
module.exports.PRICE_BATCH_APPLY_ROWS         = PRICE_BATCH_APPLY_ROWS;
module.exports.BOOTSTRAP_PROGRESS_INTERVAL_MS = BOOTSTRAP_PROGRESS_INTERVAL_MS;
module.exports.priceUpsertSql                 = priceUpsertSql;
// The price-mirror bootstrap bound numbers, exported for the same reason as the
// grace constants above and, in the margin case, for one more: it has to stay above
// protocol/constants.js ORACLE_VM_ROUND_WINDOW, and the only place that lockstep can be
// checked is a test that reads both.
module.exports.PRICE_MIRROR_ROUND_MARGIN           = PRICE_MIRROR_ROUND_MARGIN;
module.exports.PRICE_MIRROR_MIN_PRE_HORIZON_ROUNDS = PRICE_MIRROR_MIN_PRE_HORIZON_ROUNDS;
module.exports.PRICE_MIRROR_LOOKBACK_S             = PRICE_MIRROR_LOOKBACK_S;
// A frozen COPY, not the live array: a caller iterating the mirrored-table set
// (a guard asserting every member keeps some property) must not be able to
// mutate the module's own membership by mutating what it was handed.
module.exports.HUB_STATE_TABLES = Object.freeze(HUB_STATE_TABLES.slice());
