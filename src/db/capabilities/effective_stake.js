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
 * XChain Indexer - Database mixin part: capabilities / effective_stake
 *
 * The read-only effective-set view of one pubkey's stake (federation self-qualification),
 * through its direct-stake path and its delegated-key path.
 * Merged into the capabilities mixin by db/capabilities/index.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Effective-set / capability view of a pubkey's stake, mirroring effectiveCapabilitySetSql.
    // Returns { source_id, signing_pubkey_id, signing_pubkey, amount, activation_block, ... } or null.
    //
    // READ-ONLY (federation self-qualification). Used by the getownstake RPC so a hub whose only
    // stake authority comes via DELEGATE still sees itself as qualified, matching the federation's
    // view. NOT a consensus block-processing primitive: do NOT call this from STAKE/UNSTAKE/DELEGATE
    // handlers (use getActiveStakeByPubkey for stake-ownership there).
    //   Path 1: direct stake key, excluding DELEGATE v2 revocations active at blk.
    //   Path 2: delegated-only key, resolving to the delegating source's aggregate active stake.
    async getEffectiveStakeByPubkey(pubkey, blockIndex){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null)
            return null;
        let valid_id = await this.getStatusId('valid');
        let blk = (blockIndex !== undefined && blockIndex !== null) ? blockIndex : null;

        let direct = await stakePaths.directStake(this, pubkey_id, valid_id, blk);
        if(direct !== null)
            return direct;
        return await stakePaths.delegatedStake(this, pubkey_id, valid_id, blk);
    },

};

// The two resolution paths of getEffectiveStakeByPubkey, kept off the exported object so
// Database.prototype gains no method. Each returns the stake shape, or null to fall through.
const stakePaths = {

    async directStake(db, pubkey_id, valid_id, blk){
        // Path 1: direct stake key, excluding any revocations active at blk.
        // Mirrors the stake-key branch of hasCapability (stake_key_revocations NOT-EXISTS).
        let q1 = `SELECT
                        MIN(s.source_id)                       AS source_id,
                        s.signing_pubkey_id                    AS signing_pubkey_id,
                        SUM(CAST(s.amount AS DECIMAL(30,8)))   AS amount,
                        MIN(s.activation_block)                AS activation_block,
                        MIN(s.block_index)                     AS block_index,
                        MIN(s.status_id)                       AS status_id,
                        ip.pubkey                              AS signing_pubkey
                     FROM stakes s
                         LEFT JOIN index_pubkeys ip ON (ip.id = s.signing_pubkey_id)
                     WHERE s.signing_pubkey_id=? AND s.status_id=?
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
                             AND cse.block_index <= ?)`;
        let a1 = [pubkey_id, valid_id, valid_id, blk !== null ? blk : 0, blk !== null ? blk : 0];
        if(blk !== null){
            q1 += ' AND s.activation_block <= ? AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)';
            a1.push(blk, blk);
        }
        q1 += ' GROUP BY s.signing_pubkey_id, ip.pubkey LIMIT 1';
        let results = await db.doQuery(q1, a1);
        if(results.length > 0){
            let row = results[0];
            return {
                source_id:         row.source_id,
                signing_pubkey_id: row.signing_pubkey_id,
                signing_pubkey:    row.signing_pubkey,
                amount:            (row.amount === null || row.amount === undefined) ? '0' : String(row.amount),
                activation_block:  row.activation_block,
                block_index:       row.block_index,
                status_id:         row.status_id
            };
        }
        return null;
    },

    async delegatedStake(db, pubkey_id, valid_id, blk){
        // Path 2: delegated key. If this pubkey has an active delegation row, return the
        // delegating source's aggregate active stake (mirrors the delegated-key branch of
        // hasCapability). The returned amount is the source's total so the hub self-qualifies
        // when delegation-only; source_id/activation_block are from the delegation row.
        let q2 = `SELECT d.source_id AS source_id,
                         d.signing_pubkey_id AS signing_pubkey_id,
                         ip.pubkey AS signing_pubkey,
                         d.activation_block AS activation_block,
                         d.block_index AS block_index,
                         d.status_id AS status_id,
                         SUM(CAST(s2.amount AS DECIMAL(30,8))) AS amount
                  FROM delegations d
                  JOIN stakes s2 ON s2.source_id = d.source_id
                  LEFT JOIN index_pubkeys ip ON ip.id = d.signing_pubkey_id
                  WHERE d.signing_pubkey_id = ?
                    AND d.status_id = ?
                    AND s2.status_id = ?
                    AND NOT EXISTS (
                        SELECT 1 FROM capability_slash_events cse
                        WHERE cse.signing_pubkey_id = d.signing_pubkey_id
                          AND cse.block_index <= ?)`;
        let a2 = [pubkey_id, valid_id, valid_id, blk !== null ? blk : 0];
        if(blk !== null){
            q2 += ' AND d.activation_block <= ? AND (d.deactivation_block IS NULL OR d.deactivation_block > ?)';
            q2 += ' AND s2.activation_block <= ? AND (s2.deactivation_block IS NULL OR s2.deactivation_block > ?)';
            a2.push(blk, blk, blk, blk);
        }
        q2 += ' GROUP BY d.source_id, d.signing_pubkey_id LIMIT 1';
        let drows = await db.doQuery(q2, a2);
        if(drows.length > 0 && drows[0].amount !== null){
            let row = drows[0];
            return {
                source_id:         row.source_id,
                signing_pubkey_id: row.signing_pubkey_id,
                signing_pubkey:    row.signing_pubkey,
                amount:            String(row.amount),
                activation_block:  row.activation_block,
                block_index:       row.block_index,
                status_id:         row.status_id
            };
        }

        return null;
    },

};
