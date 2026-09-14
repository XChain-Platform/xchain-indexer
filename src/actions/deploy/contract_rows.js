/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Platform - DEPLOY: the contract's identity, verdict and rows
 *
 * The code hash and derived C:<CHAIN>:<index> address, the deploy's final
 * (consensus-hashed) status, and the contracts / contract_permissions rows
 * written from it. A part of actions/deploy/index.js, run by runDeployment
 * around the constructor.
 *
 ********************************************************************/

const crypto = require('crypto');
const { getLogger } = require('../../observability/index.js');

/**
 * The code hash and the contract's derived address, created once every check has passed.
 *
 * @param {Deploy} deploy  the DEPLOY handler (config, indexerDb)
 * @param {object} run     the deployment's run state (mutated: codeHash, contractAddress)
 */
async function deriveContractIdentity(deploy, run){
    let data = run.data;

    // A pending assembler stores the DECLARED hash, not sha256('') as an unassembled row
    // does today: that hash IS the group id the completing carrier looks it up by.
    run.codeHash = run.landedPending ? String(run.pendingCodeHash) : crypto.createHash('sha256').update(run.code).digest('hex');

    /*****************************************************************
     * Contract Derived Address
     ****************************************************************/

    // Create the contract's derived address (C:<CHAIN>:<action_index>)
    run.contractAddress = 'C:' + deploy.config['CHAIN'] + ':' + data['ACTION_INDEX'];
    // Only create the contract's address once every check above has passed
    if(!run.error)
        await deploy.indexerDb.createAddress(run.contractAddress);
}

/**
 * The deploy's final status, written to data['STATUS'] and logged.
 *
 * @param {Deploy} deploy  the DEPLOY handler (config, util)
 * @param {object} run     the deployment's run state (mutated: fee, status)
 */
function determineStatus(deploy, run){
    let data = run.data;
    let constructorResult = run.constructorResult;

    // Recalculate fee based on total gas (deploy + constructor)
    run.fee = deploy.util.bcmul(run.totalGas, deploy.config['GAS_PRICE'], 8);

    // Determine final status. This is consensus-hashed (contracts.status_id /
    // contract_executions.status_id into contract_hash), so it MUST be deterministic. A
    // failed constructor's raw VM error is timing-/memory-/arch-dependent (V8 abort vs
    // isolate wall-clock vs parent watchdog; see util.vmFailureStatus), so normalize it to
    // a stable token instead of storing the raw 'invalid: constructor failed: <vm error>'
    // string. Pre-VM rejections keep their deterministic 'invalid: ...' message; a clean
    // deploy is 'valid'. The raw detail is preserved (un-hashed) in
    // contract_executions.ERROR_MESSAGE below.
    let status;
    if(constructorResult && !constructorResult.success)
        status = deploy.util.vmFailureStatus(constructorResult.error);
    else if(run.error)
        status = run.error;
    else
        status = 'valid';
    run.status = status;
    data['STATUS'] = status;

    // Print status message
    getLogger().info("\t DEPLOY : hash=" + run.codeHash + ' : gas=' + run.totalGas +
        (run.floatWarnings.length > 0 ? ' : FLOAT_WARNINGS=' + run.floatWarnings.length : '') +
        ' : ' + data['STATUS']);
}

/**
 * The contracts row (removed again for a failed constructor) and the permissions row.
 *
 * @param {Deploy} deploy  the DEPLOY handler (indexerDb)
 * @param {object} run     the deployment's run state
 */
async function writeContractRows(deploy, run){
    let data = run.data;
    let status = run.status;

    // The meta columns are written ONLY for a valid deploy whose meta conforms; every
    // other deploy stores four NULLs. createContract runs for invalid deploys too, so
    // the write site (not the grammar) is what keeps an oversized or malformed value
    // out of a VARCHAR(64): sql_mode is not pinned in this tree, so an oversized value
    // is either errno 1406 and a forever-retried block on a strict node or a silent
    // truncation on a permissive one. Same gate as createContractPermission below.
    let storedMeta = (status === 'valid' && run.declaredMeta) ? run.declaredMeta : null;

    // Create record in contracts table
    await deploy.indexerDb.createContract({
        ACTION_INDEX      : data['ACTION_INDEX'],
        SOURCE            : data['SOURCE'],
        CODE              : run.code,
        CODE_HASH         : run.codeHash,
        API_VERSION       : 1,
        STATUS            : status,
        BLOCK_INDEX       : data['BLOCK_INDEX'],
        COOLDOWN_BLOCKS   : run.cooldownBlocks,
        SLASH_DESTINATION : run.slashDestination,
        META_NAME         : storedMeta ? storedMeta.name        : null,
        META_DESCRIPTION  : storedMeta ? storedMeta.description : null,
        META_VERSION      : storedMeta ? storedMeta.version     : null,
        META_JSON         : storedMeta ? storedMeta.json        : null
    });

    // If constructor failed, delete the contract record
    if(run.constructorError)
        await deploy.indexerDb.deleteContract(data['ACTION_INDEX']);

    // Persist the declared permissions manifest (Phase E) BEFORE the constructor
    // emissions are processed below, so a constructor's own emissions are checked
    // against the contract's allowlist too (enforced in execute.js processEmission,
    // which reads this row). Gated on a clean status: a later constructor-state
    // failure calls deleteContract, which also clears this row, keeping the manifest
    // table consistent with `contracts`. Written only when something was declared.
    if(status === 'valid' && (run.declaredPermissions !== null || run.declaredMaxTakeBps !== null)){
        await deploy.indexerDb.createContractPermission({
            ACTION_INDEX   : data['ACTION_INDEX'],
            CONTRACT_INDEX : data['ACTION_INDEX'], // contract_index = its own action_index
            PERMISSIONS    : run.declaredPermissions,
            MAX_TAKE_BPS   : run.declaredMaxTakeBps,
            BLOCK_INDEX    : data['BLOCK_INDEX']
        });
    }
}

module.exports = { deriveContractIdentity, determineStatus, writeContractRows };
