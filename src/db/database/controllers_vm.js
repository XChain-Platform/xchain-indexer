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
 * XChain Indexer - Database class part: controllers and VM support
 *
 * Contract stake key rotation, token and address controller resolution, the VM savepoints
 * and the VM balance snapshot.
 *
 * A part of the Database class body: db/index.js installs it onto Database.prototype,
 * non-enumerable and in the order the class declared it, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// Strict, as the class body these methods came from was.
'use strict';

module.exports = {

    // Rewrite one contract_stakes / contract_unstakes row's signing key and journal the previous
    // value so a reorg can restore it verbatim (see rollback.js) and xchain-sync can carry the
    // mutated surviving row to followers (updatedRows.js). Shared by the rotate and revert passes
    // above. `table` is a fixed literal from this method, never caller input.
    async rotateContractStakeKey(table, stakeRow, delegationActionIndex, newPubkeyId, blockIndex){
        await this.doQuery('UPDATE ' + table + ' SET signing_pubkey_id=? WHERE action_index=?',
            [newPubkeyId, stakeRow.action_index]);
        await this.createContractDelegationRotation(table, delegationActionIndex, stakeRow.action_index,
            stakeRow.signing_pubkey_id, newPubkeyId, blockIndex);
        return {
            target_table:            table,
            stake_action_index:      Number(stakeRow.action_index),
            delegation_action_index: Number(delegationActionIndex),
            prev_signing_pubkey_id:  Number(stakeRow.signing_pubkey_id),
            new_signing_pubkey_id:   Number(newPubkeyId),
            block_index:             Number(blockIndex)
        };
    },

    // Read-time cooldown rule: a `bind` event gates; an `unbind` event gates only while
    // atBlock < cooldown_end_block. Returns the row when it is still gating, else null.
    controllerEventIfGating(row, atBlock){
        if(!row) return null;
        if(Number(row.is_unbind) === 1){
            if(this.util.isNull(row.cooldown_end_block)) return null;
            return (Number(atBlock) < Number(row.cooldown_end_block)) ? row : null;
        }
        return row;
    },

    // Effective (still-gating) controller for one (subject, class), or null.
    async getEffectiveTokenController(tick_id, action_class, atBlock, atActionIndex){
        let row = await this.readLatestControllerEvent('token_controllers', 'tick_id', tick_id, action_class, atBlock, atActionIndex);
        return this.controllerEventIfGating(row, atBlock);
    },

    async getEffectiveAddressController(address_id, action_class, atBlock, atActionIndex){
        let row = await this.readLatestControllerEvent('address_controllers', 'address_id', address_id, action_class, atBlock, atActionIndex);
        return this.controllerEventIfGating(row, atBlock);
    },

    // Guard-resolution: which single controller gates an ACTION of this class. Most-specific-wins -
    // a class-specific binding overrides the catch-all 'all' binding; if none, fall back to 'all'.
    // Exactly one row out → one guard runs → no stacking. Enforcement-ONLY: bind/unbind validation
    // must use the exact getters above (the fallback would falsely report a class as "already bound"
    // when only 'all' is bound, blocking the intended specific-class override).
    async getEffectiveTokenControllerForGuard(tick_id, action_class, atBlock, atActionIndex){
        let row = await this.getEffectiveTokenController(tick_id, action_class, atBlock, atActionIndex);
        if(row) return row;
        if(action_class === 'all') return null;
        return this.getEffectiveTokenController(tick_id, 'all', atBlock, atActionIndex);
    },

    async getEffectiveAddressControllerForGuard(address_id, action_class, atBlock, atActionIndex){
        let row = await this.getEffectiveAddressController(address_id, action_class, atBlock, atActionIndex);
        if(row) return row;
        if(action_class === 'all') return null;
        return this.getEffectiveAddressController(address_id, 'all', atBlock, atActionIndex);
    },

    // Effective controllers for a subject: Map<action_class, contract_index> over the latest gating
    // event per class (read-time cooldown applied). For Phase B enforcement reads.
    async getTokenControllers(tick_id, atBlock, atActionIndex){
        return this.readEffectiveControllerMap('token_controllers', 'tick_id', tick_id, atBlock, atActionIndex);
    },

    async getAddressControllers(address_id, atBlock, atActionIndex){
        return this.readEffectiveControllerMap('address_controllers', 'address_id', address_id, atBlock, atActionIndex);
    },

    /*****************************************************************
     * VM Integration - Savepoints
     ****************************************************************/

    // Create a savepoint within the current transaction
    async createSavepoint(name){
        this.assertTxNotFenced();
        if(!this.transactionConnection)
            throw new Error('createSavepoint requires an active transaction');
        await this.transactionConnection.query('SAVEPOINT ' + name);
        return name;
    },

    // Release a savepoint
    async releaseSavepoint(name){
        this.assertTxNotFenced();
        if(!this.transactionConnection)
            throw new Error('releaseSavepoint requires an active transaction');
        await this.transactionConnection.query('RELEASE SAVEPOINT ' + name);
    },

    // Rollback to a savepoint
    async rollbackToSavepoint(name){
        this.assertTxNotFenced();
        if(!this.transactionConnection)
            throw new Error('rollbackToSavepoint requires an active transaction');
        await this.transactionConnection.query('ROLLBACK TO SAVEPOINT ' + name);
    },

    // Build the balance + token-info snapshot the VM gateway exposes through
    // xchain.getBalance(address, tick) and xchain.getTokenInfo(tick). Scoped to
    // the explicitly passed addresses (the EXECUTE/DEPLOY SOURCE + the contract's
    // own derived address) - arbitrary-address reads inside a contract resolve to
    // null because they cannot be pre-loaded deterministically.
    //
    // Determinism: every read is bounded by `action_index < ?` (pre-action ledger
    // state - the contract's own mid-execution emissions are not yet persisted, so
    // a contract sees the balance it held going in, identical on every validator).
    // Amounts are mathjs-bignumber strings (no float). Reads run SERIALLY: during
    // block processing these share the single transaction connection, which cannot
    // serve concurrent queries (see updateAddressBalances).
    //
    // Returns the nested, SYMBOL-keyed shapes the gateway consumes:
    //   balances  = { addressString: { tickSymbol: amount } }
    //   tokenInfo = { tickSymbol: { TICK, TICK_ID, DECIMALS, SUPPLY, OWNER, ... } }
    async buildVmBalancesAndTokenInfo(addresses, blockIndex, actionIndex){
        let balances  = {};
        let tokenInfo = {};
        let tickCache = {}; // tick_id -> symbol, reused across addresses (avoids N+1)

        for(let address of addresses){
            if(this.util.isNull(address))
                continue;
            // Flat { tick_id: amount } at pre-action state.
            let flat = await this.getAddressBalances(address, null, blockIndex, actionIndex);
            let bySymbol = {};
            for(let tick_id in flat){
                let symbol = tickCache[tick_id];
                if(symbol === undefined){
                    symbol = await this.getTicker(tick_id);
                    tickCache[tick_id] = symbol; // cache null too - avoids re-querying a missing id
                }
                if(this.util.isNull(symbol))
                    continue;
                // getAddressBalances returns mathjs-bignumber OBJECTS (via bcsub/bcnum).
                // The gateway exposes these to contracts that feed them straight into
                // xchain.math (gte/subtract/...), and the value is copied across the
                // isolated-vm boundary - where a bignumber object degrades to a plain
                // object and math throws "[DecimalError] Invalid argument: [object Object]".
                // Stringify to the canonical numeric form (matches getAddressBalances'
                // other consumer in getBalancesForAddress).
                bySymbol[symbol] = String(flat[tick_id]);
                // Load token metadata once per referenced symbol (getTokenInfo
                // returns false when the tick does not exist at this action_index).
                if(tokenInfo[symbol] === undefined){
                    let info = await this.getTokenInfo(symbol, blockIndex, actionIndex);
                    if(info)
                        tokenInfo[symbol] = info;
                }
            }
            balances[address] = bySymbol;
        }

        return { balances, tokenInfo };
    },

};
