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
 * XChain Platform - the escrow cross-check: which axis a checkpoint is matched on.
 *
 * A bridge_transfers row's snapshot_block is the hub's BTC anchor height (xchain-hub
 * src/cross_chain/bridge/transfer_poll.js stamps the hub's BTC tip, or for a BTC leg the
 * first BTC checkpoint covering it). A checkpoint carries two heights: block_index on its
 * own chain, and snapshot_block, the BTC height its round was led at (its checkpoint_seq
 * derives from that same number). For a BTC origin both are BTC heights and the original
 * rule, first block_index at or after the row's snapshot_block, is kept exactly. For a DOGE
 * or LTC origin that rule compares a BTC height to a DOGE or LTC height: it always selects
 * the oldest checkpoint held, which predates the lock, so every such mint was refused
 * (xchain-indexer issue 62). From BRIDGE_ESCROW_ANCHOR_MATCH_ACTIVATION those origins are
 * matched anchor to anchor instead: the first checkpoint whose snapshot_block is STRICTLY
 * above the row's, and the staleness binding refuses any checkpoint whose snapshot_block is
 * not.
 *
 * WHY THE PICK COMMITS THE LOCK. Both hub engines read the same BTC tip. The checkpoint
 * engine leads a round at the first tick of a due BTC block and commits its origin tip
 * less CHECKPOINT_CONFIRMATIONS (6, xchain-hub src/anchor/checkpoint_engine/options.js).
 * The bridge engine stamps a lock only once it is at the bridge depth (DOGE 60, LTC 12),
 * at any moment inside a BTC block. A checkpoint at a BTC height strictly above the stamp
 * was therefore led after the stamp, when the origin tip was at or above the lock plus
 * depth less one, so it commits block_index >= lock + depth - 1 - 6: 53 DOGE blocks or
 * 5 LTC blocks to spare. "At or above" would admit the round led at the start of the
 * stamp's own BTC block, before the stamp, and one BTC block routinely outlasts 5 LTC
 * blocks. The spare blocks are also what absorbs origin-tip skew between the two hubs'
 * indexers.
 *
 * RESIDUAL, STATED. A finalizing leader whose BTC view lags (peers admit a stamp within 144
 * blocks of their own tip) can stamp low enough that the selected checkpoint predates its
 * lock. The verdict is then a refusal on every block, never a mint without escrow: the
 * proven balance still has to cover the amount.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../gate_registry');

const ANCHOR_MATCH_KEY = 'bridge_escrow_anchor_match_activation.BRIDGE_ESCROW_ANCHOR_MATCH_ACTIVATION';

/**
 * Whether this transfer's origin checkpoint is selected and bound on the BTC anchor axis
 * (snapshot_block) rather than on the origin chain's block_index. Read at the settling
 * chain's own block, so every node applying the same block answers the same.
 *
 * @param {string} originChain - the transfer's origin (escrow) chain
 * @param {Object} ctx - the settle-pass context { coin, network, blockIndex }
 * @returns {boolean}
 */
function anchorMatched(originChain, ctx){
    if(String(originChain || '') === 'BTC') return false;
    if(!ctx || typeof ctx !== 'object') return false;
    return gateRegistry.activeAt(ANCHOR_MATCH_KEY, ctx.network, ctx.coin, ctx.blockIndex, null);
}

module.exports = { ANCHOR_MATCH_KEY, anchorMatched };
