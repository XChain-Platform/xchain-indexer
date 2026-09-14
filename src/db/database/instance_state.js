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
 * XChain Indexer - Database class part: instance state
 *
 * The state the Database constructor builds, one plain function per concern over the
 * instance it is handed. Not a prototype part: nothing here installs onto the class, so
 * the prototype carries exactly the names the class body declared.
 *
 ********************************************************************/

// Strict, as the constructor these assignments came from was.
'use strict';

const { CONFIG_ENV } = require('../../config.js');

// The direct-connection parameters (verifyDatabase and createDatabase build their own,
// without the database name, because the database may not exist yet).
function connectionParams(self){
    return {
        host:     self.host,
        user:     self.user,
        password: self.pass,
        database: self.dbName,
        port:     self.port
    };
}

// The pool parameters: the same credentials plus the pool's own connection options.
function connectionPoolParams(self){
    return {
        host:     self.host,
        user:     self.user,
        password: self.pass,
        database: self.dbName,
        port:     self.port,
        // Connection options
        connectionLimit:      10,
        connectTimeout:       parseInt(CONFIG_ENV.DB_CONNECT_TIMEOUT) || 10000,
        acquireTimeout:       parseInt(CONFIG_ENV.DB_ACQUIRE_TIMEOUT) || 10000,
        idleTimeout:          60000,
        insertIdAsNumber:     true,
        // Return BIGINT columns as JS Numbers rather than BigInts. Without
        // this, any JSON-RPC handler returning a DB row crashes the process
        // on res.json() with `TypeError: Do not know how to serialize a
        // BigInt` (xchain-hub polls getlatestblock/getactivevalidators/
        // getownstake on a loop, so the crash window is always open).
        // Matches xchain-hub and xchain-sync; all indexer BIGINT columns
        // are within Number.MAX_SAFE_INTEGER for any realistic chain.
        bigIntAsNumber:       true,
        minDelayValidation:   3000,
        queryTimeout:         parseInt(CONFIG_ENV.DB_QUERY_TIMEOUT) || 30000
    };
}

// The block context and the dense index-id guards that ride on it.
function initIndexIdState(self){
    // Block currently being processed. Set by the block loop (XChainIndexer) right
    // after beginTransaction so createAddress/createTicker can stamp the block at
    // which each index id is first assigned (index_addresses/index_tickers.block_index),
    // which rollback uses to delete and deterministically reassign ids on reorg.
    self.blockIndex = null;

    // Read-only guard for the rollback refresh phase. When true, createAddress /
    // createTicker resolve an existing id but NEVER insert a new one (they return
    // null for an unknown entity instead of assigning the next dense id). Rollback
    // sets it around updateBalances/updateTokens/updateMarkets/sanityCheck: those
    // helpers are fed entities collected from the orphaned range, and an entity that
    // existed ONLY in rolled-back blocks has just had its index id deleted. Creating
    // it again here would resurrect that id (a fresh-from-genesis node never had it,
    // so the id stays free there) and re-open the exact wire ^<id> fork the index-row
    // delete just closed. Default false: forward block processing is unaffected.
    self.suppressIndexIdCreation = false;

    // Optional genesis-only intern cache: address-string -> id, LOWER(tick) -> id, and
    // tx-hash -> id.
    // The genesis bootstrap (genesis.js) runs ~240k synthetic ISSUE/TRANSFER actions
    // through the normal pipeline, which re-resolves the same handful of ticks and the
    // constant GAS source dozens of times per action via getTickerId/getAddressId.
    // Those resolution SELECTs dominate genesis time (profiled ~50% of all DB work).
    // When this map is non-null, getTickerId/getAddressId serve non-null hits from
    // memory; the read paths (getTickerId, getAddressId) populate it lazily on a
    // non-null DB hit. create* methods do NOT call .set() directly. It is SAFE only
    // because genesis is one atomic
    // block and a rollback floor: ids are assigned, never deleted, during injection,
    // so a cached id can never go stale. genesis.inject() enables it for the passes and
    // clears it in a finally; normal block processing leaves it null (path unchanged).
    // Caret ^<id> references are never cached (they take a distinct resolution path).
    self._internCache = null;
}

// The per-block read memos and the recovery reward hook gate.
function initReadMemos(self){
    // Single-entry memo for getBlockTime(). block_time is constant for a given
    // block_index, but protocol_changes.isEnabled() re-queries it once per action-handler
    // call (several times per block). Last-block-wins keeps this bounded (a plain Map would
    // grow unbounded across a long-running process) while collapsing the per-action fan-out
    // to one decoder-DB lookup per block.
    self._blockTimeCache = { block_index: null, block_time: null };

    // Companion memo for getBlockTime(), which resolves PROTOCOL time and costs an
    // extra 11-row window read on top of the raw lookup. Same last-block-wins shape
    // and the same reorg invalidation (clearBlockTimeCache clears both).
    self._protocolTimeCache = { block_index: null, block_time: null };

    // Early-decide tally watermark. processVoteFinalizations step 2 re-tallies
    // every armed poll from full ledger/vote/delegation history on EVERY block, uncapped. A
    // non-time_weighted poll's tally is a pure function of {the tick's credits/debits, the
    // poll's votes, the tick's delegations, the (immutable) poll definition}; if none of
    // those gained a row since the last block we tallied the poll, the tally - and therefore
    // the early-decide decision - is byte-identical, and it already did NOT fire (else the
    // poll would be terminal and no longer armed). So we cache, per armed poll, a fingerprint
    // of its input tables' MAX(action_index); a matching fingerprint next block lets us skip
    // the full re-tally. Reorg-invalidated (clearPollTallyWatermark, wired into rollback.js)
    // because a reorg can delete/re-add ledger, vote, and delegation rows at or above the
    // reorg block and reuse action_index values, which would make a stale fingerprint match
    // spuriously. Empty on a fresh process, so the first sight of each poll always tallies.
    self._pollTallyWatermark = new Map();

    // Recovery reward apply-hook gate (F1a id-determinism fix). recovery.js stages
    // archived rewards in recovery_pending_rewards keyed by raw source-address STRING
    // (no index id assigned), and createAddress materializes them into validator_rewards
    // when the source address first gets its deterministic in-block id. This counter is
    // a one-time-probed remaining-unapplied count so normal indexing (no recovery in
    // progress) pays a single COUNT(*) and then short-circuits the hook entirely. The
    // rollback re-arm resets _recoveryPendingChecked to force a re-probe when staged rows
    // are re-armed. See recovery.js and applyPendingRewardsForAddress below.
    self._recoveryPendingChecked   = false;
    self._recoveryPendingRemaining = 0;
}

// The transaction mutex, the watchdog-fence epoch and the connection circuit breaker.
function initTransactionState(self){
    // Serializes DB transactions across the block-processing loop, the reorg rollback
    // path, and the read-only feequote dry-run (Actions.computeFeeQuoteDryRun). The
    // indexer's own paths are single-threaded and never contend, so the lock is always
    // free for them; it only matters when an API-path dry-run opens a forced-rollback
    // transaction that would otherwise collide with live block processing on the shared
    // transactionConnection. Simple non-reentrant async mutex: beginTransaction acquires,
    // commit/rollback release. Held only during active processing (barrier stalls happen
    // before beginTransaction), so it never blocks on a stalled indexer - but it IS held
    // for the whole of a block's processing, so a waiter behind a slow block waits that
    // long. Public read-only callers therefore bound the wait (, acquireTxLock).
    self._txLock = { locked: false, queue: [] };

    // Watchdog-fence epoch (M-16). Monotonic counter identifying the current DB
    // transaction context. beginTransaction assigns a fresh epoch; every teardown
    // (commit or rollback) bumps it, so a write issued under a torn-down transaction
    // carries a stale epoch and is rejected by assertTxNotFenced. See txEpochStore.
    self._txEpoch = 0;

    // Circuit breaker state for database connections
    self.circuitState     = 'closed';  // closed | open | half-open
    self.circuitFailures  = 0;         // consecutive connection failures
    self.circuitThreshold = 10;        // failures before opening circuit
    self.circuitCooldown  = 30000;     // 30s cooldown before half-open retry
    self.circuitOpenUntil = 0;         // timestamp when circuit can transition to half-open
}

module.exports = {
    connectionParams,
    connectionPoolParams,
    initIndexIdState,
    initReadMemos,
    initTransactionState,
};
