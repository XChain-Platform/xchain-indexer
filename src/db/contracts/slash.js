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
 * XChain Indexer - Database mixin part: contracts / slash
 *
 * The contract-stake SLASH deduction across contract_stakes and contract_unstakes, and
 * the per-row debit journal that lets a reorg restore the amounts it reduced.
 * Merged into the contracts mixin by db/contracts/index.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const slashGrid = require('./slash_grid_gate');

module.exports = {

    // Slash a staker. Deducts `amount` from active contract_stakes rows first (LIFO by
    // activation_block / action_index), then from contract_unstakes rows if any remainder.
    // Does NOT credit the destination or emit the slash_events row - caller (processSlashEmission)
    // wires those side effects.
    //
    // Returns { total, releases }:
    //   total    - the amount actually slashed, as a string (less than `amount` when the
    //              available stake is lower).
    //   releases - [{ address, amount }] per OWNING address, in LIFO row order, summing to
    //              `total`. Staked tokens sit in the staker's ESCROW, so the caller releases
    //              them there before crediting the destination. Per-owner because one slash
    //              reduces several rows and a delegated key's rows can span sources.
    //
    // SIGNING-KEY ROTATIONS (#4366). `pubkeyId` is resolved from the pubkey the contract emitted,
    // which it read out of the same snapshot getContractStakeDataForVM built, and that snapshot
    // reads the stake row's CURRENT key. Because materializeContractDelegations rewrites the row
    // at the delegation's activation block, a SLASH against a rotated staker lands on the very
    // rows the contract was shown, instead of matching nothing and returning '0' (which
    // processSlashEmission's zero-slashed path then records as a punishment the ledger never
    // applied). No rotation-aware lookup belongs here: the row IS the rotation.
    async slashContractStake(targetContractIndex, pubkeyId, tickId, amount, blockIndex, executionIndex, slashPosition){
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return { total: '0', releases: [] };
        let remaining = String(amount);
        let totalSlashed = '0';
        // The staked tick may carry up to MAX_TOKEN_DECIMALS (18); do all slash arithmetic at its own
        // precision so an >8-dp token isn't truncated mid-deduction (which would leave dust unslashed
        // or corrupt the residual stake). XCHAIN(8) math is unchanged (item 5303).
        let dec = await this.getTokenDecimalPrecision(tickId);
        // Conserve value across the deduction (flag-day, db/contracts/slash_grid_gate.js). Rounding
        // the row write and the credit SEPARATELY at `dec` lets them disagree: HALF-UP at
        // decimals=0 turns a '0.5' slash of a '1' row into an unchanged row and a full-unit
        // credit. Floor the request onto the tick's grid ONCE (a punishment may not grow on
        // the way in), then run the per-row deduction at exact precision so every derived
        // figure below is the reduction the row actually took.
        let gridOn = slashGrid.isSlashGridActive(blockIndex, this.config['NETWORK'], this.config['COIN']);
        let deductDec = gridOn ? slashGrid.SLASH_DEDUCTION_PRECISION : dec;
        if(gridOn){
            remaining = this.util.bcstr(this.util.bcmulfloor(remaining, '1', dec));
            // An off-grid request that floors away is a no-op, not a free credit; the caller's
            // zero-slashed branch already logs it as an attempted punishment that took nothing.
            if(!this.util.bcgt(remaining, '0')) return { total: '0', releases: [] };
        }
        // Escrow release breakdown, accumulated as the rows are debited. Insertion order is
        // the deterministic LIFO scan order, so every node writes its escrow rows alike.
        let releases = new Map();
        let addRelease = (address, take) => {
            // An unresolvable source cannot have its escrow released against anyone, and
            // guessing would strand the lock. Halt instead.
            if(address === null || address === undefined)
                throw new Error('slashContractStake: stake row has no source address; its escrow is not releasable');
            let cur = releases.get(address);
            releases.set(address, this.util.bcstr(this.util.bcadd(cur === undefined ? '0' : cur, take, deductDec)));
        };
        let asReleases = () => Array.from(releases, ([address, amt]) => ({ address, amount: amt }));
        // The two deduction passes share the request and the release ledger; each takes the
        // running remainder and total and hands them back once its rows are debited.
        let pass = { targetContractIndex, pubkeyId, tickId, valid_id, blockIndex, executionIndex, slashPosition,
                     gridOn, deductDec, addRelease };
        ({ remaining, totalSlashed } = await slashPasses.activeStakeRows(this, pass, remaining, totalSlashed));
        if(!this.util.bcgt(remaining, '0')) return { total: this.util.bcstr(totalSlashed), releases: asReleases() };
        ({ remaining, totalSlashed } = await slashPasses.cooldownRows(this, pass, remaining, totalSlashed));
        return { total: this.util.bcstr(totalSlashed), releases: asReleases() };
    },

    // Record one in-place slash debit, enabling reorg restoration of stake amounts.
    // slashContractStake reduces contract_stakes/contract_unstakes.amount IN PLACE on
    // rows created in earlier (surviving) blocks; the generic rollback delete cannot
    // revert that. This row captures `prev_amount` - the row's EXACT amount string
    // before the debit - so rollback.js can copy it back verbatim (string copy, no
    // arithmetic → byte-identical on source + replica, and identical to a from-genesis
    // replay where the slash was never re-mined). `amount` is the per-row delta (audit).
    async createContractSlashDebit(executionIndex, slashPosition, targetTable, stakeActionIndex, prevAmount, amount, blockIndex){
        let query = `INSERT INTO contract_slash_debits
                        (execution_index, slash_position, target_table, stake_action_index,
                         prev_amount, amount, block_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [executionIndex, slashPosition, targetTable, stakeActionIndex,
                                   String(prevAmount), this.util.bcstr(amount), blockIndex]);
    },

};

// The two deduction passes of slashContractStake, kept off the exported object so
// Database.prototype gains no method. Each debits its rows LIFO while a remainder is left
// and returns the updated { remaining, totalSlashed }.
const slashPasses = {

    async activeStakeRows(db, pass, remaining, totalSlashed){
        let { targetContractIndex, pubkeyId, tickId, valid_id, blockIndex, executionIndex, slashPosition,
              gridOn, deductDec, addRelease } = pass;
        // Pass 1: deduct from ACTIVE (never-unstaked) contract_stakes rows (LIFO - highest
        // action_index first). The deactivation filter is load-bearing: UNSTAKE v1 leaves the
        // contract_stakes row's `amount` intact (it only sets a FUTURE deactivation_block =
        // block + ACTIVATION_DELAY_BLOCKS) AND mirrors the tokens into a contract_unstakes
        // cooldown row that the block-end sweep refunds in full. So the tokens exist in exactly
        // one slashable place per lifecycle stage: contract_stakes while deactivation_block IS
        // NULL, contract_unstakes once UNSTAKE has run. Pass 1 must therefore skip EVERY row that
        // carries a deactivation_block (Pass 2 slashes those from contract_unstakes). Filtering on
        // `deactivation_block > blockIndex` was wrong: because the block is in the future, that
        // predicate is TRUE throughout the [unstake, unstake+delay) window, so a slash landing in
        // the window slashed the phantom contract_stakes copy (crediting the destination) while the
        // sweep still refunded the contract_unstakes row - +X to the destination AND +X back to the
        // staker against one debit (silent supply inflation + total slash evasion).
        let stakesQ = `SELECT cs.action_index, cs.amount, a.address AS source_address
                       FROM contract_stakes cs
                           LEFT JOIN index_addresses a ON (a.id = cs.source_id)
                       WHERE cs.target_contract_index=? AND cs.signing_pubkey_id=? AND cs.tick_id=? AND cs.status_id=?
                         AND CAST(cs.amount AS DECIMAL(60,18)) > 0
                         AND cs.deactivation_block IS NULL
                       ORDER BY cs.action_index DESC`;
        let stakeRows = await db.doQuery(stakesQ, [Number(targetContractIndex), pubkeyId, tickId, valid_id]);
        for(let row of stakeRows){
            if(!db.util.bcgt(remaining, '0')) break;
            let rowAmt = String(row.amount);
            let take = db.util.bcgte(rowAmt, remaining) ? remaining : rowAmt;
            let newAmt = db.util.bcsub(rowAmt, take, deductDec);
            // Re-derive the take from what was WRITTEN, not from what was asked for. Deriving it
            // at `dec` instead would round an off-grid stored row's delta back up and credit a
            // unit the row never held; at exact precision the identity is unconditional.
            if(gridOn) take = db.util.bcstr(db.util.bcsub(rowAmt, newAmt, deductDec));
            await db.doQuery('UPDATE contract_stakes SET amount=? WHERE action_index=?', [newAmt, row.action_index]);
            // Record the in-place debit so a reorg can restore rowAmt verbatim (see rollback.js).
            await db.createContractSlashDebit(executionIndex, slashPosition, 'contract_stakes', row.action_index, rowAmt, take, blockIndex);
            addRelease(row.source_address, take);
            remaining = db.util.bcsub(remaining, take, deductDec);
            totalSlashed = db.util.bcadd(totalSlashed, take, deductDec);
        }
        return { remaining, totalSlashed };
    },

    async cooldownRows(db, pass, remaining, totalSlashed){
        let { targetContractIndex, pubkeyId, tickId, valid_id, blockIndex, executionIndex, slashPosition,
              gridOn, deductDec, addRelease } = pass;
        // Pass 2: deduct from contract_unstakes rows (cooldown-locked but still slashable)
        let pendingId = await db.getStatusId('pending');
        let unstakeStatusIds = [valid_id];
        if(pendingId !== null) unstakeStatusIds.push(pendingId);
        let placeholders = unstakeStatusIds.map(() => '?').join(',');
        let unstakesQ = `SELECT cu.action_index, cu.amount, a.address AS source_address
                         FROM contract_unstakes cu
                             LEFT JOIN index_addresses a ON (a.id = cu.source_id)
                         WHERE cu.target_contract_index=? AND cu.signing_pubkey_id=? AND cu.tick_id=?
                           AND cu.status_id IN (${placeholders})
                           AND CAST(cu.amount AS DECIMAL(60,18)) > 0
                         ORDER BY cu.action_index DESC`;
        let unstakeRows = await db.doQuery(unstakesQ, [Number(targetContractIndex), pubkeyId, tickId, ...unstakeStatusIds]);
        for(let row of unstakeRows){
            if(!db.util.bcgt(remaining, '0')) break;
            let rowAmt = String(row.amount);
            let take = db.util.bcgte(rowAmt, remaining) ? remaining : rowAmt;
            let newAmt = db.util.bcsub(rowAmt, take, deductDec);
            // Same re-derivation as Pass 1: the cooldown rows are debited by the identical
            // arithmetic, so they carry the identical conservation hole without it.
            if(gridOn) take = db.util.bcstr(db.util.bcsub(rowAmt, newAmt, deductDec));
            await db.doQuery('UPDATE contract_unstakes SET amount=? WHERE action_index=?', [newAmt, row.action_index]);
            // Record the in-place debit so a reorg can restore rowAmt verbatim (see rollback.js).
            await db.createContractSlashDebit(executionIndex, slashPosition, 'contract_unstakes', row.action_index, rowAmt, take, blockIndex);
            addRelease(row.source_address, take);
            remaining = db.util.bcsub(remaining, take, deductDec);
            totalSlashed = db.util.bcadd(totalSlashed, take, deductDec);
        }
        return { remaining, totalSlashed };
    },

};
