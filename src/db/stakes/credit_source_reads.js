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
 * XChain Indexer - Database mixin part: stakes / credit_source_reads
 *
 * The reads that name who a credit goes to: the staking source behind a signing key
 * (reward archive) and the source and amount of each matured unstake (cooldown release).
 * Merged into the stakes mixin by db/stakes.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // The source address that a signing pubkey resolves to through a STAKE, as of a block.
    // Backs the getstakesourcebypubkey federation RPC, whose delegation fallback lives in
    // db/delegations/index.js.
    //
    // The predicates here mirror the effective-capability-set active-row rules exactly: a key
    // COUNTED in the set at this block (and so earning the reward being archived) must always
    // resolve, or the publisher defers a reward it can never settle and suppresses the whole
    // archive. That means status, activation and deactivation window, stake-key revocation and
    // permanent slash, and deliberately NOT the row's own recording block_index: an extra
    // block_index filter here once left a key counted-but-unresolvable and blocked the publish.
    async getStakeSourceAddressBySigningPubkey(pubkeyId, validId, blockIndex){
        return await this.doQuery(
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
            [pubkeyId, validId, blockIndex, blockIndex, validId, blockIndex, blockIndex]);
    },


    // The credit-bearing fields of a set of matured capability unstakes, in action_index
    // order. The cooldown sweep already knows WHICH unstakes matured; this re-reads the
    // amount and source address it needs to write each release credit under its own
    // action_index trail. The IN-list is sized to the caller's list, the house idiom for a
    // batched read; the list comes from the sweep, never from the wire.
    async getMaturedUnstakeCreditRows(actionIndexes){
        let placeholders = actionIndexes.map(() => '?').join(',');
        return await this.doQuery(
            `SELECT u.action_index, u.amount, a.address AS source_address
                     FROM unstakes u
                         LEFT JOIN index_addresses a ON (a.id = u.source_id)
                     WHERE u.action_index IN (${placeholders})
                     ORDER BY u.action_index ASC`,
            actionIndexes);
    },

    // The contract-stake half of the same sweep. Carries the tick as well, because a
    // contract unstake releases an arbitrary token rather than the gas ticker.
    async getMaturedContractUnstakeCreditRows(actionIndexes){
        let placeholders = actionIndexes.map(() => '?').join(',');
        return await this.doQuery(
            `SELECT cu.action_index, cu.amount, a.address AS source_address, t.tick AS tick
                     FROM contract_unstakes cu
                         LEFT JOIN index_addresses a ON (a.id = cu.source_id)
                         LEFT JOIN index_tickers   t ON (t.id = cu.tick_id)
                     WHERE cu.action_index IN (${placeholders})
                     ORDER BY cu.action_index ASC`,
            actionIndexes);
    },

};
