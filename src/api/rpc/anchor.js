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
 * XChain Indexer - JSON-RPC anchor family: checkpoint anchors, DOGE anchor depth and archive anchors.
 *
 * Each group factory below closes over the context object src/api.js builds
 * (apiContext) and returns its methods verbatim; src/api/rpc/index.js merges
 * every family into the one controller the JSON-RPC router dispatches on.
 *
 ********************************************************************/

const anchorActionQuery = require('../../actions/anchor/anchor_action_query');
const { getLogger } = require('../../observability/index.js');

function buildAnchorRpc(ctx){
    return Object.assign({}, anchorActionRpc(ctx), anchorConfirmationsRpc(ctx), archiveAnchorRpc(ctx));
}

// Look up the on-chain ANCHOR checkpoint record (from anchor_actions, the
// permanent full-parse record) for a checkpoint identity, with its DOGE
// confirmation depth. Serves the hub's anchor-gossip verification: before a
// hub trusts an XANC_V0_DONE / XANC_FINALIZED (which stamps anchor_txid and
// mirrors a reward), it confirms via THIS method that a matching anchor
// actually landed on-chain (payload hashes match, status is not 'invalid',
// confirmations >= XCHAIN_CONFIRMATIONS_DOGE), independently of the announced
// txid, defeating a phantom txid and a Byzantine ELECTED publisher alike.
// `chain`/`network` are the CHECKPOINTED chain (e.g. BTC/regtest); this
// indexer serves the anchor chain (DOGE), so confirmations are DOGE-relative.
// Optional `txid` / `version` narrow the lookup to a SPECIFIC anchor
// transaction rather than "the newest anchor for this checkpoint". Without
// them the answer is only "this checkpoint is anchored at depth", which a
// Byzantine ELECTED publisher can satisfy while announcing a never-mined or
// real-but-different txid. `checkpoint_anchored` is
// returned alongside `exists` so a filtering caller can distinguish a benign
// not-yet-anchored checkpoint from a positively-detected txid forge.
//
// The candidate rows are read with doQuery + the SQL owned by
// anchor_action_query.js rather than a db.js accessor, keeping this read
// surface isolated (db.js is under concurrent edit). db.js's single-row
// getAnchorActionByCheckpoint is superseded by this path and should be
// folded back here once db.js is free.
function anchorActionRpc({ indexer }){
    return {
        async getanchoraction({chain, network, block_index, checkpoint_seq, txid, version}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let v = anchorActionQuery.validateAnchorActionParams({ chain, network, block_index, checkpoint_seq, txid, version });
            if(!v.ok) return { error: v.error };
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let rows   = await db.doQuery(anchorActionQuery.ANCHOR_ACTIONS_SQL,
                    [chain, network, v.block_index, v.checkpoint_seq, ...anchorActionQuery.CHECKPOINT_VERSIONS]);
                let row    = anchorActionQuery.selectAnchorRow(rows, { txid: v.txid, version: v.version });
                return anchorActionQuery.buildAnchorActionResponse(indexer.config, latest, row,
                    { checkpoint_anchored: Array.isArray(rows) && rows.length > 0 });
            } catch (err) {
                getLogger().error('getanchoraction error:', err);
                return { error: 'failed to look up anchor action' };
            }
        },
    };
}

// DOGE anchor visibility for the BTC indexer: "what did this DOGE transaction
// anchor, and how deep is it?" Keyed on the txid alone, because that is the only
// DOGE-side identity a mirrored anchor_reward_attestations row carries
// (doge_anchor_txid). The BTC indexer calls this before it mints the
// COLLECT-spendable anchor/archive reward and does the binding itself: it matches
// the returned publisher / snapshot_block / seq against the reward tuple it is
// about to pay, so a txid that anchored something else is positively rejected
// rather than weakly accepted. See anchor_proof_client.js and
// anchor_reward_derive.js on the calling side.
// `after_action_index` is the optional exclusive page cursor a caller echoes back
// from a previous response's next_after_action_index. Omitting it reads the first
// page, which is what every pre-pagination caller does, so the method stays
// backward compatible on the wire.
function anchorConfirmationsRpc({ indexer }){
    return {
        async getanchorconfirmations({txid, after_action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let v = anchorActionQuery.validateAnchorConfirmationsParams({ txid, after_action_index });
            if(!v.ok) return { error: v.error };
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let rows   = (v.after === null)
                           ? await db.doQuery(anchorActionQuery.ANCHOR_BY_TXID_SQL,       [v.txid])
                           : await db.doQuery(anchorActionQuery.ANCHOR_BY_TXID_AFTER_SQL, [v.txid, v.after]);
                return anchorActionQuery.buildAnchorConfirmationsResponse(indexer.config, latest, rows);
            } catch (err) {
                getLogger().error('getanchorconfirmations error:', err);
                return { error: 'failed to look up anchor confirmations' };
            }
        },
    };
}

// Content-addressed archive-anchor existence: "is this exact archive batch
// already on-chain, published by this address?" - answered WITHOUT the
// match_batch_seq.
//
// Serves the crash-safety guard on the hub's archive publish path. That path
// broadcasts the v1 head and its v2 continuation chunks BEFORE it records the
// batch locally, so a crash in between re-elects the same match rows on the next
// flush under a FRESH batch seq and re-spends DOGE on a duplicate archive. Every
// other archive read is keyed on that seq and therefore cannot see the earlier
// publish; this one is keyed on the batch's content commitment (checkpoint
// identity + batch_crc32 + match_count), which the publisher signs into the v1
// canonical and can recompute after the restart.
//
// `chain`/`network` are the CHECKPOINTED chain (e.g. BTC/regtest); this indexer
// serves the anchor chain (DOGE), so confirmations are DOGE-relative. Any depth
// counts to the caller: a 1-conf archive already spent the fee.
//
// `author` scopes the answer to one publishing address (the hub passes its own
// DOGE address). Unscoped, a third party who copied our mined head onto the
// chain would answer "already published" for a batch whose chunks it never sent,
// and the publisher would skip its own head and strand the archive.
//
// `chunks_present` / `chunks_complete` + the head's own `match_batch_seq` let a
// resuming publisher re-send only the chunks that are actually missing, in the
// slots of the batch its previous process allocated.
function archiveAnchorRpc({ indexer }){
    return {
        async getarchiveanchor({chain, network, block_index, checkpoint_seq, batch_crc32, match_count, author}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let v = anchorActionQuery.validateArchiveAnchorParams(
                { chain, network, block_index, checkpoint_seq, batch_crc32, match_count, author });
            if(!v.ok) return { error: v.error };
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let found  = await db.getArchiveAnchorByContent(chain, network, v.block_index,
                    v.checkpoint_seq, v.batch_crc32, v.match_count, v.author);
                return anchorActionQuery.buildArchiveAnchorResponse(
                    indexer.config, latest, found.head, found.chunks);
            } catch (err) {
                getLogger().error('getarchiveanchor error:', err);
                return { error: 'failed to look up archive anchor' };
            }
        },
    };
}

module.exports = { buildAnchorRpc };
