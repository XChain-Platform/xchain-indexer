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
 * XChain Indexer - Database mixin: contracts
 * 
 * The queries over the contracts table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// Load required libraries
const mariadb = require('mariadb');
const path    = require('path');
// The state-key binary collation flag day is a registry row read by literal key (W5),
// keyed '<COIN>:<network>' so the coin goes with the height.
const gateRegistry = require('../../consensus/gate_registry');
const STATE_KEY_COLLATION_KEY = 'state_key_collation_activation.STATE_KEY_COLLATION_ACTIVATION';
// The contracts mixin is cut into parts by behaviour under contracts/; this entry merges them
// back into the one method set db/index.js installs, at the position those methods held here.
const stakes             = require('./stakes.js');
const delegationRotation = require('./delegation_rotation.js');
const stakeSnapshot      = require('./vm_stake_snapshot.js');
const slash              = require('./slash.js');
const cooldowns          = require('./cooldowns.js');

module.exports = {

    ...stakes,
    ...delegationRotation,
    ...stakeSnapshot,
    ...slash,
    ...cooldowns,

    /*
     * VM action methods
     */

    // Create/Update record in `contracts` table
    async createContract(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let source_id    = await this.getAddressId(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        let code         = data['CODE'];
        let code_hash    = data['CODE_HASH'];
        let api_version  = data['API_VERSION'] || 1;
        let block_index  = data['BLOCK_INDEX'];
        // DEPLOY v1+ staking config (NULL when contract is not opted into contract-staking)
        let cooldown_blocks = (this.util.isNull(data['COOLDOWN_BLOCKS'])) ? null : Number(data['COOLDOWN_BLOCKS']);
        let slash_destination_id = null;
        if(!this.util.isNull(data['SLASH_DESTINATION'])){
            slash_destination_id = await this.createAddress(data['SLASH_DESTINATION']);
        }
        // Contract meta manifest (CONTRACT_META_REQUIRED). deploy.js hands these over only
        // for a valid deploy whose exported meta conforms to the byte grammar, so an absent
        // key is a NULL column and an oversized value never reaches VARCHAR(64) at all - the
        // write site, not the column width, is what keeps errno 1406 out of the indexer.
        let meta_name        = (this.util.isNull(data['META_NAME']))        ? null : data['META_NAME'];
        let meta_description = (this.util.isNull(data['META_DESCRIPTION'])) ? null : data['META_DESCRIPTION'];
        let meta_version     = (this.util.isNull(data['META_VERSION']))     ? null : data['META_VERSION'];
        let meta_json        = (this.util.isNull(data['META_JSON']))        ? null : data['META_JSON'];
        let query  = "SELECT action_index FROM contracts WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contracts SET
                        source_id=?, code=?, code_hash=?, api_version=?, status_id=?, block_index=?,
                        cooldown_blocks=?, slash_destination_id=?,
                        meta_name=?, meta_description=?, meta_version=?, meta_json=?
                    WHERE action_index=?`;
            args = [source_id, code, code_hash, api_version, status_id, block_index,
                    cooldown_blocks, slash_destination_id,
                    meta_name, meta_description, meta_version, meta_json, action_index];
        } else {
            query = `INSERT INTO contracts
                        (source_id, code, code_hash, api_version, status_id, block_index,
                         cooldown_blocks, slash_destination_id,
                         meta_name, meta_description, meta_version, meta_json, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, code, code_hash, api_version, status_id, block_index,
                    cooldown_blocks, slash_destination_id,
                    meta_name, meta_description, meta_version, meta_json, action_index];
        }
        await this.doQuery(query, args);
    },

    // Get contract by action_index
    async getContract(action_index){
        let query = `SELECT * FROM contracts WHERE action_index=? LIMIT 1`;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0)
            return results[0];
        return null;
    },

    // Find the UNCONSUMED pending assembler of a chunked-DEPLOY group (same deployer,
    // same code_hash) at a LOWER action_index than the action asking (DEPLOY_DEFERRED_
    // ASSEMBLY, R1/R2). A pending assembler is a contracts row whose status is the
    // pending string, written once at the assembler's index and never mutated; it is
    // consumed iff some contract_executions row names it in assembler_action_index (the
    // row the completing action writes unconditionally), so consumption is a NOT EXISTS
    // and rollback of the completing action un-consumes it by construction. Returns the
    // wire parameters the deployment at the completing action needs (gas_limit and
    // input_params from the assembler's execution row, cooldown_blocks and the resolved
    // slash_destination_id from its contracts row, the mode it paid its base fee in) or
    // null when the group has no pending assembler. Lowest action_index wins so every
    // node picks the same one; the duplicate-pending rejection in deploy.js means there
    // is at most one anyway.
    async getPendingDeployAssembler(source, codeHash, beforeActionIndex){
        let source_id = await this.getAddressId(source);
        if(source_id === null) return null;
        let query = `SELECT c.action_index, c.block_index, c.code_hash, c.cooldown_blocks, c.slash_destination_id,
                            ce.gas_limit, ce.input_params, ce.fee_payment_mode
                     FROM contracts c
                     INNER JOIN contract_executions ce ON (ce.action_index=c.action_index)
                     INNER JOIN index_statuses s ON (s.id=c.status_id)
                     WHERE c.source_id=? AND c.code_hash=? AND c.action_index < ?
                       AND s.status='pending: CODE_HASH (awaiting chunks)'
                       AND NOT EXISTS (SELECT 1 FROM contract_executions x WHERE x.assembler_action_index=c.action_index)
                     ORDER BY c.action_index ASC
                     LIMIT 1`;
        let results = await this.doQuery(query, [source_id, codeHash, beforeActionIndex]);
        return results.length > 0 ? results[0] : null;
    },

    // Persist a contract's declared permissions manifest (Phase E). Upsert keyed on
    // the DEPLOY action_index (the rollback key) - mirrors createContract. PERMISSIONS
    // is the validated array of permitted emission action types (stored as JSON) or
    // null when the contract declared none (unrestricted); MAX_TAKE_BPS is the tighter
    // per-contract royalty cap or null (global cap applies). deploy.js validates both
    // before calling this; deleteContract clears the row on a failed deploy.
    async createContractPermission(data){
        // Capture the permissions ARRAY before normalizeDataValues runs: that routine
        // safeToString()s every object-typed field, which coerces an array to a
        // comma-joined string ('SEND,ISSUE') - JSON.stringify would then persist
        // '"SEND,ISSUE"' instead of '["SEND","ISSUE"]', and getContractPermissions'
        // Array.isArray check would read it back as a non-array and SILENTLY disable
        // the emission allowlist. Stringify the raw array here so the JSON is intact.
        let permsRaw       = data['PERMISSIONS'];
        data               = this.normalizeDataValues(data);
        let action_index   = data['ACTION_INDEX'];
        let contract_index = data['CONTRACT_INDEX'];
        let permissions    = this.util.isNull(permsRaw)            ? null : JSON.stringify(permsRaw);
        let max_take_bps   = this.util.isNull(data['MAX_TAKE_BPS']) ? null : Number(data['MAX_TAKE_BPS']);
        let block_index    = data['BLOCK_INDEX'];
        let query  = "SELECT action_index FROM contract_permissions WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_permissions SET
                        contract_index=?, permissions=?, max_take_bps=?, block_index=?
                    WHERE action_index=?`;
            args = [contract_index, permissions, max_take_bps, block_index, action_index];
        } else {
            query = `INSERT INTO contract_permissions
                        (contract_index, permissions, max_take_bps, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?)`;
            args = [contract_index, permissions, max_take_bps, block_index, action_index];
        }
        await this.doQuery(query, args);
    },

    // Read a contract's persisted permissions manifest (Phase E). Returns
    //   { permissions: string[]|null, maxTakeBps: number|null }
    // or null when the contract declared no manifest (no row) - the unrestricted,
    // backward-compatible default the callers (processEmission / runControllerGuard)
    // treat as "no per-contract restriction". permissions is JSON-parsed back to an
    // array; a NULL column stays null (unrestricted).
    async getContractPermissions(contractIndex){
        let query = `SELECT permissions, max_take_bps FROM contract_permissions WHERE contract_index=? LIMIT 1`;
        let results = await this.doQuery(query, [contractIndex]);
        if(results.length === 0)
            return null;
        let row = results[0];
        let permissions = null;
        if(!this.util.isNull(row.permissions)){
            try { permissions = JSON.parse(row.permissions); } catch(e){ permissions = null; }
        }
        let maxTakeBps = this.util.isNull(row.max_take_bps) ? null : Number(row.max_take_bps);
        return { permissions, maxTakeBps };
    },

    // Create record in `contract_executions` table
    async createContractExecution(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let caller_id    = await this.getAddressId(data['CALLER']);
        let action_index = data['ACTION_INDEX'];
        let contract_index = data['CONTRACT_INDEX'];
        let method_name  = data['METHOD_NAME'];
        let input_params = data['INPUT_PARAMS'];
        let gas_used     = data['GAS_USED'];
        let gas_limit    = data['GAS_LIMIT'];
        let error_message = data['ERROR_MESSAGE'];
        let emitted_count = data['EMITTED_COUNT'] || 0;
        let block_index  = data['BLOCK_INDEX'];
        // Deferred chunked-DEPLOY fields (DEPLOY_DEFERRED_ASSEMBLY): the pending
        // assembler this constructor row consumed (NULL for inline and self-completed
        // deploys, and for every non-DEPLOY execution) and the fee mode a DEPLOY
        // constructor row's base fee was paid in (1 native, 2 XCHAIN; NULL before the
        // flag day and for non-DEPLOY rows). Neither enters a block-hash preimage.
        let assembler_action_index = this.util.isNull(data['ASSEMBLER_ACTION_INDEX']) ? null : data['ASSEMBLER_ACTION_INDEX'];
        let fee_payment_mode = this.util.isNull(data['FEE_PAYMENT_MODE']) ? null : data['FEE_PAYMENT_MODE'];
        let query  = "SELECT action_index FROM contract_executions WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_executions SET
                        contract_index=?, caller_id=?, method_name=?, input_params=?,
                        gas_used=?, gas_limit=?, status_id=?, error_message=?,
                        emitted_count=?, block_index=?,
                        assembler_action_index=?, fee_payment_mode=?
                    WHERE action_index=?`;
            args = [contract_index, caller_id, method_name, input_params,
                    gas_used, gas_limit, status_id, error_message,
                    emitted_count, block_index,
                    assembler_action_index, fee_payment_mode, action_index];
        } else {
            query = `INSERT INTO contract_executions
                        (contract_index, caller_id, method_name, input_params,
                         gas_used, gas_limit, status_id, error_message,
                         emitted_count, block_index,
                         assembler_action_index, fee_payment_mode, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [contract_index, caller_id, method_name, input_params,
                    gas_used, gas_limit, status_id, error_message,
                    emitted_count, block_index,
                    assembler_action_index, fee_payment_mode, action_index];
        }
        await this.doQuery(query, args);
    },

    /*****************************************************************
     * VM Integration - Contract State
     ****************************************************************/

    // Get the current state of a contract as a { key: value } object.
    // `blockIndex` is the block being processed and drives the state_key
    // collation flag-day (state_key_collation_activation.js): contract_state is
    // utf8_general_ci, so the legacy GROUP BY folds distinct keys like
    // "Key"/"key" into ONE group and the reload drops one of them - the key
    // vanishes on the next EXECUTE despite the null-prototype round-trip
    // contract below. At/after the activation height the reload groups by
    // state_key_bin (the utf8_bin generated shadow of state_key, byte-identical
    // rows to GROUP BY state_key COLLATE utf8_bin but index-backed via
    // idx_latest_bin) so every distinct key survives reload; below it (or when
    // no blockIndex is supplied) the legacy folding form is kept so historical
    // re-execution stays byte-identical.
    async getContractState(contractIndex, blockIndex){
        // Get the latest row per key using MAX(id)
        // The idx_latest index (contract_index, state_key, id DESC) makes this efficient
        let stateKeyBin = (blockIndex !== undefined) && gateRegistry.activeAt(STATE_KEY_COLLATION_KEY,
            this.config['NETWORK'], this.config['COIN'], blockIndex, null);
        let query = `SELECT cs.state_key, cs.state_value
                     FROM contract_state cs
                     INNER JOIN (
                         SELECT MAX(id) as max_id
                         FROM contract_state
                         WHERE contract_index = ?
                         GROUP BY ` + (stateKeyBin ? 'state_key_bin' : 'state_key') + `
                     ) latest ON cs.id = latest.max_id
                     WHERE cs.state_value IS NOT NULL`;
        let results = await this.doQuery(query, [contractIndex]);
        // Null-prototype object so adversarial keys round-trip faithfully. A
        // plain {} would route state['__proto__'] = value through the __proto__
        // setter - a no-op for non-object values (silently dropping the key) or
        // a prototype reassignment for object values. The VM's StateManager
        // already uses Object.create(null) and lets contracts state.set('__proto__'),
        // so the reload path must preserve it too, else that key vanishes on the
        // next EXECUTE.
        let state = Object.create(null);
        for(let row of results){
            try {
                state[row.state_key] = JSON.parse(row.state_value);
            } catch(e){
                state[row.state_key] = row.state_value;
            }
        }
        return state;
    },

    // Append a new state row (append-only - rollback via DELETE WHERE block_index >= ?)
    async createContractState(data){
        let query = `INSERT INTO contract_state
                        (contract_index, state_key, state_value, block_index, action_index)
                     VALUES (?, ?, ?, ?, ?)`;
        let args = [
            data['CONTRACT_INDEX'],
            data['STATE_KEY'],
            data['STATE_VALUE'],
            data['BLOCK_INDEX'],
            data['ACTION_INDEX']
        ];
        await this.doQuery(query, args);
    },

    // How many contract_emissions rows an execution has already recorded. Guard emissions
    // share their host action's execution_index, so a caller offsets its next position by
    // this count to keep (execution_index, position) globally unique; that is what makes
    // the read-side ORDER BY a total order with no engine-dependent tie-break, and so no
    // fork. Runs on the caller's connection, which is inside the guard's savepoint: a
    // rolled-back guard's emissions must not be counted, or positions gap and diverge.
    async countContractEmissionsForExecution(executionIndex){
        let results = await this.doQuery(
            'SELECT COUNT(*) AS cnt FROM contract_emissions WHERE execution_index=?',
            [executionIndex]);
        return (results.length > 0) ? Number(results[0].cnt) : 0;
    },

    // Create a record in contract_emissions
    async createContractEmission(data){
        let query = `INSERT INTO contract_emissions
                        (execution_index, emitted_action, action_index, position)
                     VALUES (?, ?, ?, ?)`;
        let args = [
            data['EXECUTION_INDEX'],
            data['EMITTED_ACTION'],
            data['ACTION_INDEX'],
            data['POSITION']
        ];
        await this.doQuery(query, args);
    },

    // Delete a contract record (for constructor failure rollback)
    async deleteContract(actionIndex){
        let query = `DELETE FROM contracts WHERE action_index=?`;
        await this.doQuery(query, [actionIndex]);
        // A contract's permissions manifest (Phase E) is persisted under the same
        // DEPLOY action_index, so a failed/cleaned-up deploy must drop it too.
        await this.doQuery(`DELETE FROM contract_permissions WHERE action_index=?`, [actionIndex]);
    },

};
