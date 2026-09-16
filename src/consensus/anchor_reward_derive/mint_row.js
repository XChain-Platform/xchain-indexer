/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The last two gates deriveAnchorRewards puts between a mirrored row and a
 * minted reward, after the flag-days and the XANCPUB re-verification: the
 * mined DOGE anchor, re-proved and bound to this exact reward tuple, and the
 * validator_rewards write itself. Every activation read stays in
 * anchor_reward_derive.js, which hands this step the amount the family pays.
 *
 ********************************************************************/

'use strict';

const arKey = require('../../actions/anchor/anchor_reward_key.js');
const { getLogger } = require('../../observability/index.js');

// Thrown when a matured reward cannot be PROVEN either way at this block (no DOGE
// visibility, DOGE unreachable, or the anchor is not yet buried deep enough). The block
// loop catches it, does not advance, and retries the block: deferring is the only outcome
// that keeps every node deriving the identical set at the identical height. Deriving
// without the proof would pay for an anchor that may never have landed; SKIPPING would make
// the reward set depend on one node's network luck and fork the ledger just as badly.
class AnchorProofUnavailableError extends Error {
    constructor(message){ super(message); this.name = 'AnchorProofUnavailableError'; }
}

// Prove one gated, re-verified row's DOGE anchor mined, then mint its reward. `m` carries
// the BTC block being processed (blockIndex), the AnchorProofClient (proof, which may be
// absent), the burial depth (minConfirmations) and the amount the reward family pays
// (amount). Returns what createValidatorReward returned, or false when the proof is
// rejected; throws AnchorProofUnavailableError when it cannot be decided.
async function mintProvenRow(indexerDb, row, m){
    // The mirror says this reward's anchor was mined. Prove it against DOGE
    // ourselves before minting: the mirror is transport, and the hub that wrote the
    // row is exactly the party the reward pays. 'rejected' is chain-determined and
    // fleet-uniform, so it skips this row permanently; 'unknown' is a local
    // visibility failure, so it defers the whole block rather than letting this
    // node's reward set diverge from its peers'.
    let verdict = await (m.proof ? m.proof.proveMined({
        txid:            row.doge_anchor_txid,
        rewardType:      String(row.reward_type),
        roundReference:  Number(row.round_reference),
        snapshotBlock:   Number(row.snapshot_block),
        publisher:       String(row.publisher).toLowerCase(),
        network:         String(row.network),
        minConfirmations: m.minConfirmations
    }) : 'unknown');
    if(verdict === 'unknown')
        throw new AnchorProofUnavailableError(
            'anchor reward ' + row.reward_type + '/' + row.round_reference + ' (publisher ' +
            String(row.publisher).toLowerCase() + ') matured at BTC block ' + m.blockIndex +
            ' but its DOGE anchor ' + (row.doge_anchor_txid || '<none>') + ' could not be proven mined; ' +
            'deferring the block (wire DOGE_INDEXER_URL on this indexer if this persists)');
    if(verdict !== 'verified'){
        getLogger().warn('anchor reward ' + row.reward_type + '/' + row.round_reference + ' publisher ' +
                     String(row.publisher).toLowerCase() + ': DOGE anchor proof REJECTED (' +
                     (row.doge_anchor_txid || '<no txid>') + '); no reward derived');
        return false;
    }
    // block_index = snapshot_block (the earn-block, where the stake source resolves);
    // derive_block_index = the current BTC block, which is where the row is actually
    // minted. Without the second stamp a reorg to any height in (snapshot_block,
    // blockIndex] orphans the minting block yet leaves the reward in place, because the
    // rollback delete only scopes on block_index.
    return indexerDb.createValidatorReward(
        String(row.publisher).toLowerCase(), Number(row.round_reference), String(row.reward_type),
        m.amount, Number(row.snapshot_block), true, Number(m.blockIndex),
        arKey.rewardRoundQualifier(row.reward_type, row.snapshot_block));
}

module.exports = { AnchorProofUnavailableError, mintProvenRow };
