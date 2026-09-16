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
 * XChain Indexer - Database mixin part: attests / validator_stats
 *
 * The attest_validator_stats counter upsert that the fulfilled, missed and slashed
 * accounting runs through.
 * Merged into the attests mixin by db/attests/index.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Increment a counter column on attest_validator_stats. Upserts the
    // (validator_pubkey, provider_id) row on first sight. `field` is whitelisted
    // to the counter columns so callers can't inject arbitrary SQL.
    //
    // Reorg note: the table is append-monotone (counters only), so the standard
    // `DELETE WHERE block_index >= ?` pattern can't roll it back - a row's
    // earlier, surviving increments live alongside the orphaned ones. Rollback
    // therefore recomputes affected pairs from the surviving ledger rather than
    // deleting by index: Rollback.recomputeAttestationValidatorStats() drops the
    // rows last touched in the orphaned range and rebuilds them from surviving
    // signatures (fulfilled) + expired requests (missed), matching a from-genesis
    // replay. This keeps the counters consensus-safe across reorgs so Phase 4
    // slashing can consume them. See src/rollback.js.
    //
    // Spec: external attestation framework §10 (validator stat accounting).
    async incrementAttestationValidatorStat(validatorPubkey, providerId, field, blockIndex){
        const allowed = { fulfilled_count: 1, missed_count: 1, slashed_count: 1 };
        if(!allowed[field]) throw new Error('incrementAttestationValidatorStat: unsupported field ' + field);
        let pk  = String(validatorPubkey || '').toLowerCase();
        let pid = String(providerId || '');
        if(!pk || !pid) return;
        let query = `INSERT INTO attest_validator_stats
                        (validator_pubkey, provider_id, ${field}, last_updated_block)
                     VALUES (?, ?, 1, ?)
                     ON DUPLICATE KEY UPDATE
                        ${field} = ${field} + 1,
                        last_updated_block = VALUES(last_updated_block)`;
        await this.doQuery(query, [pk, pid, blockIndex || 0]);
    },

};
