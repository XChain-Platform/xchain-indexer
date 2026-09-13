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
 * XChain Indexer - Database mixin: rewards
 * 
 * The queries over the rewards table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
// The validator_rewards ledger-key qualifier rule, shared with the two JS writers so the
// SQL predicate here and they cannot disagree about which reward type is qualified.
const arKey = require('../anchor_reward_key.js');
// The frozen anchor/archive reward heights: the derive flag-day and the fleet-agreed
// mirror-completeness watermark. Recovery-restored rewards claim their ORIGINAL derive
// height from here, so a restored row and a live-derived one carry the same stamp.
const ar = require('../anchor_reward_activation.js');

module.exports = {

    // The cheap gate shared by both recovery-reward triggers (the createAddress hook above and
    // the per-block due sweep below). One-time probe of the unapplied staged count, so normal
    // indexing (no recovery in progress) pays a single COUNT(*) and then short-circuits on
    // every later call. The table is auto-created by verifyTables, so it always exists; the
    // guard keeps a partially-migrated DB degrading to "no pending" instead of throwing.
    // Returns true iff staged rows remain. The rollback re-arm clears _recoveryPendingChecked
    // to force a re-probe when it re-arms rows.
    async _probeRecoveryPending(){
        if(!this._recoveryPendingChecked){
            try {
                let probe = await this.doQuery("SELECT COUNT(*) AS c FROM recovery_pending_rewards WHERE applied=0");
                this._recoveryPendingRemaining = (probe.length > 0) ? Number(probe[0].c) : 0;
            } catch(e){
                this._recoveryPendingRemaining = 0;
            }
            this._recoveryPendingChecked = true;
        }
        return this._recoveryPendingRemaining > 0;
    },

    // Per-block recovery-reward due sweep. Materializes every staged reward whose ORIGINAL
    // derive height has been reached by the block now being processed and whose source address
    // already holds its deterministic in-block id.
    //
    // This, not the createAddress hook, is what lands a derive-era restored reward: the source
    // address is always interned at or before the reward's earn block, which is
    // ANCHOR_REWARD_MIRROR_MATURITY blocks BELOW the height the fleet minted the reward at, so
    // the hook always sees the row as not-yet-due and leaves it staged. Landing it here instead
    // is what makes the recovered node hold the identical reward set as a live node at every
    // height: materializing at the address's first-seen block credited a COLLECT-spendable
    // reward for the whole window between that block and the real derive height, a window in
    // which no live node had it (a larger SUM(validator_rewards), which is a ledger fork at the
    // next COLLECT). Runs at the same point in the block as deriveAnchorRewards, so a restored
    // reward becomes claimable in exactly the block a live-derived one does.
    //
    // No-op outside an in-progress recovery (the shared cheap gate), and on a chain whose
    // staging table is empty - which is every chain but BTC, since validator_rewards only ever
    // resolves a source there. Returns the number of rows materialized.
    async _applyPendingRewardsDueAtBlock(blockIndex){
        if(!await this._probeRecoveryPending())
            return 0;
        let bi = Number(blockIndex);
        if(!Number.isFinite(bi))
            return 0;
        // The highest earn-block whose derive height has been reached at this block. Rows above
        // it are still maturing and stay staged. Never negative, so an early chain cannot
        // sweep everything in at genesis.
        let dueEarnBlock = bi - ar.ANCHOR_REWARD_MIRROR_MATURITY;
        if(dueEarnBlock < 0)
            return 0;
        let rows = [];
        try {
            // Only addresses holding a DETERMINISTIC (block-stamped) id: an out-of-band id is
            // not reproducible across nodes, so materializing under one would fork the source.
            rows = await this.doQuery(
                `SELECT DISTINCT rpr.source_address AS source_address, ia.id AS source_id
                   FROM recovery_pending_rewards rpr
                   JOIN index_addresses ia ON ia.address = rpr.source_address
                  WHERE rpr.applied=0 AND rpr.block_index <= ? AND ia.block_index IS NOT NULL`,
                [dueEarnBlock]);
        } catch(e){
            // Schema gap only (table/column absent on a non-recovery stack, where nothing was
            // staged). Every other fault propagates so the block transaction aborts rather
            // than committing a block that silently skipped a due reward.
            if(!(e && (e.errno === 1146 || e.errno === 1054))) throw e;
            return 0;
        }
        let count = 0;
        for(let s of (rows || []))
            count += await this._applyPendingRewardsForAddress(s.source_address, s.source_id, bi);
        this._recoveryPendingRemaining -= count;
        return count;
    },

    // Materialize every unapplied staged reward for this source address into validator_rewards
    // under the just-assigned deterministic source_id, byte-identical to the in-block
    // createValidatorReward row shape (same columns, same UNIQUE dedup). Stamps the staging row
    // with the resolved source_id and marks it applied (so a reorg re-arm can find rows whose
    // source id was rolled back). Returns the number of rows applied. The archived block_index
    // is carried verbatim onto validator_rewards (it is the reward's earn-block, not the
    // address's first-seen block). validator_rewards is NOT consensus-hashed (parity-only), so
    // the bar here is COLLECT-correctness + from-genesis parity, not block-hash byte-identity.
    // materializedBlock (optional): the block at which this materialization happens (the
    // address's first-seen block, or the reorg point B on a rollback re-drain). Recorded
    // on the staging row as applied_block, the forward-window key xchain-sync streams the
    // row by when its validator_rewards block_index (earn-block) sits below the replication
    // window. Left NULL when not supplied (legacy callers); the collector skips NULL rows.
    //
    // DUE-GATED: a derive-era staged row is materialized only once materializedBlock has
    // reached the height the live fleet derived it at (_restoredRewardDeriveBlock). A row that
    // is not yet due is left staged for the per-block due sweep above, so no caller (the
    // createAddress hook, the rollback re-drain) can put a restored reward on the books at a
    // height where a live node does not hold it. A caller that names no block (legacy/test
    // paths) cannot judge dueness, so it applies as before.
    async _applyPendingRewardsForAddress(source_address, source_id, materializedBlock){
        let rows = await this.doQuery(
            "SELECT id, validator_pubkey, reward_type, round_reference, amount, block_index FROM recovery_pending_rewards WHERE source_address=? AND applied=0",
            [source_address]);
        let appliedBlock = (materializedBlock === undefined || materializedBlock === null)
            ? null : Number(materializedBlock);
        let count = 0;
        for(let r of rows){
            // The block this reward was FIRST derived at (operator ruling (a),
            // 2026-08-29). Two things ride on it, and both are the reason a restored row may
            // not claim the restoring height instead:
            //   1. the reorg-scoping delete. rollback.js drops validator_rewards on
            //      derive_block_index >= reorg as well as on the earn-block, because a reward
            //      whose CREATING block is orphaned is one a from-genesis replay to that height
            //      has not derived yet. A restored row left NULL here was invisible to that
            //      delete and survived as a COLLECT-spendable credit no live node still held.
            //   2. the height it may first appear at (the due gate below).
            // NULL below the derive flag-day: no BTC-side row was minted by the derive path
            // there, so the legacy stamp stays byte-identical.
            let deriveBlock = this._restoredRewardDeriveBlock(r.block_index);
            if(deriveBlock !== null && appliedBlock !== null && appliedBlock < deriveBlock)
                continue;   // still maturing; the per-block due sweep lands it at deriveBlock
            let pubkey_id = await this.getOrCreatePubkeyId(String(r.validator_pubkey).toLowerCase());
            if(pubkey_id === null)
                continue;   // leave unapplied; surfaces as a parity gap rather than a bad FK
            // round_qualifier keeps this row's key identical to what the live writers
            // produce, which is what "same UNIQUE dedup" above promises. The staging table
            // carries no snapshot_block, but it does not need one: for 'anchor_archive' the
            // reward's EARN block IS the snapshot block (both live writers pass
            // SNAPSHOT_BLOCK as block_index), so the archived block_index is the qualifier.
            // Every other reward type resolves to 0 and is written exactly as before.
            // Without this a recovered node would key archive rewards at 0 while a live node
            // keys them at snapshot_block, so a pair sharing a reissued MATCH_BATCH_SEQ would
            // collapse under INSERT IGNORE here and the recovered node's COLLECT total would
            // sit one archive reward below a from-genesis replay's.
            await this.doQuery(
                `INSERT IGNORE INTO validator_rewards
                    (source_id, signing_pubkey_id, reward_type, round_reference, round_qualifier, amount, block_index, derive_block_index)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [source_id, pubkey_id, String(r.reward_type), r.round_reference,
                 arKey.rewardRoundQualifier(r.reward_type, r.block_index),
                 String(r.amount), Number(r.block_index), deriveBlock]);
            await this.doQuery("UPDATE recovery_pending_rewards SET applied=1, source_id=?, applied_block=? WHERE id=?",
                [source_id, appliedBlock, r.id]);
            count++;
        }
        return count;
    },

    // upsert: deterministic block-processing writers pass true so their value
    //         always wins over a best-effort hub push that raced them - the
    //         derived row is the consensus row (replay produces it byte-equal)
    // deriveBlockIndex: the block that MATERIALIZED the row, when that differs from the
    // reward's earn-block (blockIndex). Only the BTC-side anchor/archive
    //         derivation passes it: that path earns at the checkpoint's SNAPSHOT_BLOCK but
    //         writes while processing a much later BTC block, so rollback needs the creating
    // block to know the row must disappear. Every other writer earns and
    //         writes in the same block and leaves it NULL.
    // roundQualifier: the remaining component of the reward's UNIQUE identity. It is
    //         snapshot_block for 'anchor_archive' and 0 for every other reward type, because the
    //         archive leg's round_reference is MATCH_BATCH_SEQ - a dense hub counter a
    //         wipe-and-replay rebase reissues - so it alone does not name one logical reward.
    //         Callers compute it with anchor_reward_key.rewardRoundQualifier(); an omitted
    //         argument lands on 0, the value every pre-column row already carries, so every
    //         non-archive writer stays byte-identical.
    async createValidatorReward(pubkeyHex, roundReference, rewardType, amount, blockIndex, upsert, deriveBlockIndex, roundQualifier){
        let pubkey_id = await this.getPubkeyId(String(pubkeyHex).toLowerCase());
        if(pubkey_id === null){
            console.warn('createValidatorReward: unknown pubkey ' + pubkeyHex);
            return false;
        }
        // Strict active-row source resolution at this reward's block, matching the
        // ANCHOR archive + recovery (see _resolveActiveStakeSourceId).
        let source_id = await this._resolveActiveStakeSourceId(pubkey_id, blockIndex);
        if(source_id === null || source_id === undefined){
            console.warn('createValidatorReward: no active stake or delegation for pubkey ' + pubkeyHex + ' at block ' + blockIndex);
            return false;
        }
        // Insert the reward (idempotent via UNIQUE INDEX on
        // source_id+signing_pubkey_id+reward_type+round_reference+round_qualifier).
        // Deterministic writers upsert so their amount/block_index always win.
        let derive_block_index = (deriveBlockIndex === undefined || deriveBlockIndex === null)
            ? null : Number(deriveBlockIndex);
        // NEVER NULL. MariaDB treats NULLs as distinct in a UNIQUE index, so a nullable
        // qualifier would silently stop this key deduplicating rows at all - the opposite of
        // what the column is for. Coerced here so a caller that passes undefined/null still
        // writes the legacy 0.
        let round_qualifier = Number(roundQualifier);
        if(!Number.isFinite(round_qualifier) || round_qualifier < 0) round_qualifier = 0;
        round_qualifier = Math.floor(round_qualifier);
        let query = upsert
            ? `INSERT INTO validator_rewards
                    (source_id, signing_pubkey_id, reward_type, round_reference, round_qualifier, amount, block_index, derive_block_index)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE amount=VALUES(amount), block_index=VALUES(block_index),
                                         derive_block_index=VALUES(derive_block_index)`
            : `INSERT IGNORE INTO validator_rewards
                    (source_id, signing_pubkey_id, reward_type, round_reference, round_qualifier, amount, block_index, derive_block_index)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        let args = [source_id, pubkey_id, rewardType, roundReference, round_qualifier, amount, blockIndex, derive_block_index];
        await this.doQuery(query, args);
        return true;
    },

    // Keep exactly ONE validator_reward per (reward_type, round_reference) for
    // anchor rewards: the row whose signing pubkey sorts lexicographically
    // smallest - the SAME deterministic winner the hub's RewardTracker elects
    // (recordAnchorReward). One logical anchor → one reward. In a failover
    // double-publish the loser's pubkey can be pushed to THIS indexer before
    // (or, because the hub's pushes are fire-and-forget, after) the winner's;
    // the hub dedups its own DB but has no path to retract an already-pushed
    // loser row from the indexer. Applying the identical smallest-pubkey rule
    // here is order-independent and keeps the COLLECT rail + recovery
    // single-winner fleet-wide (#3963). No-op for non-anchor reward types
    // (those are derived deterministically per block and never pushed).
    // The min-pubkey is materialised in a derived table so the DELETE doesn't
    // self-reference its target table (MariaDB forbids that inline).
    //
    // RB-ANCHOR: before the DELETE, pre-image each loser row into
    // anchor_reward_reconcile_log so a reorg that orphans THIS reconcile (the
    // ANCHOR action's block) can restore the deleted losers. The losers sit in
    // EARLIER surviving blocks (block_index = the checkpoint's SNAPSHOT_BLOCK),
    // so the generic block delete never touches them and a from-genesis replay
    // to reorg_block-1 (where the orphaned ANCHOR never re-ran the reconcile)
    // still has them; without the log the reorged node keeps a spuriously-
    // collapsed reward set, lowering a later COLLECT's SUM(validator_rewards)
    // vs a fresh replay (a ledger-hashed divergence). Logging is scoped to the
    // reconcile block, so callers that cannot name a block (legacy test paths)
    // pass null and skip the log (the DELETE behaviour is unchanged).
    //
    // Scoped by round_qualifier as well, and that scoping is the whole point for the archive
    // leg: 'anchor_archive' rounds are MATCH_BATCH_SEQ, a dense hub counter a wipe-and-replay
    // rebase reissues, so a (reward_type, round_reference) collapse reaches ACROSS two
    // genuinely distinct archive anchors and deletes a real, quorum-attested publisher's pay
    // as if it were a failover loser. The qualifier (snapshot_block for the archive leg, 0
    // everywhere else) is what the signed XANCPUB tuple already distinguishes them by.
    // An omitted qualifier is 0, so every per-chain caller behaves exactly as before.
    async reconcileAnchorRewardWinner(roundReference, rewardType, reconcileBlockIndex, anchorActionIndex, roundQualifier){
        if(!/^anchor_[A-Za-z_]+$/.test(String(rewardType))) return 0;
        let round_qualifier = Number(roundQualifier);
        if(!Number.isFinite(round_qualifier) || round_qualifier < 0) round_qualifier = 0;
        round_qualifier = Math.floor(round_qualifier);
        if(reconcileBlockIndex !== null && reconcileBlockIndex !== undefined){
            // Same loser predicate as the DELETE (pubkey > min_pubkey), capturing each
            // row's verbatim pre-image + its ORIGINAL earn-block (reward_block_index).
            // reward_derive_block_index carries the loser's MATERIALIZATION block
            // the earn-block alone cannot tell the restore whether a replay to reorg-1 would
            // have minted this loser at all, because a derived reward's earn-block is the far
            // earlier SNAPSHOT_BLOCK. NULL for a loser written by a same-block writer.
            let logQuery = `INSERT INTO anchor_reward_reconcile_log
                                (anchor_action_index, reward_type, round_reference, round_qualifier,
                                 source_id, signing_pubkey_id, amount, reward_block_index,
                                 reward_derive_block_index, block_index)
                            SELECT ?, vr.reward_type, vr.round_reference, vr.round_qualifier,
                                   vr.source_id, vr.signing_pubkey_id, vr.amount, vr.block_index,
                                   vr.derive_block_index, ?
                              FROM validator_rewards vr
                              JOIN index_pubkeys pk ON pk.id = vr.signing_pubkey_id
                              JOIN (
                                  SELECT MIN(pk2.pubkey) AS min_pubkey
                                  FROM validator_rewards vr2
                                  JOIN index_pubkeys pk2 ON pk2.id = vr2.signing_pubkey_id
                                  WHERE vr2.reward_type = ? AND vr2.round_reference = ?
                                    AND vr2.round_qualifier = ?
                              ) m
                              WHERE vr.reward_type = ? AND vr.round_reference = ?
                                AND vr.round_qualifier = ?
                                AND pk.pubkey > m.min_pubkey`;
            await this.doQuery(logQuery, [
                (anchorActionIndex === undefined ? null : anchorActionIndex), reconcileBlockIndex,
                rewardType, roundReference, round_qualifier,
                rewardType, roundReference, round_qualifier]);
        }
        let query = `DELETE vr FROM validator_rewards vr
                     JOIN index_pubkeys pk ON pk.id = vr.signing_pubkey_id
                     JOIN (
                         SELECT MIN(pk2.pubkey) AS min_pubkey
                         FROM validator_rewards vr2
                         JOIN index_pubkeys pk2 ON pk2.id = vr2.signing_pubkey_id
                         WHERE vr2.reward_type = ? AND vr2.round_reference = ?
                           AND vr2.round_qualifier = ?
                     ) m
                     WHERE vr.reward_type = ? AND vr.round_reference = ?
                       AND vr.round_qualifier = ?
                       AND pk.pubkey > m.min_pubkey`;
        let res = await this.doQuery(query, [rewardType, roundReference, round_qualifier,
                                             rewardType, roundReference, round_qualifier]);
        return res && res.affectedRows ? res.affectedRows : 0;
    },

    async createRewardClaim(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let source_id    = await this.getAddressId(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        let amount       = data['AMOUNT'] || '0';
        let block_index  = data['BLOCK_INDEX'];
        // Check if record already exists
        let query  = "SELECT action_index FROM reward_claims WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE reward_claims SET
                        source_id=?, amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [source_id, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO reward_claims
                        (source_id, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?)`;
            args = [source_id, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    },

    // Get total unclaimed rewards for a source address.
    // blockIndex (optional): scope both sides to rows earned/claimed at or before
    // that block. COLLECT validation MUST pass its BLOCK_INDEX so a replay
    // (reindex / ANCHOR recovery) sees exactly the rewards that were visible when
    // the COLLECT confirmed - bulk-restored rewards must not become visible to
    // EARLIER COLLECTs than they were live (CONSENSUS). Live operation is
    // unaffected: pushed/derived rows always carry block_index <= tip.
    async getUnclaimedRewardTotal(source, blockIndex){
        let source_id = await this.getAddressId(source);
        if(source_id === null)
            return '0';
        let scoped = (blockIndex !== undefined && blockIndex !== null);
        // Sum all rewards minus all claimed amounts
        let query = `SELECT
                        COALESCE(SUM(CAST(vr.amount AS DECIMAL(65,18))), 0) as total_rewards
                    FROM validator_rewards vr
                    WHERE vr.source_id=?`;
        let args = [source_id];
        if(scoped){
            query += ' AND vr.block_index <= ?';
            args.push(blockIndex);
        }
        let results = await this.doQuery(query, args);
        let totalRewards = (results.length > 0) ? String(results[0].total_rewards) : '0';

        query = `SELECT
                    COALESCE(SUM(CAST(rc.amount AS DECIMAL(65,18))), 0) as total_claimed
                FROM reward_claims rc
                    INNER JOIN index_statuses s ON (s.id=rc.status_id)
                WHERE rc.source_id=? AND s.status='valid'`;
        args = [source_id];
        if(scoped){
            query += ' AND rc.block_index <= ?';
            args.push(blockIndex);
        }
        results = await this.doQuery(query, args);
        let totalClaimed = (results.length > 0) ? String(results[0].total_claimed) : '0';

        let unclaimed = this.util.bcsub(totalRewards, totalClaimed, 18);
        return unclaimed;
    },

};
