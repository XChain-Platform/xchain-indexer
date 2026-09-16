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
 * XChain Indexer - JSON-RPC system family: ping, health, the latest block and the block-hash triple.
 *
 * Each group factory below closes over the context object src/api.js builds
 * (apiContext) and returns its methods verbatim; src/api/rpc/index.js merges
 * every family into the one controller the JSON-RPC router dispatches on.
 *
 ********************************************************************/

const { buildHealthResponse, committedView, inFlightBlockIndex } = require('../health');
const { chainBlockHash } = require('../chain_block_hash');           // decoder-side hash for the block-hash triple
const merkle        = require('../../consensus/merkle');
const stateSubtree  = require('../../state_subtree_activation');
const { getLogger } = require('../../observability/index.js');

function buildSystemRpc(ctx){
    return Object.assign({}, systemReads(ctx), latestBlockRpc(ctx), blockHashesRpc(ctx));
}

function systemReads({ indexer, liveness }){
    return {
        // Handle returning a success response to ping requests
        async ping(){
            return { status: "success" };
        },

        // Health check that reports actual indexer state. ping only confirms the
        // HTTP server is up; this surfaces sync progress plus the circuit-breaker
        // state of BOTH database connections so an operator can tell a healthy,
        // syncing indexer apart from one silently stalled at an open circuit after
        // a database outage (the breaker trips after repeated connection failures).
        async health(){
            let lastIndexedBlock = null;
            // Snapshot the in-flight block BEFORE the awaited read: it is a
            // synchronous peek at block-loop state, so taking it first means a
            // block committing mid-handler can only ever collapse the pair
            // toward the truth, never invent an in-flight block.
            let inFlightBlock = inFlightBlockIndex(indexer.indexerDb);
            try {
                if(indexer.indexerDb)
                    // Committed-only read. A bare getLatestBlockIndex() here
                    // routes through getConnection() -> the block's OPEN transaction,
                    // so health advertised a height every federation query guard (which
                    // all read via apiView) rejects, and that a reorg may never commit.
                    lastIndexedBlock = await committedView(indexer.indexerDb).getLatestBlockIndex();
            } catch (err) {
                // Database unreachable; leave lastIndexedBlock null. The circuit
                // state below tells the operator why.
            }
            // The block committed while we were reading, so it is no longer in flight.
            if(inFlightBlock != null && lastIndexedBlock != null && inFlightBlock <= lastIndexedBlock)
                inFlightBlock = null;
            let reorgStats = null;
            try {
                if(indexer.indexerDb)
                    // Same committed-only view: reorg counters written by an in-flight
                    // block roll back with it, so a dirty read here over-counts.
                    reorgStats = await committedView(indexer.indexerDb).getReorgHealthStats();
            } catch (err) {
                // DB unreachable; leave reorg counters null (getReorgHealthStats is
                // already non-throwing, this is belt-and-braces).
            }
            // Read at call time: a fatal loop error and the shutdown drain flip both after boot.
            let { indexerRunning, indexerError } = liveness;
            return buildHealthResponse({
                indexer, indexerRunning, indexerError, lastIndexedBlock, inFlightBlock,
                now: Date.now(), reorgStats
            });
        },
    };
}

// Latest parsed block index. Used by xchain-hub's Consensus to
// anchor its snapshot at a deterministic block boundary when the
// hub's own chain-tip table is empty (no HUB_API_URL on the
// indexer = no pushChainTip = no chain_tips rows).
// Also exposes the decoder's current tip and a sync-status flag so
// operators can see the indexer→decoder lag in a single call.
function latestBlockRpc({ indexer }){
    return {
        async getlatestblock(){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            try {
                // Committed-only, like health and every federation query
                // guard. The hub anchors its consensus snapshot at whatever height
                // this returns; an in-flight height would anchor a snapshot on rows
                // no other reader can see and a reorg may still erase.
                let inFlight    = inFlightBlockIndex(indexer.indexerDb);
                let block_index = await committedView(indexer.indexerDb).getLatestBlockIndex();
                if(inFlight != null && inFlight <= block_index) inFlight = null;
                return {
                    block_index,
                    in_flight_block: inFlight,
                    decoder_block: indexer.lastDecoderBlock,
                    lag: indexer.lastDecoderBlock != null
                        ? indexer.lastDecoderBlock - block_index
                        : null,
                };
            } catch (err) {
                getLogger().error('getlatestblock error:', err);
                return { error: 'failed to look up latest block' };
            }
        },
    };
}

// The stored per-block state-hash triple (+ the chain block hash from the
// decoder DB) for a height; what the hub's StateCheckpointEngine reads,
// independently re-fetches on every peer, and quorum-signs into the
// XCHECKPOINT canonical (spec: protocol/actions/ANCHOR.md). Omitting
// block_index returns the latest indexed block. Public read: these hashes
// are the platform's verifiability primitive, not sensitive state.
//
// COMMITTED-ONLY read, the signing-path sibling of the health read in this file. A bare
// read routes through db.getConnection(), which hands back the block loop's
// open transactionConnection while a block is processing, so both the default
// target height and the hash row itself would come from INSIDE the uncommitted
// block. That is worse here than on health: the hub's StateCheckpointEngine
// quorum-SIGNS this response into the XCHECKPOINT canonical, so a mid-block
// read means the validator set signs a state hash for a block a reorg (or a
// guard throwing before commit) may still erase, and the signature outlives
// the rollback. committedView() draws the independent pooled connection every
// federation query guard uses, so the worst case is "block not indexed: N"
// (the caller retries) instead of a signed hash for a block that never was.
//
// The decoder DB carries no indexer-owned transaction today, but the
// chain block hash is signed alongside the triple, so it reads through
// the same committed-only view rather than depending on that staying true.
function blockHashesRpc({ indexer }){
    return {
        async getblockhashes({block_index}){
            if(!indexer.indexerDb || !indexer.decoderDb)
                return { error: 'indexer database not ready' };
            try {
                let db        = committedView(indexer.indexerDb);
                let decoderDb = committedView(indexer.decoderDb);
                let target = (block_index !== undefined && block_index !== null)
                    ? Number(block_index)
                    : await db.getLatestBlockIndex();
                if(!Number.isFinite(target) || target < 0)
                    return { error: 'invalid block_index' };
                let stored = await db.getStoredBlockHashes(target);
                if(!stored)
                    return { error: 'block not indexed: ' + target };
                let blockHash = await chainBlockHash(decoderDb, target);
                return {
                    coin:          indexer.config['COIN'],
                    network:       indexer.config['NETWORK'],
                    block_index:   Number(stored.block_index),
                    block_time:    (stored.block_time != null) ? Number(stored.block_time) : null,
                    block_hash:    blockHash,
                    ledger_hash:   stored.ledger_hash   || null,
                    actions_hash:  stored.actions_hash  || null,
                    contract_hash: stored.contract_hash || null,
                    // Additive light-client roots: null before the
                    // STATE_COMMITMENT flag-day, present after. The hub's checkpoint
                    // engine signs over state_root + block_merkle_root. The version
                    // bytes travel WITH their root (the scheme version under which
                    // the stored root was computed) so the hub signs root+version as
                    // a unit; null whenever the root is null.
                    //
                    // state_root_version is DERIVED AT THE ROW'S OWN HEIGHT, not read
                    // off the static merkle constant and NOT derived at the chain tip.
                    // This response is the only place the version is minted: the hub's
                    // checkpoint engine copies it verbatim into the signed canonical
                    // and from there into the anchor row, so a wrong value here is
                    // signed by the validator set rather than merely displayed. Tip
                    // derivation is the specific trap: it passes any "no static
                    // constant" check while relabelling every below-boundary
                    // checkpoint as version 2 once a slot arms, which is a lie about
                    // what those blocks committed.
                    balances_root:        stored.balances_root     || null,
                    stakes_root:          stored.stakes_root       || null,
                    state_root:           stored.state_root        || null,
                    state_root_version:   stored.state_root
                        ? stateSubtree.stateRootVersion(Number(stored.block_index),
                                                        indexer.config['NETWORK'], indexer.config['COIN'])
                        : null,
                    block_merkle_root:    stored.block_merkle_root || null,
                    block_merkle_version: stored.block_merkle_root ? merkle.BLOCK_MERKLE_VERSION : null
                };
            } catch (err) {
                getLogger().error('getblockhashes error:', err);
                return { error: 'failed to look up block hashes' };
            }
        },
    };
}

module.exports = { buildSystemRpc };
