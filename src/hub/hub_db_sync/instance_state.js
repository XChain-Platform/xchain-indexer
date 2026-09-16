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
 * XChain Indexer - Hub DB Sync Client: instance state
 *
 * The connection settings, the per-table barrier scalars and their waiter lists,
 * the consumer hooks, and the Bitcoin chain identity fence: the first half of
 * what the constructor sets, as named initializers called in order.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { readEnvNow } = require('./env.js');

// Connection settings and the poll-mode flag.
function initConnection(sync, hubDb, options) {
    sync.hubDb     = hubDb;                            // Database instance pointing at the local hub DB
    sync.hubUrl    = options.hubUrl   || readEnvNow('HUB_API_URL') || '';
    sync.apiKey    = options.apiKey   || readEnvNow('HUB_API_KEY') || '';
    sync.enabled   = !!sync.hubUrl && !!sync.hubDb;
    sync.pollIntervalMs = parseInt(options.pollInterval || readEnvNow('HUB_DB_SYNC_POLL_INTERVAL') || '30000');
    // Total wall-clock budget for one snapshot GET. The `timeout: 30000` request
    // option in httpGet is an IDLE-socket timer that resets on every byte received,
    // so a hub drip-feeding a body holds the request (and, through bootstrapAll's
    // guard, the whole mirror bootstrap) open indefinitely inside it. Four times the
    // idle timer, so a 10k-row snapshot page has room to stream and only a wedged
    // request can reach the ceiling.
    sync.httpDeadlineMs = parseInt(options.httpDeadline || readEnvNow('HUB_DB_SYNC_HTTP_DEADLINE') || '120000');
    sync.ws        = null;
    sync.running   = false;
    // True when the WebSocket path is unavailable and this mirror falls back to
    // periodic REST polling (#2476). In poll mode the stream watermark must NOT
    // advance: REST snapshot endpoints are append-only, so a poll cycle can never
    // observe an in-place upsert or a row:deleted retraction, and certifying the
    // mirror as live-complete would open the settlement barriers over data that can
    // be silently stale. Set in start() when the fallback is selected.
    sync._pollMode = false;
}

// The height-keyed and time-keyed price barriers' scalars and waiter lists.
function initPriceBarrierState(sync) {
    // Highest reference_block present in the local price_snapshots copy. Used by the
    // block-processing sync barrier (waitForPriceSyncHeight) so an indexer does not
    // validate native-coin fees for a block until its local price mirror has caught up
    // to that block; otherwise two operators with different sync states could read a
    // different latest price round and compute a different fee threshold, diverging the
    // ledger. Refreshed after every successful price_snapshots sync.
    sync.priceSyncHeight = 0;
    sync._priceWaiters   = [];                         // pending waitForPriceSyncHeight() resolvers

    // Highest block_timestamp among finalized rounds in the local price_snapshots copy.
    // Used by the time-keyed price barrier (waitForPriceSyncTime), which runs on EVERY chain
    // whenever sync is enabled and is not conditioned on the NATIVE_FEE_PRICE_TIME_GATE
    // flag-day (XChainIndexer.js:877-903). Non-reference chains' heights are not comparable
    // to the rounds' BTC reference_block anchor, so catch-up is judged by the rounds'
    // consensus timestamps against the block's time instead (H-3); on BTC the time barrier
    // is ADDITIVE to the height one, since height coverage does not imply time coverage.
    // Refreshed together with priceSyncHeight after every successful price_snapshots sync.
    sync.priceSyncMaxTimestamp = 0;
    sync._priceTimeWaiters     = [];                   // pending waitForPriceSyncTime() resolvers
}

// The content-watermark barriers over the other mirrored tables.
function initContentBarrierState(sync) {
    // Highest effective_at present in the local oracle_prices copy. Used by the
    // block-processing sync barrier (waitForOracleSyncTimestamp) so an indexer does not
    // settle FIAT dispensers for a block until its local oracle mirror has caught up to
    // that block's time; otherwise two operators with different sync states could read a
    // different set of effective oracle prices in reverseOraclePriceMatch() and settle a
    // FIAT dispenser at a different amount, diverging the ledger. Refreshed after every
    // successful oracle_prices sync. Unlike price_snapshots (foundational on BTC),
    // oracle_prices is optional: a deployment with no FIAT oracles never populates it, so
    // this stays null and the barrier must treat that as "nothing to wait on" (see
    // oracleSyncSatisfied) rather than stalling every block forever.
    sync.oracleSyncTimestamp = null;                   // null = mirror's max effective_at not yet known
    sync.oracleBootstrapped  = false;                  // true once the mirror has been read at least once
    sync._oracleWaiters      = [];                     // pending waitForOracleSyncTimestamp() resolvers

    // Highest effective_time present in the local cross_chain_matches copy. The
    // cross-chain settlement pass uses waitForMatchSync(block_time) so an indexer does
    // not settle a block until its match mirror has caught up to that block's time;
    // otherwise two operators of the same chain could settle a cross-chain match at
    // different blocks, diverging that chain's ledger. Mirrors oracleSyncTimestamp:
    // a NULL max (empty mirror) is valid and means "no cross-chain matches to wait on".
    sync.matchSyncTimestamp = null;
    sync.matchBootstrapped  = false;
    sync._matchWaiters      = [];

    // Highest effective_time present in the local cross_chain_calls copy (the
    // XCALL relay's equivalent of the match barrier. The injection/callback
    // passes use waitForCallSync(block_time) so an indexer never applies a
    // block until its call mirror has caught up to that block's time. Same
    // NULL-is-valid semantics and watermark escape as the match barrier
    // (#1984 class: a quiet table must never freeze the tip).
    sync.callSyncTimestamp = null;
    sync.callBootstrapped  = false;
    sync._callWaiters      = [];

    // Highest effective_time present in the local bridge_transfers copy, scoped to the
    // transfers THIS chain can act on (source or destination leg). The XBRIDGE settle
    // pass uses waitForBridgeSync(block_time) so an indexer never mints a bridged credit
    // until its transfer mirror has caught up to that block's time; otherwise two
    // operators of the same destination chain would apply one transfer at different
    // blocks and fork that chain's ledger. Same NULL-is-valid semantics and watermark
    // escape as the match and call barriers.
    sync.bridgeSyncTimestamp = null;
    sync.bridgeBootstrapped  = false;
    sync._bridgeWaiters      = [];

    // Highest effective_time present in the local policy_snapshots copy, scoped to the
    // snapshots this chain can act on. Keyed on origin_chain alone, NOT on a
    // source/destination pair: a policy row targets every chain holding a copy of the
    // tick and names no destination, so there is nothing to scope the far side by.
    sync.policySyncTimestamp = null;
    sync.policyBootstrapped  = false;
    sync._policyWaiters      = [];
}

// What the consumer told this client about itself and the hooks it wired.
function initConsumerHooks(sync, options) {
    // Coin this indexer settles for (e.g. 'LTC'). Read to scope the snapshot-presence
    // barrier to matches this chain will actually settle. See waitForSnapshotSync.
    sync.coin = options.coin || null;

    // Database holding this node's OWN authoritative stake rows, the source for
    // re-deriving mirrored capability_snapshots rows (see
    // refuseUnprovenCapabilitySnapshot).
    // Capability stakes are indexed into the INDEXER db, not the hub-mirror db, so
    // this is deliberately NOT hubDb. Supplied explicitly by a test or an embedder;
    // otherwise resolved lazily off the mirror db's parent indexer, because that is
    // the only wiring the live service has and the check must not depend on a new
    // constructor argument reaching every consumer. Absent (the explorer's vendored
    // display mirror, direct-hub-DB mode) the check never runs and rows apply exactly
    // as they did before, which is the fail-open the verdict shape already encodes.
    sync.authoritativeDb = options.authoritativeDb || null;

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
    sync.getOwnRollbackGeneration = (typeof options.getOwnRollbackGeneration === 'function')
        ? options.getOwnRollbackGeneration : null;
    sync.trackedRollbackGeneration = {};

    // signed retractions: the network this mirror serves (mainnet |
    // testnet | regtest), which keys the RETRACTION_SIGNING flag-day and the
    // stake-weighted-quorum activation when verifying a quorum-class
    // retraction's co-signature set. The gate itself is judged from the local
    // mirrored capability_snapshots high-water mark, NEVER from a wire field.
    // Absent (explorer's vendored display mirror, older wiring) the gate never
    // arms and the fences above stand alone, as before.
    sync.network = options.network || null;
}

function initChainIdentityState(sync) {
    // ── Chain identity for the three CROSS_CHAIN_TABLES ─────────────────────────
    //
    // `network` above scopes a mirrored row to mainnet/testnet/regtest, and on regtest
    // that is not enough: one network name spans every Bitcoin chain a venue has ever
    // had. A venue that re-genesises its Bitcoin chain without rebuilding the hub
    // database keeps serving the dead chain's finalized matches and capability
    // snapshots, and every fresh indexer mirrors all of them (measured on the
    // regtest venue 2026-09-08: two relic matches and 33 snapshots, evaluated at every
    // block against a validator set that no longer exists on the chain).
    //
    // The identity is the hash of BITCOIN BLOCK 1 on the chain the hub's Bitcoin indexer
    // follows, carried on the wire and locally as `btc_chain_id`. Block 0 cannot serve:
    // the regtest genesis hash is a chainparams constant, identical across every
    // re-genesis, while block 1 commits to the instant the chain was created.
    //
    // Two sources, and they are NOT equal. A Bitcoin indexer reads block 1 from its own
    // decoder database and sets it 'local': that is this node's own measurement of the
    // chain it indexes, and no hub can overrule it. Every other consumer (a DOGE or LTC
    // indexer, the explorer's vendored display mirror) has no Bitcoin chain of its own to
    // read and learns the id 'hub', from the value the hub advertises on the three
    // snapshot envelopes; a hub id is FOLLOWED, so a re-genesis the hub has already
    // adopted cannot strand a running non-BTC mirror on rows it refuses forever.
    //
    // A NULL on a row is always accepted: every row written before the column existed
    // carries NULL, so mainnet and testnet history keeps mirroring unchanged.
    sync._expectedBtcChainId = null;                   // 64 lowercase hex, or null while unknown
    sync._btcChainIdSource   = null;                   // 'local' | 'hub' | null
    // Refusals waiting to be reported, keyed table + '|' + hash. Counted rather than
    // logged per row, so a drain that refuses a whole relic table says so once.
    sync._refusedChainIdRows = new Map();
    // One re-probe per unseen id and one warning per process, so a stream of foreign
    // rows can storm neither the hub nor the log (see maybeAdoptHubChainId).
    sync._chainIdProbedIds     = new Set();
    sync._foreignHubChainNoted = false;

    // Pending waitForSnapshotSync() resolvers. Unlike the match barrier (a cached
    // scalar max(effective_time)), snapshot-presence is set-dependent: a match can
    // only be settled once the capability_snapshots row set for its snapshot_block is
    // mirrored, so satisfaction is recomputed by a live query per evaluation rather
    // than tracked as a scalar. Gating block advancement on it (defer-and-retry, like
    // the match barrier) keeps every operator settling a match at the same height even
    // if the snapshot mirrors in after the match. See snapshotSyncSatisfied.
    sync._snapshotWaiters   = [];
}

module.exports = { initConnection, initPriceBarrierState, initContentBarrierState, initConsumerHooks, initChainIdentityState };
