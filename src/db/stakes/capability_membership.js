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
 * XChain Indexer - Database mixin part: stakes / capability_membership
 *
 * The per-pubkey capability membership test, through its stake-key path and its
 * delegated-key path, agreeing with the effective signer set.
 * Merged into the stakes mixin by db/stakes.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { usesCapabilitySnapshot } = require('../shared.js');

// Stake-key path: per-pubkey aggregate of active, non-revoked stakes.
async function stakeKeyQualifies(db, pubkey_id, valid_id, blockIndex, minStake){
    let query = `SELECT SUM(CAST(s.amount AS DECIMAL(30,8))) AS total
                     FROM stakes s
                     WHERE s.signing_pubkey_id = ?
                       AND s.status_id = ?
                       AND s.activation_block <= ?
                       AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)
                       AND NOT EXISTS (
                           SELECT 1 FROM stake_key_revocations r
                           WHERE r.source_id = s.source_id
                             AND r.signing_pubkey_id = s.signing_pubkey_id
                             AND r.status_id = ?
                             AND r.deactivation_block <= ?
                             AND r.action_index > s.action_index)`;
    let rows = await db.doQuery(query, [pubkey_id, valid_id, blockIndex, blockIndex, valid_id, blockIndex]);
    return rows.length > 0 && rows[0].total !== null && db.util.bcgte(String(rows[0].total), minStake);
}

// Delegated-key path: an active delegation row for this pubkey qualifies
// iff the delegating SOURCE's aggregate active stake meets the threshold.
async function delegatedKeyQualifies(db, pubkey_id, valid_id, blockIndex, minStake){
    let query = `SELECT SUM(CAST(s2.amount AS DECIMAL(30,8))) AS total
                 FROM stakes s2
                 WHERE s2.status_id = ?
                   AND s2.activation_block <= ?
                   AND (s2.deactivation_block IS NULL OR s2.deactivation_block > ?)
                   AND s2.source_id IN (
                       SELECT d.source_id FROM delegations d
                       WHERE d.signing_pubkey_id = ?
                         AND d.status_id = ?
                         AND d.activation_block <= ?
                         AND (d.deactivation_block IS NULL OR d.deactivation_block > ?))`;
    let rows = await db.doQuery(query, [valid_id, blockIndex, blockIndex, pubkey_id, valid_id, blockIndex, blockIndex]);
    return rows.length > 0 && rows[0].total !== null && db.util.bcgte(String(rows[0].total), minStake);
}

module.exports = {

    // Check whether a pubkey's active stake qualifies for a capability.
    // Returns true if SUM(active stake amount for pubkey) >= governance.min_stake[capability].
    async hasCapability(pubkey, capability, blockIndex, minStakeOverride){
        // Off-BTC chains verify the mirrored capabilities against the hub-mirrored capability
        // snapshot (presence = qualified) since capability stakes live only on BTC. Routed
        // through the SAME predicate as the three set/weight/count resolvers, so the
        // truncation fallback in actions/price.js cannot land on a path that answers false
        // for every signer while the capable-set read answered from the mirror.
        if(usesCapabilitySnapshot(this.config, capability))
            return await this.isPubkeyInCapabilitySnapshot(pubkey, capability, blockIndex);
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        let capConfig = caps[capability];
        if(!capConfig) return false;
        // A caller-supplied threshold (the hub's authoritative MIN_STAKE) is
        // honoured VERBATIM (see getValidatorsByCapability). The local floor is
        // only the default when NO override is supplied; it never clamps an
        // explicit caller value, so this per-pubkey membership test agrees with
        // the qualifying set that every other hub/indexer resolves for the block.
        let localFloor = capConfig['MIN_STAKE'] || '0';
        let minStake = (minStakeOverride !== undefined && minStakeOverride !== null)
            ? String(minStakeOverride)
            : localFloor;
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return false;
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return false;
        if(blockIndex === undefined || blockIndex === null)
            blockIndex = await this.getLatestBlockIndex();
        // Permanent disqualification (WI-2 bump 2): an equivocation-slashed key is barred
        // from ALL capabilities - must agree with the effective-set queries
        // (effectiveCapabilitySetSql / _stakeWeightsSql), which exclude it too.
        if(await this.isPubkeySlashedAt(pubkey_id, blockIndex)) return false;
        // Per-pubkey membership test against the SAME effective signer set as
        // getValidatorsByCapability (stake keys minus DELEGATE v2 revocations,
        // plus delegated keys backed by the source's aggregate stake) - the
        // signature-verification paths and the quorum-set paths must agree.
        if(await stakeKeyQualifies(this, pubkey_id, valid_id, blockIndex, minStake))
            return true;
        if(await delegatedKeyQualifies(this, pubkey_id, valid_id, blockIndex, minStake))
            return true;
        return false;
    },

};
