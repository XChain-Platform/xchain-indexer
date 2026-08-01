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

// Assemble the health() response from an indexer instance plus the few
// values the API server owns (whether start() is still running, the last
// fatal error, the freshly-read indexed-block height, and the current epoch
// ms). Async only for the hub_push_queue stats fetch; all other fields are
// derived synchronously from already-resolved values.
const { computeArmedMapFingerprint } = require('./armedMapFingerprint');
const { hubConfigStaleness, stallWedged } = require('./XChainIndexer');

async function buildHealthResponse({ indexer, indexerRunning, indexerError, lastIndexedBlock, now, reorgStats }){
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
    // Age + explicit staleness (past HUB_CONFIG_STALENESS_LIMIT_MS = 3 poll intervals), computed
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
        lastIndexedBlock: lastIndexedBlock,
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
        // #2736: when the decoder has halted (durable REORG_HALT marker), attribute the stall to
        // that rather than reporting ordinary lag/null. A halted decoder cannot advance, so the
        // indexer's lag is a downstream symptom, not an indexer-side stall.
        stallReason:      indexer.decoderReorgHalted
                            ? (indexer.stallReason || 'decoder_reorg_halt: decoder wrote a REORG_HALT marker; full decoder resync required')
                            : (indexer.stallReason || null),
        decoderReorgHalted: !!indexer.decoderReorgHalted,
        // Advance-recency for the stall discriminator , mirrored from the /status
        // healthcheck so both endpoints tell one story: the epoch-ms of the last successful
        // block commit, and whether a set stallReason is a healthy-degraded barrier defer (the
        // counter is still advancing) rather than a genuine wedge.
        lastBlockCommittedAt: indexer.lastBlockCommittedAt || null,
        degraded:         !!indexer.stallReason
                            && !stallWedged(indexer.stallReason, indexer.lastBlockCommittedAt,
                                            indexer.healthStallGraceMs, now, indexer.stallClearsAt),
        // : epoch-ms at which the current time-keyed barrier can first be satisfied,
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
        // Reorg/rollback observability (#1813): total processed reorgs and the block
        // index + epoch-ms timestamp of the most recent one, so the dashboard can meter
        // the decoder->indexer reorg handshake instead of a frequently-reorging chain
        // presenting as an ordinary healthy indexer. Null when the API server did not
        // (or could not) read them.
        // Consensus-gate build fingerprint : one string per process so a
        // fleet sweep can confirm every deployed indexer runs the same armed map
        // before a flag-day height. Per-file hashes live behind computeArmedMapFingerprint.
        armed_map_fingerprint: computeArmedMapFingerprint().fingerprint,
        reorgsProcessed:  reorgStats ? reorgStats.reorgsProcessed : null,
        lastReorgBlock:   reorgStats ? reorgStats.lastReorgBlock  : null,
        lastReorgAt:      reorgStats ? reorgStats.lastReorgAt     : null,
        error:            indexerError ? indexerError.message : null
    };
}

module.exports = { buildHealthResponse };
