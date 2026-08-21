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
    price:  600,
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
function coerceMirrorValue(v) {
    if (typeof v !== 'string') return v;
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
const FULL_REPAGE_TABLES = ['capability_snapshots', 'price_snapshots', 'cross_chain_calls', 'cross_chain_matches'];

// Hub federation state tables. state_checkpoints carries quorum-signed per-chain
// state-hash commitments (the explorer/SDK verification source). Append-only,
// never retracted. A reorged height is superseded by a new row with a higher
// checkpoint_seq. Not on any settlement-critical path (no block-loop barrier).
// anchor_reward_attestations carries the hub's XANCPUB publisher-attestation
// quorum per attested reward tuple; the BTC indexer derives the COLLECT-spendable
// anchor/archive reward from it (mirror is transport, not trust: it re-verifies the
// sigs against its own local oracle_publish set). Append-only, id-parity INSERT IGNORE,
// never retracted (rows are written only post-quorum for a finalized checkpoint).
const HUB_STATE_TABLES = ['state_checkpoints', 'anchor_reward_attestations'];

// TTL for the per-table local-column cache. Bounds how long a hub-side column
// rename can keep silently NULLing the mirror before _localColumns re-reads the
// schema and self-heals (see _localColumns).
const LOCAL_COLUMN_CACHE_TTL_MS = 5 * 60 * 1000;

// Cap on live price_snapshots events buffered while the price bootstrap drains
// (see _bufferPriceEvent). Rounds finalize on PBFT cadence, so even a
// multi-minute drain sees a handful; the cap only bounds a pathological hub.
const PENDING_PRICE_EVENT_CAP = 10000;

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

        // Determine the highest existing ID in the local copy so we only fetch newer rows.
        // EXCEPT the FULL_REPAGE_TABLES (see above): a since_id = MAX(local id) cursor is
        // INSERT-shaped and can never re-fetch an in-place upgrade (and capability_snapshots
        // also has locally-assigned ids). Re-page those from 0; the natural-key UNIQUE +
        // idempotent _applyRow (INSERT IGNORE / ODKU) dedupe, and the in-loop cursor still
        // advances off the hub's wire ids.
        let lastId = 0;
        if (!FULL_REPAGE_TABLES.includes(table)) {
            try {
                let rows = await this.hubDb.doQuery('SELECT MAX(id) AS max_id FROM ' + table);
                if (rows.length > 0 && rows[0].max_id) lastId = Number(rows[0].max_id);
            } catch (e) {
                // Table may not exist yet; bootstrap starts at 0
            }
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

            for (let row of result.rows) {
                try {
                    await this._applyRow(table, row);
                    if (servedMatchIds) {
                        servedMatchIds.add(String(row.match_id));
                        let sid = Number(row.id);
                        if (Number.isFinite(sid) && sid > maxServedId) maxServedId = sid;
                    }
                    applied++;
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
                    break;
                }
                // Advance the cursor only for a row that actually applied.
                let rowId = Number(row.id);
                if (Number.isFinite(rowId) && rowId > lastId) lastId = rowId;
            }
            lastPageCount = result.rows.length;
            // The LAST page's watermark is the hub's most recent "complete through ts"
            // statement covering everything fetched so far.
            if (Number.isFinite(Number(result.watermark))) watermark = Number(result.watermark);
            if (applyErrors > 0) break;                      // hole hit: stop paging, retry from it
            if (result.rows.length < PAGE_LIMIT) break;      // short page = drained
        }
        console.log('HubDbSync: bootstrapped ' + applied + ' rows into ' + table);

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
            let localRows = [];
            try {
                localRows = await this.hubDb.doQuery('SELECT MAX(id) AS max_id FROM ' + table);
            } catch (e) { /* ignore */ }
            let localMax = (localRows.length > 0 && localRows[0].max_id) ? Number(localRows[0].max_id) : 0;
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
    //      local mirror is always a CONTIGUOUS prefix of the hub's table; a
    //      fresh round streamed mid-drain can no longer raise the height over
    //      still-missing earlier rounds. See _bufferPriceEvent, #2422).
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
        if (table === 'capability_snapshots') cols = cols.filter(c => c !== 'id');
        if (cols.length === 0) return;
        let placeholders = cols.map(() => '?').join(', ');
        let args = cols.map(c => coerceMirrorValue(row[c]));

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
            let updatable = cols.filter(c => c !== 'id' && c !== 'round_number' && c !== 'coin_pair' && c !== 'status');
            let sets = updatable.map(c => '`' + c + "` = IF(VALUES(status) = 'finalized', VALUES(`" + c + '`), `' + c + '`)');
            sets.push("status = IF(VALUES(status) = 'finalized', 'finalized', status)");
            let query = 'INSERT INTO price_snapshots (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES (' + placeholders + ')'
                      + ' ON DUPLICATE KEY UPDATE ' + sets.join(', ');
            await this.hubDb.doQuery(query, args);
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

        let query = 'INSERT IGNORE INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + placeholders + ')';
        await this.hubDb.doQuery(query, args);
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
            entry = this._localColumnCache[table] = { cols: new Set(rows.map(r => r.Field)), fetchedAt: Date.now() };
        }
        return entry.cols;
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
