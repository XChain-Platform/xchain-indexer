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
        let db = indexer.indexerDb;
        let pubkey_id = await db.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return { source: null };
        let valid_id = await db.getStatusId('valid');
        if(valid_id === null) return { source: null };
        // Both legs mirror _effectiveCapabilitySetSql's active-row predicates so
        // resolution agrees with effective-set membership at the same block: a key
        // COUNTED in the set (and thus earning the reward being archived) must
        // always resolve, otherwise the publisher defers a reward it can never
        // settle and suppresses the whole archive. Membership gates on status +
        // activation/deactivation + stake-key revocation + permanent slash, and
        // deliberately NOT on the row's recording block_index. This must match: an
        // earlier `block_index <= ?` filter here (absent from membership) left a
        // delegated key counted-but-unresolvable, deferring its anchor reward and
        // blocking the publish. The permanent-slash exclusion (WI-2) is part of the
        // active-row set, so it is applied here too.
        let rows = await db.doQuery(
            `SELECT ia.address AS source FROM stakes s
             JOIN index_addresses ia ON ia.id = s.source_id
             WHERE s.signing_pubkey_id = ? AND s.status_id = ?
               AND s.activation_block <= ?
               AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)
               AND NOT EXISTS (
                   SELECT 1 FROM stake_key_revocations r
                   WHERE r.source_id = s.source_id
                     AND r.signing_pubkey_id = s.signing_pubkey_id
                     AND r.status_id = ?
                     AND r.deactivation_block <= ?
                     AND r.action_index > s.action_index)
               AND NOT EXISTS (
                   SELECT 1 FROM capability_slash_events cse
                   WHERE cse.signing_pubkey_id = s.signing_pubkey_id
                     AND cse.block_index <= ?)
             ORDER BY s.action_index DESC LIMIT 1`,
            [pubkey_id, valid_id, blockIdx, blockIdx, valid_id, blockIdx, blockIdx]);
        if(!rows || rows.length === 0){
            rows = await db.doQuery(
                `SELECT ia.address AS source FROM delegations d
                 JOIN index_addresses ia ON ia.id = d.source_id
                 WHERE d.signing_pubkey_id = ? AND d.status_id = ?
                   AND d.activation_block <= ?
                   AND (d.deactivation_block IS NULL OR d.deactivation_block > ?)
                   AND NOT EXISTS (
                       SELECT 1 FROM capability_slash_events cse
                       WHERE cse.signing_pubkey_id = d.signing_pubkey_id
                         AND cse.block_index <= ?)
                 ORDER BY d.action_index DESC LIMIT 1`,
                [pubkey_id, valid_id, blockIdx, blockIdx, blockIdx]);
        }
        return { source: (rows && rows.length > 0) ? String(rows[0].source) : null };
    } catch (err) {
        console.error('getstakesourcebypubkey error:', err);
        return { error: 'failed to resolve stake source' };
    }
}

module.exports = { getStakeSourceByPubkey };
