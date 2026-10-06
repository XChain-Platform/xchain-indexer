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
 * MODULE MAP (the facade owns only the composition and the public surface):
 *   state_hash/activation.js            flag-day gates, archive-head predicates and
 *                                       the per-class constants. Every gate fails
 *                                       inert: below its height, or on an unknown
 *                                       network, the class is omitted and the
 *                                       preimage stays byte-identical to the
 *                                       pre-feature shape.
 *   state_hash/mutation_sections.js     the five ungated in-place classes
 *                                       (deactivations, slashes, request_status,
 *                                       cooldown, credits).
 *   state_hash/archive_invalid_section.js  the anchor_invalid class, which has two
 *                                       separate flag days of its own.
 *   state_hash/gated_sections.js        the four classes folded in only at or after
 *                                       a per-chain height (index map, poll
 *                                       finalize, token supply, bet status).
 *   state_hash/tolerant_query.js        the shared query wrapper that degrades a
 *                                       class to empty on an older schema.
 *
 * PER-CLASS CONTRACT. Every collector takes the database handle and the block
 * height B and returns plain rows (or a small object of row lists) whose values
 * are already resolved to canonical strings:
 *   - deactivations: a stamp written at block B carries the value B + delay, so
 *     the selection is deactivation_block = B + delay on the four stake and
 *     delegation tables. It is skipped (empty) when the delay is unknown, which
 *     mirrors the forward updated_rows collector on the source side.
 *   - slashes: the slashed stake or unstake row, reached through its debit-log
 *     entry for this block. DISTINCT collapses several debits against one stake,
 *     because the cut amount is functionally determined by the action_index.
 *   - request_status: the v0 attest and xcall rows whose resolved_block stamp is B.
 *   - cooldown: unstake and contract-unstake rows whose maturity block is B, with
 *     the status resolved to its name.
 *   - credits: the backdated cooldown refunds, capability GAS plus the contract's
 *     own tick, keyed by the matured unstake's cooldown_end_block. A null gasTick
 *     makes the GAS join match nothing, so the capability branch empties while the
 *     contract branch still runs.
 *   - anchor_invalid: the archive-head parent rows stamped invalid_archive when the
 *     completing chunk of a chunked batch fails its CRC. Its version predicate and
 *     its chunk-height key are gated on separate heights, so a repair of either one
 *     moves the preimage only on its own flag day.
 *   - index map: the (id, string) pairs whose deterministic id was first assigned
 *     at B. It deliberately hashes the surrogate id, the very value under
 *     protection, which is sound only because every assignment path is now
 *     deterministic.
 *   - poll_finalize: polls whose terminal flip landed at B, keyed by resolved_block,
 *     the same key the forward channel selects by and the rollback re-open resets.
 *   - token_supply: (tick, supply) for every tick a credit, debit or escrow touched
 *     at B, since supply is derived from those ledgers and this is exactly the set
 *     of supplies that may have moved.
 *   - bet status: feeds latched or terminal at B and bets settled at B, keyed by
 *     the stamp columns, with the status strings resolved through index_statuses.
 *
 * QUERY ORDER. The ungated classes run first, in the order the preimage lists
 * them, and the gated classes run after every ungated query. A gated class issues
 * no query at all while inert, so an inert block makes exactly the doQuery calls
 * it made before the classes existed and a recorded call sequence stays valid.
 *
 * ORDERING INSIDE A CLASS. Each selection ends in an ORDER BY over keys that form
 * a total order (the on-chain action_index where a row has one, a BINARY-pinned
 * string key where it does not), so two nodes with different default collations
 * produce the same row sequence and therefore the same hash.
 *
 * PUBLIC SURFACE. The re-exports at the bottom keep the names the source
 * indexer, the follower and the test suites already require, so splitting the
 * implementation across the state_hash/ directory moves no import site. A
 * consumer that wants a table list, an activation map or a predicate reads it
 * from here and never from the part that owns it.
 *
 * PREIMAGE SHAPE. The object returned by buildStateHashData has a fixed key
 * order, and that order is the hash input, so it is written out in one place
 * and never derived from iteration:
 *   1. deactivations, slashes, request_status, cooldown, credits, anchor_invalid,
 *      always present, always in that order, each an array that is empty when the
 *      class found nothing or the schema predates it.
 *   2. index_addresses_new and index_tickers_new, only once the index-map gate is
 *      active for the block and network.
 *   3. poll_finalize, then token_supply, then bet_feed_status and bet_status, each
 *      only once its own gate is active.
 *   4. block_index and state_hash_version, always last.
 * A gated key is inserted before block_index only when its gate is active, never
 * as a null placeholder, because a present-but-null key would serialize
 * differently from an absent one and break byte identity on every inert block.
 *
 * WHY THE PREIMAGE IS NOT CHAINED. The three adjacent consensus hashes already
 * carry chain continuity. Chaining this one on the previous state_hash would make
 * a NULL backfill of historical blocks poison every successor, so each block's
 * state hash depends on that block's mutated rows alone.
 *
 * DEGRADING ON OLDER SCHEMAS. A class whose table or column does not exist yet
 * (errno 1146 or 1054) contributes an empty array instead of failing the block,
 * so a node that has not run a later migration still computes a hash. Any other
 * numeric errno is rethrown, and an error with no numeric errno is swallowed,
 * which is the behaviour the monolithic module had before it was split.
 *
 * RULES FOR CHANGING THIS MODULE. A new class needs a gate in activation.js, a
 * collector in the matching section module, an entry in the composition below and
 * a hash-class declaration in table_lifecycle.js. The copy in the follower must
 * change in the same step, the golden vectors must be regenerated for any active
 * class, and the carrier-logic pin must be re-pinned with a reason.
 *
 * HOW A BLOCK IS VERIFIED. The source indexer computes and stores the hash while
 * it indexes block B. A follower replays the same block, recomputes the hash from
 * its own rows through the identical code and compares the two values, halting on
 * any mismatch. A class that is missing, gated differently or ordered differently
 * on one side therefore shows up as a fleet halt rather than as silent drift,
 * which is why every edit here is a consensus change and not a refactor.
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
