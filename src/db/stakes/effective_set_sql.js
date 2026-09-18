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
 * XChain Indexer - Database mixin part: stakes / effective_set_sql
 *
 * The consensus-critical SQL builders every quorum read resolves through: the effective
 * signer set, the source-keyed stake weights, and the SWQ source-cap window over them.
 * Merged into the stakes mixin by db/stakes.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const stakeWeightCollation = require('../../consensus/gates/stake_weight_collation_gate');

module.exports = {

    // Effective signer set for a capability at a block (DELEGATE semantics,
    // additive-until-revoked). A source's effective keys are:
    //   stake keys     - per-pubkey aggregate active stake >= MIN_STAKE, EXCLUDING
    //                    keys revoked via DELEGATE v2 (stake_key_revocations). A
    //                    revocation only applies to stake rows that predate it
    //                    (r.action_index > s.action_index), so re-staking the same
    //                    key later restores it.
    //   delegated keys - active `delegations` rows whose SOURCE's aggregate active
    //                    stake >= MIN_STAKE. Delegated keys are backed by the
    //                    source's whole stake; they add signers, they never change
    //                    staked amounts (spec: DELEGATE.md).
    // Every PBFT-quorum read (capability snapshots, signature verification, quorum
    // counts) MUST resolve through this one query so all consumers agree -
    // CONSENSUS-CRITICAL: any change here forks validation.
    effectiveCapabilitySetSql(valid_id, blockIndex, minStake){
        // Permanent disqualification (WI-2 bump 2): a signing key proven to have
        // equivocated is PERMANENTLY barred from the effective signer set - not just
        // until its current bond burns to 0, but against any future re-stake/re-delegation
        // of the same key. The exclusion is GLOBAL (any capability the key was slashed in
        // bars it everywhere - an equivocating key has proven byzantine) and block-gated
        // (`cse.block_index <= ?`) so re-deriving a historical block before the slash is
        // byte-identical, and reorg-safe (the slash event rolls back ⇒ eligibility returns).
        // Applied identically in stakeWeightsSql and hasCapability so every quorum read agrees.
        const slashExcl = (keyCol) =>
            `AND NOT EXISTS (SELECT 1 FROM capability_slash_events cse
                             WHERE cse.signing_pubkey_id = ${keyCol} AND cse.block_index <= ?)`;
        let sql = `SELECT ip.pubkey AS pubkey,
                          SUM(CAST(s.amount AS DECIMAL(30,8))) AS total
                   FROM stakes s
                   JOIN index_pubkeys ip ON ip.id = s.signing_pubkey_id
                   WHERE s.status_id = ?
                     AND s.activation_block <= ?
                     AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)
                     AND NOT EXISTS (
                         SELECT 1 FROM stake_key_revocations r
                         WHERE r.source_id = s.source_id
                           AND r.signing_pubkey_id = s.signing_pubkey_id
                           AND r.status_id = ?
                           AND r.deactivation_block <= ?
                           AND r.action_index > s.action_index)
                     ${slashExcl('s.signing_pubkey_id')}
                   GROUP BY ip.pubkey
                   HAVING total >= CAST(? AS DECIMAL(30,8))
                   UNION ALL
                   SELECT ip2.pubkey AS pubkey, src.total AS total
                   FROM delegations d
                   JOIN index_pubkeys ip2 ON ip2.id = d.signing_pubkey_id
                   JOIN (
                       SELECT s2.source_id AS source_id,
                              SUM(CAST(s2.amount AS DECIMAL(30,8))) AS total
                       FROM stakes s2
                       WHERE s2.status_id = ?
                         AND s2.activation_block <= ?
                         AND (s2.deactivation_block IS NULL OR s2.deactivation_block > ?)
                       GROUP BY s2.source_id
                       HAVING total >= CAST(? AS DECIMAL(30,8))
                   ) src ON src.source_id = d.source_id
                   WHERE d.status_id = ?
                     AND d.activation_block <= ?
                     AND (d.deactivation_block IS NULL OR d.deactivation_block > ?)
                     ${slashExcl('d.signing_pubkey_id')}`;
        let args = [valid_id, blockIndex, blockIndex, valid_id, blockIndex, blockIndex, minStake,
                    valid_id, blockIndex, blockIndex, minStake,
                    valid_id, blockIndex, blockIndex, blockIndex];
        return { sql, args };
    },

    // Source-keyed effective-signer query (DELEGATE.md additive model).
    //   qualifying sources - per-source aggregate active stake >= MIN_STAKE.
    //   effective keys     - the source's own active stake keys (EXCLUDING keys
    //                        revoked via DELEGATE v2 in effect at the block, applied
    //                        only to stake rows predating the revocation) UNION the
    //                        source's active delegated keys.
    // One output row per (effective key): { pubkey, source(address), weight(=source
    // aggregate) }. Every key of a source carries the SAME source + weight, so a
    // source-deduped tally counts that stake once. CONSENSUS-CRITICAL - mirrors the
    // qualification/revocation/delegation semantics of effectiveCapabilitySetSql.
    stakeWeightsSql(valid_id, blockIndex, minStake){
        // Precision: DECIMAL(30,8) (22 integer digits, 8 fractional) is sufficient because the
        // staking tick is XCHAIN at 8 decimals and total supply stays far below 10^22; every
        // same-version node truncates identically, so the stake-weight tally is deterministic.
        // If a >8-decimal staking tick is ever introduced, widen these casts to
        // DECIMAL(60, <tick-decimals>) AND pin a consistent sql_mode fleet-wide (an overflow at
        // >22 integer digits is otherwise sql_mode-dependent) before that tick can stake.
        // Permanent disqualification - see _effectiveCapabilitySetSql. Excludes equivocation-
        // slashed keys from the effective-key set (both stake-key and delegated-key branches)
        // so the source-deduped stake-weight tally matches the count-quorum set exactly.
        const slashExcl = (keyCol) =>
            `AND NOT EXISTS (SELECT 1 FROM capability_slash_events cse
                             WHERE cse.signing_pubkey_id = ${keyCol} AND cse.block_index <= ?)`;
        let sql = `SELECT ip.pubkey AS pubkey,
                          sa.address AS source,
                          q.total    AS weight
                   FROM (
                       SELECT s.source_id AS source_id,
                              SUM(CAST(s.amount AS DECIMAL(30,8))) AS total
                       FROM stakes s
                       WHERE s.status_id = ?
                         AND s.activation_block <= ?
                         AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)
                       GROUP BY s.source_id
                       HAVING total >= CAST(? AS DECIMAL(30,8))
                   ) q
                   JOIN index_addresses sa ON sa.id = q.source_id
                   JOIN (
                       SELECT s2.source_id AS source_id, s2.signing_pubkey_id AS pubkey_id
                       FROM stakes s2
                       WHERE s2.status_id = ?
                         AND s2.activation_block <= ?
                         AND (s2.deactivation_block IS NULL OR s2.deactivation_block > ?)
                         AND NOT EXISTS (
                             SELECT 1 FROM stake_key_revocations r
                             WHERE r.source_id = s2.source_id
                               AND r.signing_pubkey_id = s2.signing_pubkey_id
                               AND r.status_id = ?
                               AND r.deactivation_block <= ?
                               AND r.action_index > s2.action_index)
                         ${slashExcl('s2.signing_pubkey_id')}
                       GROUP BY s2.source_id, s2.signing_pubkey_id
                       UNION
                       SELECT d.source_id AS source_id, d.signing_pubkey_id AS pubkey_id
                       FROM delegations d
                       WHERE d.status_id = ?
                         AND d.activation_block <= ?
                         AND (d.deactivation_block IS NULL OR d.deactivation_block > ?)
                         ${slashExcl('d.signing_pubkey_id')}
                   ) ek ON ek.source_id = q.source_id
                   JOIN index_pubkeys ip ON ip.id = ek.pubkey_id`;
        let args = [valid_id, blockIndex, blockIndex, minStake,
                    valid_id, blockIndex, blockIndex, valid_id, blockIndex, blockIndex,
                    valid_id, blockIndex, blockIndex, blockIndex];
        return { sql, args };
    },

    // SWQ source-cap wrapper (SWQ-TRUNC-1 liveness half). Wraps an inner source-keyed
    // stake-weight builder ({sql,args} from stakeWeightsSql or the sync AsOf variant)
    // and replaces the raw key-row LIMIT with a windowed cap on the consensus UNIT:
    // DISTINCT staking SOURCES (DENSE_RANK over source) plus a per-source key bound
    // (ROW_NUMBER per source). One source can no longer fill the window and evict
    // honest sources. Over-fetches one extra source (_sr <= maxSources + 1) so the
    // caller can flag a genuinely >maxSources federation as truncated (the primitive
    // then fails closed); the per-source key cap only bounds the row/leaf count and
    // never sets truncated (dropping a source's excess keys does not change its
    // weight). Row order is consensus-irrelevant (the stakes_root SMT keys on
    // pubkey+capability); only the returned SET is. CONSENSUS-CRITICAL: feeds the
    // hashed stakes_root at/after SWQ_SOURCE_CAP_ACTIVATION and MUST stay byte-identical
    // to the xchain-sync twin (cross-repo drift guard in rollback_coverage.test.js).
    //
    // `binCollation` (stake_weight_collation_activation.js) pins the ordering to a
    // binary collation. `source` and `pubkey` resolve through index_addresses.address
    // and index_pubkeys.pubkey, both declared utf8_general_ci (folding), and every
    // other consensus read of those columns already pins utf8_bin. Order is a
    // consensus quantity HERE and only here: the two window ranks are what the caps
    // truncate on, so the collation decides which sources and which keys survive into
    // the hashed stakes_root. Below the height the emitted SQL is byte-identical to
    // what shipped before the gate; the suffix is '' and concatenates away.
    cappedStakeWeightsSql(inner, maxSources, maxKeys, binCollation){
        let c = stakeWeightCollation.stakeWeightCollate(binCollation);
        let sql = `SELECT r.pubkey AS pubkey, r.source AS source, r.weight AS weight, r._sr AS _sr
                   FROM (
                       SELECT b.pubkey AS pubkey, b.source AS source, b.weight AS weight,
                              DENSE_RANK() OVER (ORDER BY b.source${c})                        AS _sr,
                              ROW_NUMBER() OVER (PARTITION BY b.source${c} ORDER BY b.pubkey${c})  AS _kr
                       FROM (${inner.sql}) b
                   ) r
                   WHERE r._sr <= ? AND r._kr <= ?
                   ORDER BY r.source${c}, r.pubkey${c}`;
        let args = [...inner.args, maxSources + 1, maxKeys];
        return { sql, args };
    },

};
