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
 * XChain Platform - DEPLOY: the constructor's state and emissions
 *
 * Writes a successful constructor's state changes and routes its emitted
 * actions through the same pipeline an EXECUTE's take, all under one
 * savepoint, so a failure part-way unwinds to a clean invalid deploy. A
 * part of actions/deploy/index.js, run by runDeployment after the contract
 * rows exist.
 *
 ********************************************************************/

const { rethrowIfInfraFault } = require('../../consensus/fault_guard.js');
// A constructor may emit SLASH, so the writer is required from the shared module
// rather than borrowed off the Execute instance (see ../execute/slash_emission.js). Held as
// the module object, not destructured, so the call below resolves the export at call
// time and a suite can substitute the writer at that one seam.
const slashEmission = require('../execute/slash_emission.js');

/**
 * Apply a successful constructor's state and emissions under a savepoint.
 *
 * @param {Deploy} deploy  the DEPLOY handler (indexerDb, and `this` for the SLASH writer)
 * @param {object} run     the deployment's run state (mutated: nestedGasUnused, and on a
 *                         failure error and status)
 */
async function applyConstructorEffects(deploy, run){
    let data = run.data;

    // Process constructor state changes and emissions if successful.
    // Emissions route through the SAME pipeline as EXECUTE emissions
    // (Execute.processEmission): real action rows, contract-derived SOURCE,
    // cross-contract EXECUTE support with depth/gasLimit threading. The
    // savepoint name is unique per deployment because an emitted EXECUTE
    // nests its own vm_execute_<idx> savepoints inside this one (MariaDB
    // destroys a re-used savepoint name; see actions/execute/index.js).
    run.nestedGasUnused = 0;
    if(run.constructorResult && run.constructorResult.success){
        let savepoint = await deploy.indexerDb.createSavepoint('vm_constructor_' + parseInt(data['ACTION_INDEX']));
        try {
            await writeConstructorState(deploy, run);
            await processConstructorEmissions(deploy, run);

            await deploy.indexerDb.releaseSavepoint(savepoint);
        } catch(e){
            await deploy.indexerDb.rollbackToSavepoint(savepoint);
            // An infrastructure fault (VM host fault, transient DB error) is not a
            // constructor outcome: halt so the block rolls back and retries rather than
            // deleting the contract and committing a validator-local 'invalid' deploy.
            rethrowIfInfraFault(e);
            // Constructor state/emission processing failed. The whole deployment
            // fails (no refunds; the deployer pays full gas).
            run.nestedGasUnused = 0;
            run.error = 'invalid: constructor state write failed: ' + e.message;
            run.status = run.error;
            data['STATUS'] = run.status;
            await deploy.indexerDb.deleteContract(data['ACTION_INDEX']);
        }
    }
}

/**
 * The constructor's state changes and deletes, as contract_state rows.
 *
 * @param {Deploy} deploy  the DEPLOY handler (indexerDb)
 * @param {object} run     the deployment's run state
 */
async function writeConstructorState(deploy, run){
    let data = run.data;
    for(let change of run.constructorResult.stateChanges){
        await deploy.indexerDb.createContractState({
            CONTRACT_INDEX: data['ACTION_INDEX'],
            STATE_KEY:      change.key,
            STATE_VALUE:    JSON.stringify(change.value),
            BLOCK_INDEX:    data['BLOCK_INDEX'],
            ACTION_INDEX:   data['ACTION_INDEX']
        });
    }
    for(let key of run.constructorResult.stateDeletes){
        await deploy.indexerDb.createContractState({
            CONTRACT_INDEX: data['ACTION_INDEX'],
            STATE_KEY:      key,
            STATE_VALUE:    null,
            BLOCK_INDEX:    data['BLOCK_INDEX'],
            ACTION_INDEX:   data['ACTION_INDEX']
        });
    }
}

/**
 * The execution context the constructor's emissions run under.
 *
 * @param {object} run  the deployment's run state
 * @returns {object} the emission context
 */
function constructorEmissionContext(run){
    let data = run.data;
    // Constructor emissions. executionData mirrors what an EXECUTE
    // would carry: the new contract is the emitter, the DEPLOY's own
    // action_index is the executing action (parent for CALL_DEPTH), and the
    // deployer pays fees. A constructor is a root execution, so its call-path
    // is '' (emitted ATTEST request_ids derive over
    // (txHash:rootActionIndex:callPath:contractIndex:emissionIndex) with
    // callPath '', matching the VM's constructor run at callPath '').
    return {
        CONTRACT_ACTION_INDEX: data['ACTION_INDEX'],
        ACTION_INDEX:          data['ACTION_INDEX'],
        // Root discriminator for constructor emissions (key attest.js/xcall.js read).
        // MUST be the identical value the constructor's vm.execute was handed above.
        ROOT_ACTION_INDEX:     run.rootDiscrim,
        SOURCE:                data['SOURCE'],
        BLOCK_INDEX:           data['BLOCK_INDEX'],
        BLOCK_TIME:            data['BLOCK_TIME'],
        TX_INDEX:              data['TX_INDEX'],
        TX_HASH:               data['TX_HASH'],
        TX_VOUT:               data['TX_VOUT'],
        CALL_PATH:             '',
        CALL_DEPTH:            0,
        IS_CONSTRUCTOR:        true,  // cross-chain calls are disallowed from constructors (v1)
        // Constructor emissions draw from the DEPLOY transaction's top-level
        // issuance budget (EMISSION_ISSUANCE_LIMITS). A constructor is a
        // VM path to the ISSUE handler like any other, and a BATCH may carry a
        // DEPLOY beside EXECUTEs, so all of them must share one tally.
        ISSUANCE_LIMIT_LEDGER: data['ISSUANCE_LIMIT_LEDGER']
    };
}

/**
 * Route each emitted action and record its contract_emissions row.
 *
 * @param {Deploy} deploy  the DEPLOY handler (actions, indexerDb; `this` for the SLASH writer)
 * @param {object} run     the deployment's run state (mutated: nestedGasUnused)
 */
async function processConstructorEmissions(deploy, run){
    let data = run.data;
    let constructorResult = run.constructorResult;
    let emissionContext = constructorEmissionContext(run);
    for(let i = 0; i < constructorResult.emittedActions.length; i++){
        let emission = constructorResult.emittedActions[i];

        if(emission.action === 'SLASH'){
            // Inline like actions/execute (never on-wire). A just-deployed
            // contract has no stakes, so this is a structural no-op,
            // kept for pipeline parity. The writer is the shared module
            // rather than the Execute instance so the two entry points
            // cannot drift and neither action requires the other; `this`
            // carries the same indexerDb/util/config aliases Execute holds.
            await slashEmission.processSlashEmission.call(deploy, emission, emissionContext);
        } else {
            await deploy.actions.actionExecute.processEmission(emission, emissionContext, i);
            // Bank a cross-contract callee's unused reservation for
            // the fee settlement below.
            if(emission.action === 'EXECUTE')
                run.nestedGasUnused += Number(emission.gasUnusedSubtree) || 0;
        }

        await deploy.indexerDb.createContractEmission({
            EXECUTION_INDEX: data['ACTION_INDEX'],
            EMITTED_ACTION:  emission.action,
            ACTION_INDEX:    emission.resultActionIndex || null,
            POSITION:        i
        });
    }
}

module.exports = { applyConstructorEffects };
