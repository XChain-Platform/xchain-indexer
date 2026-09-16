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
 * XChain Indexer - Database statements: rollback attestation validator stats recompute
 *
 * The reads, the delete and the write the stats recompute runs, called from
 * src/rollback/attestation_stats.js inside the rollback transaction. The
 * expired-request read is compared predicate for predicate with
 * scripts/repair-validator-stats.js by that script's drift guard.
 *
 ********************************************************************/

'use strict';

module.exports = {

    // Pairs last touched at or after the reorg block.
    async readTouchedStatPairs(db, block_index){
        let pairRows = await db.doQuery(
            `SELECT validator_pubkey, provider_id
             FROM attest_validator_stats
             WHERE last_updated_block >= ?`,
            [block_index]
        );
        return pairRows;
    },

    // The stale rows of those pairs.
    async deleteTouchedStats(db, block_index){
        await db.doQuery(
            `DELETE FROM attest_validator_stats WHERE last_updated_block >= ?`,
            [block_index]
        );
    },

    // Surviving STATUS=ok v1 responses carrying signatures, for the affected providers.
    async readOkResponses(db, affectedProviders, providerPlaceholders){
        let okResponses = await db.doQuery(
            `SELECT provider_id, validator_signatures, block_index
             FROM attests
             WHERE version = 1 AND response_status = 'ok' AND validator_signatures IS NOT NULL
               AND provider_id IN (` + providerPlaceholders + `)`,
            affectedProviders
        );
        return okResponses;
    },

    // Surviving v0 requests that would have expired in a replay to block_index-1.
    async readExpiredRequests(db, block_index, affectedProviders, providerPlaceholders){
        let validId = await db.getStatusId('valid');
        let expiredReqs = await db.doQuery(
            `SELECT ar.request_id, ar.provider_id, ar.redundancy, ar.block_index, ar.deadline_block, ar.responsible_set_json
             FROM attests ar
             WHERE ar.version = 0
               AND ar.deadline_block < ?
               AND ar.provider_id IN (${providerPlaceholders})
               AND ar.request_status <> 'rejected'
               AND NOT EXISTS (
                   SELECT 1 FROM attests r
                   WHERE r.version = 1
                     AND r.request_id = ar.request_id
                     AND r.status_id = ?
                     AND r.response_status IN ('ok', 'expired')
               )`,
            [block_index - 1, ...affectedProviders, validId]
        );
        return expiredReqs;
    },

    // One recomputed pair, upserted.
    async writeRecomputedStat(db, s){
            await db.doQuery(
                `INSERT INTO attest_validator_stats
                    (validator_pubkey, provider_id, fulfilled_count, missed_count, slashed_count, quality_score, last_updated_block)
                 VALUES (?, ?, ?, ?, 0, 0, ?)
                 ON DUPLICATE KEY UPDATE
                    fulfilled_count    = VALUES(fulfilled_count),
                    missed_count       = VALUES(missed_count),
                    slashed_count      = VALUES(slashed_count),
                    last_updated_block = VALUES(last_updated_block)`,
                [s.pubkey, s.provider, s.fulfilled, s.missed, s.lastBlock]
            );
    },

};
