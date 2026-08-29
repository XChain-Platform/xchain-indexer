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
 * XChain Indexer - Health response assembly
 *
 * Builder for the `health` JSON-RPC payload. Lives apart from api.js so it
 * can be unit-tested without booting the Express server or requiring database
 * env vars. api.js does the one async DB lookup (lastIndexedBlock) and the
 * clock read, then hands the resolved values here.
 *
 ********************************************************************/

const { computeArmedMapFingerprint } = require('./armedMapFingerprint');
const { hubConfigStaleness, stallWedged, waitingOnFutureBlock, stallClassOf, atProcessableTip } = require('./XChainIndexer');

// Committed-only view of a db handle, for any read that ADVERTISES A HEIGHT.
// A bare read routes through db.getConnection(), which hands back the block
// loop's open transactionConnection while a block is processing, so it
// dirty-reads the uncommitted block: health then reports a height that no
// committed-only reader can answer at. Every federation query guard reads
// through apiView(), so an advertised in-flight height is deterministically
// rejected by the very next call ("block_index N not yet indexed (latest:
// N-1)") whenever the poll lands mid-block. Worse, if that block later rolls
// back (reorg, or a guard throwing) the advertised height never committed at
// all, which is a lie about sync position to any monitor or federation client.
// Falls back to the raw handle for stubs without apiView (unit/smoke doubles).
// That fallback is a test affordance and not a production path; the rationale,
// and why it must never spread to a federation read, is stated in full at the
// indexerReorgView guard in XChainIndexer.js.
function committedView(db){
    return (db && typeof db.apiView === 'function') ? db.apiView() : db;
}

// The block currently INSIDE the open block transaction, or null when no block
// transaction is open. Derived from state the block loop already keeps
// (db.blockIndex is stamped right after beginTransaction), so reporting it
// costs no query and never touches the block's physical connection. db.blockIndex
// is not cleared on commit, hence the transactionConnection gate: outside a
// transaction the field is a stale leftover, not an in-flight block.
function inFlightBlockIndex(db){
    if(!db || !db.transactionConnection) return null;
    let bi = db.blockIndex;
    return (bi === null || bi === undefined) ? null : Number(bi);
}

async function buildHealthResponse({ indexer, indexerRunning, indexerError, lastIndexedBlock, inFlightBlock, now, reorgStats }){
    let decoderDbCircuit = indexer.decoderDb ? indexer.decoderDb.circuitState : null;
    let indexerDbCircuit = indexer.indexerDb ? indexer.indexerDb.circuitState : null;
    let circuitOpen = decoderDbCircuit === 'open' || indexerDbCircuit === 'open';

    // How long ago the indexer last got a response from the hub for its config
    // overlay. null until the first success. When the hub is down this age keeps
    // climbing while status stays "healthy", so an operator can spot that the
    // hub config overlay is stale. (Consensus params like activation delay,
    // expiration fee, and staking thresholds are NOT live-polled; they come from
    // the per-chain local config. This age reflects only tunable/display params
    // the overlay is permitted to apply.)
    let lastHubConfigFetchAt = indexer.lastHubConfigFetchAt || null;
    // Age + explicit staleness (past hubConfigStalenessLimitMs() = 3 poll intervals), computed
    // by the one shared helper so health and the /health api agree on the threshold.
    let hubConfig            = hubConfigStaleness(lastHubConfigFetchAt, now);
    let hubConfigAgeSeconds  = hubConfig.ageSeconds;
    let hubConfigStale       = hubConfig.stale;

    // Pending and permanently-failed counts from the hub push retry queue.
    // null when no hub is configured. A non-zero `failed` count means price/oracle
    // rows exhausted all retries and were silently dropped; an operator should
    // check hub connectivity and clear the backlog.
    let hubPushQueue = null;
    if(indexer.hubPushQueue){
        try {
            hubPushQueue = await indexer.hubPushQueue.getStats();
        } catch (e){
            // DB unreachable; leave null rather than crashing the health response.
        }
    }

    // Per-type accepted/rejected counts since the process started. Null when the
    // actions instance is not yet initialised (e.g. very early in boot or in unit
    // tests that stub the indexer). Never on any consensus-hashed path.
    let actionCounters = (indexer.actions && typeof indexer.actions.getActionCounters === 'function')
                            ? indexer.actions.getActionCounters()
                            : null;

    return {
        status:           (indexerRunning && !circuitOpen) ? "healthy" : "unhealthy",
        running:          indexerRunning,
        synced:           indexer.isSynced(),
        // COMMITTED height only: read through apiView(), the same
        // committed-only pooled connection every federation query guard uses, so
        // a client may poll health and immediately query AT this height. The
        // block being parsed right now is reported separately as inFlightBlock;
        // it is not indexed yet and a reorg may mean it never is.
        lastIndexedBlock: lastIndexedBlock,
        inFlightBlock:    (inFlightBlock === undefined) ? null : inFlightBlock,
        decoderBlock:     indexer.lastDecoderBlock,
        lag:              (indexer.lastDecoderBlock != null && lastIndexedBlock != null)
                            ? indexer.lastDecoderBlock - lastIndexedBlock
                            : null,
        decoderDbCircuit: decoderDbCircuit,
        indexerDbCircuit: indexerDbCircuit,
        // Why the block counter is not advancing, or null when advancing
        // normally: a hub-sync barrier timeout (price/oracle/match/call/snapshot)
        // or a VM executor host fault. Lets an operator tell these stalls apart
        // from a tripped DB circuit breaker (decoderDbCircuit/indexerDbCircuit
        // === 'open') and a healthy catch-up, all of which otherwise present
        // identically as a growing lag.
        // When the decoder has halted (durable REORG_HALT marker), attribute the stall to that
        // rather than reporting ordinary lag/null. A halted decoder cannot advance, so the
        // indexer's lag is a downstream symptom, not an indexer-side stall.
        stallReason:      indexer.decoderReorgHalted
                            ? (indexer.stallReason || 'decoder_reorg_halt: decoder wrote a REORG_HALT marker; full decoder resync required')
                            : (indexer.stallReason || null),
        decoderReorgHalted: !!indexer.decoderReorgHalted,
        // Advance-recency for the stall discriminator, mirrored from the /status
        // healthcheck so both endpoints tell one story: the epoch-ms of the last successful
        // block commit, and whether a set stallReason is a healthy-degraded barrier defer (the
        // counter is still advancing) rather than a genuine wedge.
        lastBlockCommittedAt: indexer.lastBlockCommittedAt || null,
        // Block-poll loop LIVENESS, a different axis from every stall field around it and the
        // only one that can see a loop hung inside an await: stallReason needs a barrier to
        // have been hit, lag/decoderBlock are written inside the loop and freeze with it, and
        // lastBlockCommittedAt is legitimately old on a quiet chain in the healthy case too.
        // Reported, and deliberately NOT folded into `status` or the /status 503 gate: a single
        // iteration can hold across several sequential barrier waits, and restarting the
        // container is the wrong answer to a slow block. The monitor crits on it instead.
        pollSilent:       (typeof indexer.isPollSilent === 'function') ? indexer.isPollSilent() : false,
        lastPollAt:       indexer.lastPollAt || null,
        // NOTE degraded stays true during the healthy future-stamped-block wait as well,
        // deliberately: the monitor rules key on `degraded === false` for the wedge case, so
        // flipping it there would turn a healthy wait into a crit. waitingOnFutureBlock and
        // stallClass below are how the two are told apart.
        degraded:         !!indexer.stallReason
                            && !stallWedged(indexer.stallReason, indexer.lastBlockCommittedAt,
                                            indexer.healthStallGraceMs, now, indexer.stallClearsAt),
        // true when the stall is nothing but a wait for wall clock to reach a future-stamped
        // block. Healthy and self-clearing: consensus forbids committing that block yet, so the
        // indexer is already holding everything it is permitted to hold. A testnet4 miner
        // stamping each block ~20 min ahead makes this the PERMANENT steady state, with lag
        // pinned at ~6 blocks and stallReason naming whichever time-keyed barrier is waiting.
        waitingOnFutureBlock: waitingOnFutureBlock(indexer.stallReason, indexer.stallClearsAt, now),
        // Single machine-readable verdict on the block counter, so a monitor reads one field
        // instead of joining three: 'none' | 'future_block_wait' | 'barrier_defer' | 'wedged'.
        stallClass:       stallClassOf(indexer.stallReason, indexer.lastBlockCommittedAt,
                                       indexer.healthStallGraceMs, now, indexer.stallClearsAt),
        // true when every block consensus currently PERMITS this indexer to commit is
        // committed (level with the decoder tip, or the only blocker is a future-stamped
        // block). The "functionally caught up" signal: `synced` keeps its literal
        // decoder-tip-parity meaning and reads false through the whole future-stamp wait.
        atProcessableTip: atProcessableTip(indexer.isSynced(), indexer.stallReason,
                                           indexer.stallClearsAt, now),
        // Epoch-ms at which the current time-keyed barrier can first be satisfied,
        // or null. Non-null means the indexer is waiting on WALL CLOCK (a future-stamped
        // block), which is expected and self-clearing rather than a wedge, and it tells an
        // operator exactly when to expect the chain to move again instead of leaving a
        // multi-hour, entirely valid stall looking like a dead service.
        stallClearsAt:    indexer.stallClearsAt || null,
        lastHubConfigFetchAt: lastHubConfigFetchAt,
        hubConfigAgeSeconds:  hubConfigAgeSeconds,
        hubConfigStale:       hubConfigStale,
        hub_push_queue:   hubPushQueue,
        action_counters:  actionCounters,
        // Reorg/rollback observability: total processed reorgs and the block index +
        // epoch-ms timestamp of the most recent one, so the dashboard can meter the
        // decoder->indexer reorg handshake instead of a frequently-reorging chain
        // presenting as an ordinary healthy indexer. Null when the API server did not
        // (or could not) read them.
        // Consensus-gate build fingerprint: one string per process so a
        // fleet sweep can confirm every deployed indexer runs the same armed map
        // before a flag-day height. Per-file hashes live behind computeArmedMapFingerprint.
        armed_map_fingerprint: computeArmedMapFingerprint().fingerprint,
        reorgsProcessed:  reorgStats ? reorgStats.reorgsProcessed : null,
        lastReorgBlock:   reorgStats ? reorgStats.lastReorgBlock  : null,
        lastReorgAt:      reorgStats ? reorgStats.lastReorgAt     : null,
        error:            indexerError ? indexerError.message : null
    };
}

module.exports = { buildHealthResponse, committedView, inFlightBlockIndex };
