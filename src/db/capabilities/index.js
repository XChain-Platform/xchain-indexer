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
 * XChain Indexer - Database mixin: capabilities
 * 
 * The queries over the capabilities table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { requireStakeWeight } = require('../shared.js');
// The capabilities mixin is cut into parts by behaviour under capabilities/; this entry merges them
// back into the one method set db/index.js installs, at the position those methods held here.
const effectiveStake = require('./effective_stake.js');

module.exports = {

    // Create record in `reward_claims` table
    // Create a validator reward record. ONE writer since the PUSH-ANCHOR endgame
    // retired the hub's pushvalidatorrewards RPC: deterministic block processing
    // (PRICE v0 oracle_round split, ATTEST fee settlement, and the anchor/archive
    // publish rewards derived from the mirrored XANCPUB attestation), replayable on
    // reindex by construction and restored from the ANCHOR archive by recovery.js.
    // No RPC handler reaches this any more; a caller that does is a forge vector.
    // pubkeyHex: 64-char hex Ed25519 signing pubkey of the validator that earned the reward
    // roundReference: round number (oracle_round) or attestation index
    // rewardType: 'oracle_round', 'attest_fee', 'attest_bcast', 'anchor_<chain>', 'anchor_archive'
    // amount: reward amount as decimal string
    // blockIndex: block height when the reward was earned
    // Resolve the source_id (index_addresses id) of the active staking source
    // backing `pubkey_id` at `blockIndex`, or null. Active-row predicates are
    // IDENTICAL to stake_source.js getStakeSourceByPubkey (and thus to
    // effectiveCapabilitySetSql membership): status=valid, activation/deactivation
    // window, stake-key revocation, permanent slash. Reward writers MUST use this so
    // the source_id stored during block processing matches the source the ANCHOR
    // archive pins and recovery restores, keeping validator_rewards (block-scoped
    // replicated state) byte-identical across the recovery boundary. The earlier
    // writers took the latest stake by action_index with no predicates, which could
    // diverge from the archive and break byte-identical recovery.
    async resolveActiveStakeSourceId(pubkey_id, blockIndex){
        if(pubkey_id === null || pubkey_id === undefined) return null;
        let blockIdx = Number(blockIndex);
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return null;
        let rows = await this.doQuery(
            `SELECT s.source_id AS source_id FROM stakes s
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
            rows = await this.doQuery(
                `SELECT d.source_id AS source_id FROM delegations d
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
        return (rows && rows.length > 0) ? rows[0].source_id : null;
    },

    ...effectiveStake,

    // Read the hub-mirrored SOURCE-KEYED weights for a capability at a snapshot block
    // (non-BTC chains). Carries `source` so the verifier can dedupe by staking address.
    // ORDER BY is CONSENSUS-CRITICAL here. This feeds
    // stake-weighted quorum for off-BTC chains, and an unordered SELECT hands the
    // row order to the storage engine, so two nodes can return the same rows in
    // different sequences. That is harmless only for as long as every consumer is
    // order-insensitive; the moment one dedupes, tie-breaks or truncates, the two
    // nodes disagree about the validator set and validation forks.
    //
    // The ordering deliberately does NOT use `id`. It is the obvious choice and it
    // is wrong here: the schema documents `id` as a LOCAL surrogate with NO hub
    // parity (hubs persist independently and AnchorRecovery rebuilds rows id-less,
    // so the mirror strips wire ids). Ordering by it would be stable per node and
    // divergent across the fleet, which is the worst shape a bug can take.
    //
    // Use the natural key instead. The WHERE already pins (capability,
    // snapshot_block), so within the result set the remaining components of
    // uq_cap_snap (snapshot_block, capability, signing_pubkey, source) are
    // (signing_pubkey, source), and the unique key guarantees that pair is
    // distinct. Exactly one ordering is therefore valid, and it is computed from
    // mirrored natural-key columns that every node holds identically. The unique
    // key and this ORDER BY are compared under the same table collation, so the
    // pair cannot tie here while being accepted as distinct by the index.
    async getCapabilitySnapshotWeights(capability, snapshotBlock){
        let query = `SELECT signing_pubkey AS pubkey, source, amount AS weight
                     FROM capability_snapshots
                     WHERE capability = ? AND snapshot_block = ?
                     ORDER BY signing_pubkey ASC, source ASC`;
        // doQueryStrict (not doQuery): a CONSENSUS input read on the hub mirror, which never
        // holds a transaction, so doQuery turns a transient DB fault into an empty weight set,
        // collapsing the stake-weighted quorum denominator S to 0 on this node alone.
        let rows = await this.mirrorDb().doQueryStrict(query, [capability, snapshotBlock]);
        return rows.map(r => ({
            pubkey: String(r.pubkey),
            source: r.source == null ? '' : String(r.source),
            // The query aliases `amount AS weight`, so the value lands on r.weight -
            // reading r.amount (undefined) collapsed EVERY weight to '0', which made
            // stake-weighted quorum fail closed (S=0) for off-BTC chains (DOGE/LTC).
            // capability_snapshots.amount is NOT NULL, so a missing weight here means
            // the mirror is corrupt, not that a source has no stake: THROW
            // rather than resolve it to '0', which would keep the source in the dedupe
            // map with no stake and quietly shrink the quorum denominator S.
            weight: requireStakeWeight(r.weight, 'getCapabilitySnapshotWeights(' + capability + ')')
        }));
    },

    // Read the hub-mirrored qualifying validator set for a capability at a BTC-anchored
    // snapshot block. Presence in capability_snapshots = qualified (the hub only mirrors
    // pubkeys already past min_stake). Lets a non-BTC indexer resolve the cross_chain set.
    // Ordered for the same reason as the sibling getCapabilitySnapshotWeights
    // this resolves the cross_chain validator set on non-BTC indexers,
    // so an engine-dependent row order is a fork waiting for the first consumer that
    // dedupes or truncates. Same natural-key ordering, and `source` is ordered on
    // even though it is not selected: a pubkey delegated by two sources produces two
    // rows here, so pubkey alone is not a total order.
    async getCapabilitySnapshotValidators(capability, snapshotBlock){
        let query = `SELECT signing_pubkey AS pubkey, amount
                     FROM capability_snapshots
                     WHERE capability = ? AND snapshot_block = ?
                     ORDER BY signing_pubkey ASC, source ASC`;
        // doQueryStrict (not doQuery): a CONSENSUS input read on the hub mirror, which never
        // holds a transaction, so doQuery turns a transient DB fault into an empty capable set
        // on this node alone, and its quorum verdict stops matching the fleet's.
        let rows = await this.mirrorDb().doQueryStrict(query, [capability, snapshotBlock]);
        // Guard a NULL amount to '0' so all three snapshot read methods render it
        // identically: the sibling getCapabilitySnapshotWeights (r.weight == null ?
        // '0') and the BTC local path both coerce NULL to '0'; without this an
        // unguarded NULL would surface as the literal string 'null'.
        return rows.map(r => ({ pubkey: String(r.pubkey), amount: r.amount == null ? '0' : String(r.amount) }));
    },

    // How many DISTINCT signing keys the mirrored snapshot holds for a capability at a
    // BTC-anchored block. DISTINCT because a key delegated by two sources produces two rows
    // (see getCapabilitySnapshotValidators): the PBFT denominator counts capable SIGNERS, so
    // counting rows would inflate N above the set the tally is drawn from.
    async getCapabilitySnapshotCount(capability, snapshotBlock){
        let query = `SELECT COUNT(DISTINCT signing_pubkey) AS cnt
                     FROM capability_snapshots
                     WHERE capability = ? AND snapshot_block = ?`;
        // doQueryStrict (not doQuery): a CONSENSUS input read on the hub mirror, which never
        // holds a transaction, so doQuery turns a transient DB fault into N = 0, which is the
        // quorum DENOMINATOR, on this node alone.
        let rows = await this.mirrorDb().doQueryStrict(query, [capability, snapshotBlock]);
        return rows.length > 0 ? Number(rows[0].cnt) : 0;
    },

    // Whether a pubkey is in the mirrored capability snapshot at a block (qualified).
    async isPubkeyInCapabilitySnapshot(pubkey, capability, snapshotBlock){
        let query = `SELECT 1 FROM capability_snapshots
                     WHERE capability = ? AND snapshot_block = ? AND signing_pubkey = ? LIMIT 1`;
        // doQueryStrict (not doQuery): a CONSENSUS input read on the hub mirror, which never
        // holds a transaction, so doQuery turns a transient DB fault into "not qualified" on
        // this node alone, which is the answer that silently drops a capable signer.
        let rows = await this.mirrorDb().doQueryStrict(query, [capability, snapshotBlock, String(pubkey).toLowerCase()]);
        return rows.length > 0;
    },

    // Record one in-place capability-stake slash debit so a reorg can restore the row's
    // amount byte-identically (verbatim `prev_amount` string copy - no arithmetic, so
    // source + replica + from-genesis replay all converge). Mirrors createContractSlashDebit
    // but keyed on the SLASH wire action_index (capability slashes are permissionless wire
    // actions, not VM emissions - there is no execution_index/slash_position).
    async createCapabilitySlashDebit(slashActionIndex, targetTable, stakeActionIndex, prevAmount, amount, blockIndex){
        let query = `INSERT INTO capability_slash_debits
                        (slash_action_index, target_table, stake_action_index, prev_amount, amount, block_index)
                     VALUES (?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [slashActionIndex, targetTable, stakeActionIndex,
                                   String(prevAmount), this.util.bcstr(amount), blockIndex]);
    },

    // Record a capability-stake slash event (audit). Caller (the SLASH handler) has already
    // burned the bond via slashCapabilityStake and computed the bounty/treasury split.
    // Separate from slash_events because that table carries a non-null target_contract_index
    // FK that capability (contract-less) slashes have no value for.
    async createCapabilitySlashEvent(data){
        data                  = this.normalizeDataValues(data);
        let slash_action_index = data['SLASH_ACTION_INDEX'];
        let signing_pubkey_id  = data['SIGNING_PUBKEY_ID'];
        let capability         = data['CAPABILITY'];
        let equiv_key          = data['EQUIV_KEY'];
        let amount             = data['AMOUNT'];
        let bounty_amount      = data['BOUNTY_AMOUNT']   || '0';
        let treasury_amount    = data['TREASURY_AMOUNT'] || '0';
        let submitter_id       = data['SUBMITTER_ID']    != null ? data['SUBMITTER_ID']    : null;
        let destination_id     = data['DESTINATION_ID']  != null ? data['DESTINATION_ID']  : null;
        let block_index        = data['BLOCK_INDEX'];
        let query = `INSERT INTO capability_slash_events
                        (slash_action_index, signing_pubkey_id, capability, equiv_key, amount,
                         bounty_amount, treasury_amount, submitter_id, destination_id, block_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [slash_action_index, signing_pubkey_id, capability, equiv_key,
                                   this.util.bcstr(amount), this.util.bcstr(bounty_amount), this.util.bcstr(treasury_amount),
                                   submitter_id, destination_id, block_index]);
    },

    // Whether a (pubkey, capability) pair has already been slashed - the SLASH handler's
    // idempotency gate (a first equivocation proof burns the whole bond; later proofs for the
    // same pair are no-ops). Block-scoped tables, so a reorg that orphans the slash also drops
    // this row and the check re-opens deterministically.
    async hasCapabilitySlashEvent(pubkeyId, capability){
        let rows = await this.doQuery(
            'SELECT id FROM capability_slash_events WHERE signing_pubkey_id=? AND capability=? LIMIT 1',
            [pubkeyId, String(capability)]);
        return rows.length > 0;
    },

    // Permanent disqualification (WI-2 bump 2): whether a signing key has been slashed for
    // equivocation in ANY capability at or before `blockIndex`. A slashed key is barred from
    // the effective signer set everywhere - not just until its bond burns to 0, but against
    // any future re-stake/re-delegation. GLOBAL (capability-agnostic - an equivocating key is
    // byzantine), block-gated for deterministic historical re-derivation, and reorg-safe (the
    // block-scoped event row rolls back ⇒ the key re-qualifies). The SQL counterpart inside
    // effectiveCapabilitySetSql / _stakeWeightsSql excludes it from the SET queries; this is
    // the per-pubkey check used by hasCapability so both paths agree.
    async isPubkeySlashedAt(pubkeyId, blockIndex){
        if(pubkeyId === null || pubkeyId === undefined) return false;
        let rows = await this.doQuery(
            'SELECT id FROM capability_slash_events WHERE signing_pubkey_id=? AND block_index<=? LIMIT 1',
            [pubkeyId, blockIndex]);
        return rows.length > 0;
    },

};
