/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Copy selection for a mirrored anchor reward tuple, from
 * ANCHOR_REWARD_COPY_SELECTION_ACTIVATION.
 *
 * One signed reward tuple (chain, network, reward_type, round_reference, snapshot_block,
 * publisher) can reach a node as several copies that differ in doge_anchor_txid or in
 * publisher_attestations, neither of which the XANCPUB signatures cover. The reward row a
 * tuple mints carries neither field, so the only ledger question is whether the tuple mints
 * at this block. This step answers it from every copy the node holds, whatever order they
 * arrived in: the tuple mints when any copy passes its gates, meets quorum and proves on DOGE,
 * taking the proven copy with the lowest txid; when none proves and any copy is still
 * undecided the block defers; otherwise the tuple pays nothing. A rejected copy never rejects
 * the tuple while another copy is undecided.
 *
 ********************************************************************/

'use strict';

const { copyDigest } = require('../../hub/hub_db_sync/apply/attestation_copies.js');
const { AnchorProofUnavailableError, proveRow, mintRow } = require('./mint_row.js');
const { getLogger } = require('../../observability/index.js');

// The tuple a copy belongs to: uq_reward_tuple's six columns.
function tupleKey(row){
    return [row.chain, row.network, row.reward_type, row.round_reference, row.snapshot_block,
            String(row.publisher).toLowerCase()].join('|');
}

// The distinct copies of each tuple in `rows`, in first-seen tuple order, each tuple's copies
// deduped by digest and sorted by txid (absent first) then digest, so every node walks the
// same copies in the same order.
function copiesByTuple(rows){
    let tuples = new Map();
    for(let row of rows){
        let key = tupleKey(row);
        if(!tuples.has(key)) tuples.set(key, new Map());
        let digest = copyDigest(row);
        if(!tuples.get(key).has(digest)) tuples.get(key).set(digest, Object.assign({}, row, { copy_digest: digest }));
    }
    let out = [];
    for(let copies of tuples.values()){
        out.push([...copies.values()].sort((a, b) => {
            let ta = a.doge_anchor_txid == null ? '' : String(a.doge_anchor_txid).toLowerCase();
            let tb = b.doge_anchor_txid == null ? '' : String(b.doge_anchor_txid).toLowerCase();
            if(ta !== tb) return ta < tb ? -1 : 1;
            return a.copy_digest < b.copy_digest ? -1 : (a.copy_digest > b.copy_digest ? 1 : 0);
        }));
    }
    return out;
}

// Mint one tuple from its sorted copies. `c` carries the checks the derive pass applies to a
// row (gatesActive, verifyAttestation), the db handle and the mint context mintProvenRow takes,
// including the block's protocolChanges registry for the legacy reward pin verdict.
// Returns the minted copy, or null when the tuple pays nothing; throws
// AnchorProofUnavailableError when no copy proves and one is still undecided.
async function mintTuple(copies, c){
    let undecided = null;
    for(let row of copies){
        if(!c.gatesActive(row)) continue;
        if(!await c.verifyAttestation(c.indexerDb, row)) continue;
        let verdict = await proveRow(row, c.mint);
        if(verdict === 'verified'){
            await mintRow(c.indexerDb, row, c.mint);
            return row;
        }
        if(verdict === 'unknown' && undecided === null) undecided = row;
    }
    if(undecided !== null)
        throw new AnchorProofUnavailableError(
            'anchor reward ' + undecided.reward_type + '/' + undecided.round_reference + ' (publisher ' +
            String(undecided.publisher).toLowerCase() + ') matured at BTC block ' + c.mint.blockIndex +
            ' but no copy of it proved and the DOGE anchor ' + (undecided.doge_anchor_txid || '<none>') +
            ' could not be proven either way; deferring the block (wire DOGE_INDEXER_URL on this indexer if this persists)');
    if(copies.length > 0)
        getLogger().warn('anchor reward ' + copies[0].reward_type + '/' + copies[0].round_reference + ' publisher ' +
                     String(copies[0].publisher).toLowerCase() + ': no copy of ' + copies.length +
                     ' met quorum and proved on DOGE; no reward derived');
    return null;
}

module.exports = { tupleKey, copiesByTuple, mintTuple };
