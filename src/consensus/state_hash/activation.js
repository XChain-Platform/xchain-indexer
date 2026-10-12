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
 * Flag-day gates, archive-head predicates and class constants for the
 * state-hash preimage. Every gate fails inert: below the threshold or on an
 * unknown network the class is omitted and the preimage stays byte-identical
 * to the pre-feature shape.
 *
 ********************************************************************/

const { copy } = require('../gate_registry');

const STATE_HASH_VERSION = copy('stateHash.STATE_HASH_VERSION');

const INDEX_MAP_STATE_HASH_ACTIVATION = copy('stateHash.INDEX_MAP_STATE_HASH_ACTIVATION');

// Whether the index-map class is folded into state_hash at `blockIndex` on `network`.
// Below the threshold / unknown network -> off (safe; the class is omitted and the
// preimage stays byte-identical to the pre-feature shape).
function isIndexMapStateHashActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = INDEX_MAP_STATE_HASH_ACTIVATION[network];
    if(threshold === undefined) return false;
    return b >= threshold;
}

const POLL_FINALIZE_STATE_HASH_ACTIVATION = copy('stateHash.POLL_FINALIZE_STATE_HASH_ACTIVATION');

// Resolve a per-chain activation threshold: '<COIN>:<network>' key first, then
// the bare network key. A production caller on mainnet/testnet MUST pass coin
// (both real call sites do: indexer db.js getBlockHashes and sync
// BlockHasher.computeStateHash); a coin-less lookup on those networks finds no
// key and stays inert, which is safe only while the OTHER side of the
// conformance pair is equally coin-less (unit fixtures/vectors).
function _activationThreshold(map, network, coin){
    if(coin != null && map[coin + ':' + network] !== undefined) return map[coin + ':' + network];
    return map[network];
}

// Whether the poll-finalize class is folded into state_hash at `blockIndex` on
// `network` for `coin`. Below the threshold / unknown network -> off (safe; the
// class is omitted and the preimage stays byte-identical to the pre-feature shape).
function isPollFinalizeStateHashActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(POLL_FINALIZE_STATE_HASH_ACTIVATION, network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

const TOKEN_SUPPLY_STATE_HASH_ACTIVATION = copy('stateHash.TOKEN_SUPPLY_STATE_HASH_ACTIVATION');

// Whether the token-supply class is folded into state_hash at `blockIndex` on
// `network` for `coin`. Same fail-inert semantics as the poll-finalize gate.
function isTokenSupplyStateHashActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(TOKEN_SUPPLY_STATE_HASH_ACTIVATION, network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

const BET_STATUS_STATE_HASH_ACTIVATION = copy('stateHash.BET_STATUS_STATE_HASH_ACTIVATION');

// Whether the BET status-flip class is folded into state_hash at `blockIndex`
// on `network` for `coin`. Same fail-inert semantics as the gates above.
function isBetStatusStateHashActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(BET_STATUS_STATE_HASH_ACTIVATION, network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

const ARCHIVE_HEAD_VERSIONS = copy('stateHash.ARCHIVE_HEAD_VERSIONS');
const ARCHIVE_HEAD_VERSIONS_SQL = copy('stateHash.ARCHIVE_HEAD_VERSIONS_SQL');

function archiveHeadPredicate(alias){
    return alias + ".match_batch_seq IS NOT NULL AND " + alias + ".version <> 2";
}

function checkpointSectionPredicate(alias){
    return alias + ".chain IS NOT NULL";
}

const ARCHIVE_INVALID_STATE_HASH_ACTIVATION = copy('stateHash.ARCHIVE_INVALID_STATE_HASH_ACTIVATION');

// Whether the anchor_invalid class covers the full archive-head version set at
// `blockIndex` on `network` for `coin`. Below the threshold / unknown network ->
// off (safe; the class keeps its legacy v1-only selection, preimage unchanged).
function isArchiveInvalidStateHashActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(ARCHIVE_INVALID_STATE_HASH_ACTIVATION, network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

const ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION = copy('stateHash.ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION');

const ARCHIVE_CHUNK_HEIGHT_COL = copy('stateHash.ARCHIVE_CHUNK_HEIGHT_COL');
const ARCHIVE_CHUNK_HEIGHT_COL_LEGACY = copy('stateHash.ARCHIVE_CHUNK_HEIGHT_COL_LEGACY');

// Whether class 6 scopes the completing v2 chunk by the repaired
// `block_index_doge` key at `blockIndex` on `network` for `coin`. Below the
// threshold / unknown network -> off (safe; the class keeps the legacy
// `block_index` key, so the preimage is byte-identical to the pre-repair shape).
function isArchiveInvalidHeightKeyActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION, network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

const ATTEST_BATCH_HEAD_STATE_HASH_ACTIVATION = copy('stateHash.ATTEST_BATCH_HEAD_STATE_HASH_ACTIVATION');

// Whether the attest batch-head completion-stamp class is folded into state_hash
// at `blockIndex` on `network` for `coin`. Same fail-inert semantics as the gates above.
function isAttestBatchHeadStateHashActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(ATTEST_BATCH_HEAD_STATE_HASH_ACTIVATION, network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = { STATE_HASH_VERSION,
                   INDEX_MAP_STATE_HASH_ACTIVATION, isIndexMapStateHashActive,
                   POLL_FINALIZE_STATE_HASH_ACTIVATION, isPollFinalizeStateHashActive,
                   TOKEN_SUPPLY_STATE_HASH_ACTIVATION, isTokenSupplyStateHashActive,
                   BET_STATUS_STATE_HASH_ACTIVATION, isBetStatusStateHashActive,
                   ARCHIVE_HEAD_VERSIONS, ARCHIVE_HEAD_VERSIONS_SQL,
                   archiveHeadPredicate, checkpointSectionPredicate,
                   ARCHIVE_INVALID_STATE_HASH_ACTIVATION, isArchiveInvalidStateHashActive,
                   ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION, isArchiveInvalidHeightKeyActive,
                   ARCHIVE_CHUNK_HEIGHT_COL, ARCHIVE_CHUNK_HEIGHT_COL_LEGACY,
                   ATTEST_BATCH_HEAD_STATE_HASH_ACTIVATION, isAttestBatchHeadStateHashActive };
