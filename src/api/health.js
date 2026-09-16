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
const { computeArmedMapFingerprintV2 } = require('../consensus/armed_map/fingerprint');
const { computeConsensusRulesDigest } = require('../consensus_rules_digest');
const { barrierHoldMs, barrierCeilingExceeded } = require('../XChainIndexer');
// Field groups assembled in the parts under ./health/; each is placed at the
// position its fields always held, so the payload keeps its key order.
const { carrierLogicDigest }          = require('./health/carrier_logic');
const { syncFields }                  = require('./health/sync_fields');
const { stallFields }                 = require('./health/stall_fields');
const { advanceFields }               = require('./health/advance_fields');
const { hubFields }                   = require('./health/hub_fields');
const { actionCounters, reorgFields } = require('./health/counter_fields');

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
    // The one awaited read (the hub push queue's stats) still happens BEFORE the
    // payload is assembled, so every field below is taken from a single view of
    // the indexer rather than from either side of a yield.
    let hub = await hubFields(indexer, now);

    return {
        // Serving verdict, committed position and the two database circuit
        // breakers: status through indexerDbCircuit.
        ...syncFields(indexer, { indexerRunning, lastIndexedBlock, inFlightBlock }),
        // Why this node is not advancing, and whether it is still on the fleet's
        // rule set: stallReason, decoderReorgHalted, train_activation.
        ...stallFields(indexer),
        // Commit recency, poll-loop liveness and the stall discriminator:
        // lastBlockCommittedAt through stallClearsAt.
        ...advanceFields(indexer, now),
        // How long ONE block has been held behind the hub-mirror barriers, and the named
        // ceiling on that hold. stallClearsAt above answers "when can this barrier FIRST
        // open"; these answer "how long has it stayed shut", a quantity nothing else here
        // bounds. A rising barrierHoldMs with stallClass 'barrier_defer' is the
        // metronome signature: every log line healthy, the deferred block never changing.
        // The future-stamped-block wait is excluded from the hold deliberately (it has its
        // own bound, the block's own stamp), so a non-zero value here is never miner clock
        // skew: it is a mirror barrier or a host fault, and stallReason says which.
        barrierHoldMs:        barrierHoldMs(indexer.barrierHold, now),
        barrierHoldBlock:     (indexer.barrierHold && indexer.barrierHold.block != null)
                                ? indexer.barrierHold.block : null,
        barrierHoldCeilingMs: indexer.barrierHoldCeilingMs || null,
        // true while the current hold is past the ceiling. Reporting only: the block is still
        // deferring fail-closed, and the node has forced a hub-mirror resync (mirror barriers
        // only) rather than relaxed anything. barrierCeilingHits counts crossings since boot.
        barrierCeilingExceeded: barrierCeilingExceeded(indexer.barrierHold, indexer.barrierHoldCeilingMs, now),
        barrierCeilingHits:     indexer.barrierCeilingHits || 0,
        // Hub config overlay age and the hub push retry queue counts.
        ...hub,
        action_counters:  actionCounters(indexer),
        // Consensus-gate build fingerprint, v2 since W3: the armed VALUES row by row, so
        // a sweep compares armed maps across a rename or move; UNREADABLE, never a guess.
        // The _v2 alias of the W1 to W4 window is gone since W5: the version field is
        // what tells a fleet tool which algorithm the legacy field carries.
        armed_map_fingerprint: computeArmedMapFingerprintV2().hex,
        armed_map_fingerprint_version: 2,
        // The logic half v2 stopped covering, its own field beside v2, never inside it.
        carrier_logic_digest: carrierLogicDigest(),
        // The CROSS-REPO half of the same question. armed_map_fingerprint hashes this
        // repo's own file bytes and so is only comparable against another indexer;
        // this digest hashes the DECIDED HEIGHTS of the gates the hub evaluates too,
        // so an operator (or a fleet sweep) can compare an indexer against the hub
        // federation it follows and see a flag-day disagreement BEFORE it has produced
        // divergent state rather than after.
        consensus_rules_digest: computeConsensusRulesDigest().digest,
        // Reorg/rollback observability, null when the API server did not read it.
        ...reorgFields(reorgStats),
        error:            indexerError ? indexerError.message : null
    };
}

module.exports = { buildHealthResponse, committedView, inFlightBlockIndex };
