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
 * Per-block state-hash preimage (in-place mutations + backdated credits)
 *
 * The three consensus hashes (ledger/actions/contract) cover only rows scoped
 * by actions.block_index = B (new, immutable rows). They deliberately CANNOT see
 * the in-place mutations the replication "updated_rows" channel carries on
 * SURVIVING (earlier-block) rows, nor the backdated cooldown-refund credits that
 * reuse an earlier-block action_index. A follower that silently fails to apply
 * one of those mutations therefore diverges with NO hash mismatch to flag it.
 *
 * This builds a canonical, id-RESOLVED preimage over exactly those mutated rows
 * for block B, so a fourth `state_hash` can be computed and compared. It captures
 * the same row classes the source replicates:
 *   - deactivation_block stamps (stakes/delegations/contract_stakes/contract_delegations)
 *   - SLASH amount cuts (stakes/unstakes/contract_stakes/contract_unstakes via debit logs)
 *   - v0 request_status flips (attests/xcalls)
 *   - cooldown-maturity status flips (unstakes/contract_unstakes)
 *   - backdated cooldown refund credits (capability GAS + contract own-tick)
 *   - invalid_archive stamp on anchor_actions archive-head parent rows (CRC-failed
 *     chunked batches; version set and completing-chunk height key both flag-day gated)
 *   - VOTE poll finalization flips on surviving polls rows (flag-day gated per chain)
 *   - tokens.supply refreshes on surviving token rows (flag-day gated per chain; the
 *     hash twin of the updated_rows tokens-supply replication class)
 *
 * CONSENSUS-STYLE DETERMINISM (mirrors db.js getBlockHashes):
 *   - surrogate AUTO_INCREMENT ids (address_id/tick_id/status_id) are NEVER hashed;
 *     they are resolved to canonical strings via LEFT JOIN (they diverge across
 *     nodes after a reorg, which is the reason BLOCK_HASH_VERSION exists).
 *     action_index is the deterministic on-chain index, safe to hash raw.
 *   - every row set is ORDER BY'd with BINARY-collation-pinned tie-breaks so the
 *     order is independent of each node's default collation.
 *   - the preimage object's key order is fixed in code; the caller hashes it with
 *     the shared util.getDataHash (JSON.stringify + bigint replacer + sha256).
 *
 * BYTE-ALIGNED TWIN: this file is copied verbatim into xchain-sync/src/stateHash.js
 * (the source computes+stores from here; the follower recomputes from the identical
 * copy at apply-time and HALTS on mismatch). Keep them identical; the
 * state-hash-vectors golden + the xchain-e2e recompute-conformance scenario guard
 * the pair. The selection predicates also mirror xchain-sync/src/updatedRows.js +
 * cooldownCredits.js (forward) and ClientRollback.js + rollback.js (reverse).
 *
 ********************************************************************/

const A = require('./state_hash/activation');
const M = require('./state_hash/mutation_sections');
const { collectAnchorInvalid } = require('./state_hash/archive_invalid_section');
const G = require('./state_hash/gated_sections');

const { STATE_HASH_VERSION } = A;

// Build the canonical state-hash preimage object for block B. db must expose
// doQuery(sql, args) and getStatusId(name) (both xchain-indexer and xchain-sync
// Database classes do). opts: { activationDelay, gasTick }. The caller hashes the
// returned object with util.getDataHash. Each class degrades to empty on a missing
// table/column (older schemas) rather than throwing.
async function buildStateHashData(db, blockIndex, opts){
    let B       = Number(blockIndex);
    let delay   = (opts && opts.activationDelay != null) ? Number(opts.activationDelay) : null;
    let gasTick = (opts && opts.gasTick != null) ? opts.gasTick : null;
    let network = (opts && opts.network != null) ? opts.network : null;
    let coin    = (opts && opts.coin != null) ? opts.coin : null;
    let completedStatusId = await db.getStatusId('completed');

    let deactivations  = await M.collectDeactivations(db, B, delay);
    let slashes        = await M.collectSlashes(db, B);
    let request_status = await M.collectRequestStatus(db, B);
    let cooldown       = await M.collectCooldown(db, B);
    let credits        = await M.collectCredits(db, B, gasTick, completedStatusId);
    let anchor_invalid = await collectAnchorInvalid(db, B, network, coin);

    let indexMapActive     = A.isIndexMapStateHashActive(B, network);
    let indexMap           = indexMapActive ? await G.collectIndexMapDelta(db, B) : null;
    let pollFinalizeActive = A.isPollFinalizeStateHashActive(B, network, coin);
    let poll_finalize      = pollFinalizeActive ? await G.collectPollFinalize(db, B) : null;
    let tokenSupplyActive  = A.isTokenSupplyStateHashActive(B, network, coin);
    let token_supply       = tokenSupplyActive ? await G.collectTokenSupply(db, B) : null;
    let betStatusActive    = A.isBetStatusStateHashActive(B, network, coin);
    let bet                = betStatusActive ? await G.collectBetStatus(db, B) : null;

    // Fixed key order: the hash preimage. NOT chained on a previous state_hash
    // (the adjacent three hashes already carry chain-continuity; a chain would only
    // make NULL-backfill of historical blocks poison every successor). Gated keys
    // are inserted (in fixed order, before block_index) ONLY when active, so an
    // inert block serializes byte-identically to the pre-feature preimage.
    let preimage = { deactivations, slashes, request_status, cooldown, credits, anchor_invalid };
    if(indexMapActive){
        preimage.index_addresses_new = indexMap.index_addresses_new;
        preimage.index_tickers_new   = indexMap.index_tickers_new;
    }
    if(pollFinalizeActive) preimage.poll_finalize = poll_finalize;
    if(tokenSupplyActive)  preimage.token_supply  = token_supply;
    if(betStatusActive){
        preimage.bet_feed_status = bet.bet_feed_status;
        preimage.bet_status      = bet.bet_status;
    }
    preimage.block_index        = B;
    preimage.state_hash_version = STATE_HASH_VERSION;
    return preimage;
}

module.exports = { buildStateHashData, STATE_HASH_VERSION,
                   DEACTIVATION_TABLES: M.DEACTIVATION_TABLES, SLASH_SPECS: M.SLASH_SPECS,
                   REQUEST_STATUS_TABLES: M.REQUEST_STATUS_TABLES, COOLDOWN_TABLES: M.COOLDOWN_TABLES,
                   INDEX_MAP_STATE_HASH_ACTIVATION: A.INDEX_MAP_STATE_HASH_ACTIVATION,
                   isIndexMapStateHashActive: A.isIndexMapStateHashActive,
                   POLL_FINALIZE_STATE_HASH_ACTIVATION: A.POLL_FINALIZE_STATE_HASH_ACTIVATION,
                   isPollFinalizeStateHashActive: A.isPollFinalizeStateHashActive,
                   TOKEN_SUPPLY_STATE_HASH_ACTIVATION: A.TOKEN_SUPPLY_STATE_HASH_ACTIVATION,
                   isTokenSupplyStateHashActive: A.isTokenSupplyStateHashActive,
                   BET_STATUS_STATE_HASH_ACTIVATION: A.BET_STATUS_STATE_HASH_ACTIVATION,
                   isBetStatusStateHashActive: A.isBetStatusStateHashActive,
                   ARCHIVE_HEAD_VERSIONS: A.ARCHIVE_HEAD_VERSIONS,
                   ARCHIVE_HEAD_VERSIONS_SQL: A.ARCHIVE_HEAD_VERSIONS_SQL,
                   archiveHeadPredicate: A.archiveHeadPredicate,
                   checkpointSectionPredicate: A.checkpointSectionPredicate,
                   ARCHIVE_INVALID_STATE_HASH_ACTIVATION: A.ARCHIVE_INVALID_STATE_HASH_ACTIVATION,
                   isArchiveInvalidStateHashActive: A.isArchiveInvalidStateHashActive,
                   ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION: A.ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION,
                   isArchiveInvalidHeightKeyActive: A.isArchiveInvalidHeightKeyActive,
                   ARCHIVE_CHUNK_HEIGHT_COL: A.ARCHIVE_CHUNK_HEIGHT_COL,
                   ARCHIVE_CHUNK_HEIGHT_COL_LEGACY: A.ARCHIVE_CHUNK_HEIGHT_COL_LEGACY };
