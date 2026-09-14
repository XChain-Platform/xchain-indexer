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
 * XChain Indexer - Database mixin part: stakes / capability_slash
 *
 * The equivocation burn of a whole capability bond across stakes and unstakes, journaled
 * per row so a reorg restores the amounts it reduced.
 * Merged into the stakes mixin by db/stakes.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// Pass 1 of slashCapabilityStake: burns the offender's never-unstaked stakes rows and
// returns the running total with each burned row added, in the same LIFO order.
async function burnActiveStakeRows(pass, burnPending, totalSlashed){
    const { db, targetCol, targetVal, valid_id, blockIndex, slashActionIndex, addRelease } = pass;
    // Pass 1: ACTIVE (never-unstaked) stakes rows (LIFO - highest action_index first). Same
    // correctness point as slashContractStake: after UNSTAKE the `stakes` row keeps its amount
    // but carries a FUTURE deactivation_block and its tokens are mirrored into a cooldown
    // `unstakes` row (Pass 2). Pass 1 must skip any row with a deactivation_block set, else a
    // slash in the [unstake, unstake+delay) window burns BOTH the stakes row here AND the
    // unstakes row in Pass 2 (which has no `remaining` gate), doubling `totalSlashed` and
    // inflating the bounty/treasury base computed from it. `deactivation_block > blockIndex`
    // was the inverted predicate (future block => TRUE in-window).
    // SLASH-1 (gated by SLASH_BURNS_PENDING_STAKE, caller passes burnPending): a byzantine key's
    // ENTIRE locked bond must burn, activated or NOT. A pending-activation top-up
    // (activation_block > blockIndex) was already debited from the staker at STAKE time, so the
    // legacy `activation_block <= ?` filter let it survive the burn and be UNSTAKEd/refunded
    // later (the sibling slashContractStake never had this filter). At/after the flag-day the
    // predicate is dropped; below it the legacy activation-gated burn is preserved for
    // replay/fleet consistency. The `deactivation_block IS NULL` guard is INDEPENDENT and stays
    // in both regimes (it is the Pass-1/Pass-2 double-burn defense, not an activation gate).
    let activationClause = burnPending ? '' : 'AND s.activation_block <= ?';
    let stakesQ = `SELECT s.action_index, s.amount, a.address AS source_address
                       FROM stakes s
                           LEFT JOIN index_addresses a ON (a.id = s.source_id)
                       WHERE s.${targetCol}=? AND s.status_id=?
                         ${activationClause}
                         AND CAST(s.amount AS DECIMAL(30,8)) > 0
                         AND s.deactivation_block IS NULL
                       ORDER BY s.action_index DESC`;
    let stakeArgs = burnPending ? [targetVal, valid_id] : [targetVal, valid_id, blockIndex];
    let stakeRows = await db.doQuery(stakesQ, stakeArgs);
    for(let row of stakeRows){
        let rowAmt = String(row.amount);
        if(!db.util.bcgt(rowAmt, '0')) continue;
        await db.doQuery('UPDATE stakes SET amount=? WHERE action_index=?', ['0', row.action_index]);
        // prev_amount = the whole row (we burn it entirely); delta = the same.
        await db.createCapabilitySlashDebit(slashActionIndex, 'stakes', row.action_index, rowAmt, rowAmt, blockIndex);
        addRelease(row.source_address, rowAmt);
        totalSlashed = db.util.bcadd(totalSlashed, rowAmt, 8);
    }
    return totalSlashed;
}

// Pass 2 of slashCapabilityStake: burns the offender's cooldown-locked unstakes rows and
// returns the running total with each burned row added, in the same LIFO order.
async function burnCooldownUnstakeRows(pass, totalSlashed){
    const { db, targetCol, targetVal, valid_id, blockIndex, slashActionIndex, addRelease } = pass;
    // Pass 2: cooldown-locked unstakes rows (status valid/pending) - slashable too (closes R-4:
    // capability unstakes are NOT slashable under the legacy contract-only path).
    let pendingId = await db.getStatusId('pending');
    let unstakeStatusIds = [valid_id];
    if(pendingId !== null) unstakeStatusIds.push(pendingId);
    let placeholders = unstakeStatusIds.map(() => '?').join(',');
    // Same owner-vs-own-key targeting as Pass 1 (#3163): cooldown-locked tokens of a
    // delegated key's OWNER are part of the bond and must burn with it.
    let unstakesQ = `SELECT u.action_index, u.amount, a.address AS source_address
                         FROM unstakes u
                             LEFT JOIN index_addresses a ON (a.id = u.source_id)
                         WHERE u.${targetCol}=? AND u.status_id IN (${placeholders})
                           AND CAST(u.amount AS DECIMAL(30,8)) > 0
                         ORDER BY u.action_index DESC`;
    let unstakeRows = await db.doQuery(unstakesQ, [targetVal, ...unstakeStatusIds]);
    for(let row of unstakeRows){
        let rowAmt = String(row.amount);
        if(!db.util.bcgt(rowAmt, '0')) continue;
        await db.doQuery('UPDATE unstakes SET amount=? WHERE action_index=?', ['0', row.action_index]);
        await db.createCapabilitySlashDebit(slashActionIndex, 'unstakes', row.action_index, rowAmt, rowAmt, blockIndex);
        addRelease(row.source_address, rowAmt);
        totalSlashed = db.util.bcadd(totalSlashed, rowAmt, 8);
    }
    return totalSlashed;
}

module.exports = {

    // Burn an equivocating validator's ENTIRE capability bond (active `stakes` + cooldown-
    // locked `unstakes`), recording each in-place reduction in capability_slash_debits so a
    // reorg restores the pre-slash amounts verbatim (see rollback.js).
    //
    // Returns { total, releases }, the same shape as slashContractStake and for the same
    // reason: the bond sits in the staker's ESCROW and the caller releases it there before
    // crediting bounty/treasury. `releases` is [{ address, amount }] per owning address in
    // LIFO row order, summing to `total` (the XCHAIN burned, as a string); a delegated key's
    // rows resolve to the OWNING source, so one burn can span several addresses.
    //
    // Unlike slashContractStake (per-contract, per-tick, partial `amount`), capability stake
    // is a single XCHAIN bond per signing pubkey (XCHAIN-only - no contract/tick), and a
    // cryptographic equivocation proof burns the WHOLE bond in one shot. The deactivation-
    // window guard on Pass 1 is the same supply-inflation correctness point as the contract
    // path: after UNSTAKE a `stakes` row keeps its `amount` intact (only deactivation_block is
    // set) AND its tokens are mirrored into a cooldown `unstakes` row, so Pass 1 must skip that
    // phantom copy (Pass 2 burns the cooldown row) - each token burned exactly once. The
    // (pubkey,capability) dedup that makes a first slash idempotent lives in the SLASH handler.
    // ownerSourceId: when the offender is a DELEGATED signing key, the bond
    // lives on the OWNING source's stakes, not on rows keyed by the delegated pubkey.
    // Callers resolve it with getStakeSourceForDelegatedPubkey() AT THE EQUIVOCATION
    // HEIGHT and pass it here; null keeps the original signing_pubkey_id targeting for
    // a key that stakes in its own name.
    //
    // The burn is min(target, remaining) by construction rather than by arithmetic:
    // each row is zeroed for exactly the amount it still holds, and rows already at 0
    // are skipped. So a bond that has since fully unstaked and been withdrawn burns
    // ZERO and the SLASH still records as valid, which is the pinned resolution: the
    // outcome must not depend on stake motion after the offence.
    async slashCapabilityStake(pubkeyId, blockIndex, slashActionIndex, burnPending, ownerSourceId = null){
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return { total: '0', releases: [] };
        let totalSlashed = '0';
        // Escrow release breakdown, accumulated as the rows are burned; XCHAIN is 8-dp,
        // matching the arithmetic below. LIFO scan order, so every node writes it alike.
        let releases = new Map();
        let addRelease = (address, take) => {
            // Same halt as slashContractStake: an unattributable bond cannot be released.
            if(address === null || address === undefined)
                throw new Error('slashCapabilityStake: stake row has no source address; its escrow is not releasable');
            let cur = releases.get(address);
            releases.set(address, this.util.bcstr(this.util.bcadd(cur === undefined ? '0' : cur, take, 8)));
        };
        // Target the owning source when the offender was a delegated key (#3163),
        // otherwise the offender's own signing key. Exactly one column is matched, so
        // there is no chance of double-counting a row across both spellings.
        let targetCol = (ownerSourceId !== null && ownerSourceId !== undefined) ? 'source_id' : 'signing_pubkey_id';
        let targetVal = (ownerSourceId !== null && ownerSourceId !== undefined) ? ownerSourceId : pubkeyId;
        let pass = { db: this, targetCol, targetVal, valid_id, blockIndex, slashActionIndex, addRelease };
        totalSlashed = await burnActiveStakeRows(pass, burnPending, totalSlashed);
        totalSlashed = await burnCooldownUnstakeRows(pass, totalSlashed);
        return { total: this.util.bcstr(totalSlashed), releases: Array.from(releases, ([address, amount]) => ({ address, amount })) };
    },

};
