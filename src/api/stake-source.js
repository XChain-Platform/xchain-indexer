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
 * XChain Indexer - stake-source resolution
 *
 * Resolves the staking source address that backs a signing pubkey at a given
 * block. Used by the federation to bind the earn-time source into the ANCHOR
 * archive (the leader writes it, follower hubs re-resolve it before co-signing),
 * so leader and followers MUST derive the same answer. Extracted from the
 * getstakesourcebypubkey RPC handler so this resolution, whose active-row
 * predicates have to agree with effective-set membership, is unit-testable in
 * isolation from the Express/JSON-RPC stack.
 *
 ********************************************************************/

'use strict';

// Resolve the source address backing `pubkey` at `block_index`, or null.
// Returns { source } on success (source may be null), or { error } on bad
// input / unavailable DB, mirroring the RPC's response contract exactly.
async function getStakeSourceByPubkey(indexer, { pubkey, block_index }){
    if(!pubkey || !/^[0-9a-fA-F]{64}$/.test(String(pubkey)))
        return { error: 'pubkey must be 64 hex chars' };
    let blockIdx = Number(block_index);
    if(!Number.isFinite(blockIdx) || blockIdx < 0)
        return { error: 'block_index is required' };
    if(!indexer.indexerDb)
        return { error: 'indexer database not ready' };
    try {
        // Federation READ isolation: resolve through apiView()
        // so every read draws an independent pooled connection and sees only COMMITTED
        // state. This handler backs the getstakesourcebypubkey federation RPC; a call
        // landing mid-block must not join the block's open ACID transaction (sharing the
        // physical connection is a per-block atomicity hazard) and must not resolve a
        // source off stake/delegation rows the block may still roll back.
        let db = indexer.indexerDb.apiView();
        let pubkey_id = await db.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return { source: null };
        let valid_id = await db.getStatusId('valid');
        if(valid_id === null) return { source: null };
        // Both legs mirror the effective-capability-set active-row predicates so resolution
        // agrees with set membership at the same block; the rules themselves, and why the
        // row's own block_index is deliberately not among them, are documented on the two
        // db methods. The stake leg wins; the delegation leg answers only when it finds
        // nothing.
        let rows = await db.getStakeSourceAddressBySigningPubkey(pubkey_id, valid_id, blockIdx);
        if(!rows || rows.length === 0){
            rows = await db.getDelegationSourceAddressBySigningPubkey(pubkey_id, valid_id, blockIdx);
        }
        return { source: (rows && rows.length > 0) ? String(rows[0].source) : null };
    } catch (err) {
        console.error('getstakesourcebypubkey error:', err);
        return { error: 'failed to resolve stake source' };
    }
}

module.exports = { getStakeSourceByPubkey };
