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
 * XChain Platform - DEPLOY: running the constructor
 *
 * Decides whether the contract's initialize runs, runs it in the VM as a
 * root execution, and clamps the gas it reports. A part of
 * actions/deploy/index.js, run by runDeployment once every check has passed
 * and the derived address exists. The constructor's state writes and
 * emissions are constructor_effects.js.
 *
 ********************************************************************/

const crypto = require('crypto');
// Per-root discriminator for the ATTEST request_id / XCALL call_id preimages, shared
// with execute.js so a constructor's emissions derive ids the same way an EXECUTE's do.
const { resolveRootDiscriminator } = require('../../consensus/batch_root_discriminator.js');
const { GAS_CEILING } = require('./constants.js');

/**
 * Decide whether the constructor runs and resolve its root discriminator.
 *
 * @param {Deploy} deploy  the DEPLOY handler (actions)
 * @param {object} run     the deployment's run state (mutated: totalGas, constructorError,
 *                         constructorResult, runConstructor, rootDiscrim)
 */
async function planConstructor(deploy, run){
    let data = run.data;

    /*****************************************************************
     * Constructor Execution
     ****************************************************************/

    run.totalGas = run.gasCost;
    run.constructorError = null;
    run.constructorResult = null;

    // When does the constructor run? Below DEPLOY_INIT_STRICT: only when
    // CONSTRUCTOR_PARAMS is non-empty (legacy truthy), so a contract exporting
    // `initialize` deployed with no params silently never initialised (the no-init
    // footgun) yet still committed 'valid'. At/after the flag-day: run
    // `initialize` whenever the contract exports it, regardless of params. This
    // makes the constructor impossible to silently skip - a zero-arg initialize
    // runs with no args, and an arg-expecting one deployed with none throws inside
    // execute() and REJECTS the deploy (constructorResult.success handling below)
    // instead of committing an uninitialised contract. Gate on the LOCAL block time
    // (mainnet 2026-08-07 cohort, = the CONTROLLER_GUARD / VM_BANNED_ASYNC contract-era
    // timestamp 1786060800 in protocol_changes.js); below it the trigger is byte-identical
    // to today.
    let initStrict = await deploy.actions.protocolChanges.isEnabled('DEPLOY_INIT_STRICT', data['BLOCK_INDEX']);
    run.runConstructor = initStrict ? (run.hasInitialize || !!run.constructorParams) : !!run.constructorParams;

    // Per-root discriminator for the constructor's subtree: a DEPLOY inside a BATCH
    // shares the transaction's single TX_VOUT with every sibling subcommand, so it
    // carries the subcommand position to stay distinct from theirs (flag-day gated,
    // src/consensus/batch_root_discriminator.js). Resolved ONCE and used by BOTH the
    // constructor's vm.execute and its emission context, which must agree exactly.
    run.rootDiscrim = await resolveRootDiscriminator(deploy.actions.protocolChanges, data['BLOCK_INDEX'], data['TX_VOUT'], data['BATCH_POSITION']);
}

/**
 * Run the constructor when the deploy needs one and the VM is available.
 *
 * @param {Deploy} deploy  the DEPLOY handler (actions.vm)
 * @param {object} run     the deployment's run state (mutated: constructorResult, totalGas,
 *                         constructorError, error)
 */
async function executeConstructor(deploy, run){
    let data = run.data;
    // Run the contract's constructor now, if this deploy needs one and the VM is available
    if(!run.error && run.runConstructor && deploy.actions.vm){
        // Derive deterministic block hash
        let blockHash = crypto.createHash('sha256')
            .update(String(data['BLOCK_INDEX']) + ':' + String(data['BLOCK_TIME']))
            .digest('hex');

        let vmLedger = await constructorLedger(deploy, run);
        run.constructorResult = await callConstructor(deploy, run, blockHash, vmLedger);
        settleConstructorOutcome(run);
    }
}

/**
 * The balances and token info the constructor's gateway sees.
 *
 * @param {Deploy} deploy  the DEPLOY handler (actions, indexerDb)
 * @param {object} run     the deployment's run state
 * @returns {Promise<{balances: ?object, tokenInfo: ?object}>}
 */
async function constructorLedger(deploy, run){
    let data = run.data;
    // SOURCE balances back getBalance() in the constructor (e.g. a deploy-time
    // permission gate). The contract's own derived address is freshly created
    // here, so its balance is empty; getBalance(contractAddress, ...) is null.
    // Gated on the VM_BALANCE_TOKENINFO flag-day: below activation the gateway
    // sees balances:null / tokenInfo:null (original ≤2.7.10 behaviour).
    let vmLedger = { balances: null, tokenInfo: null };
    if(await deploy.actions.protocolChanges.isEnabled('VM_BALANCE_TOKENINFO', data['BLOCK_INDEX'])){
        vmLedger = await deploy.indexerDb.buildVmBalancesAndTokenInfo(
            [data['SOURCE'], run.contractAddress], data['BLOCK_INDEX'], data['ACTION_INDEX']
        );
    }
    return vmLedger;
}

/**
 * The constructor's vm.execute call: a root execution of `initialize`.
 *
 * @param {Deploy} deploy     the DEPLOY handler (actions, config, indexerDb, providerDeadlineWindows)
 * @param {object} run        the deployment's run state
 * @param {string} blockHash  the deterministic block hash for the block context
 * @param {{balances: ?object, tokenInfo: ?object}} vmLedger  the gateway's ledger view
 * @returns {Promise<object>} the VM result
 */
async function callConstructor(deploy, run, blockHash, vmLedger){
    let data = run.data;
    let constructorParams = run.constructorParams;
    return await deploy.actions.vm.execute({
        code:             run.code,
        state:            {},
        method:           'initialize',
        // Empty CONSTRUCTOR_PARAMS => zero args ([]), not ['']. ''.split('|')
        // would pass a single empty-string arg; under DEPLOY_INIT_STRICT a
        // params-less constructor must receive no args.
        params:           constructorParams ? constructorParams.split('|') : [],
        caller:           data['SOURCE'],
        contractAddress:  run.contractAddress,
        contractIndex:    data['ACTION_INDEX'],
        // The tx hash + root action index + empty call-path anchor the
        // deterministic attestation request_id:
        //   sha256(txHash:rootActionIndex:callPath:contractIndex:emissionIndex)
        // A constructor is a root execution, so its call-path is ''
        // (same as a top-level user EXECUTE).
        txHash:           data['TX_HASH'],
        actionIndex:      data['ACTION_INDEX'],
        callPath:         '',
        // Root discriminator = the DEPLOY's on-chain output index (VM opt name), with the
        // BATCH subcommand position appended when this DEPLOY is one (flag-day gated).
        rootActionIndex:  run.rootDiscrim,
        // A constructor is a root execution: emitted cross-contract calls
        // run at depth 1, same as calls emitted by a user EXECUTE.
        callDepth:        0,
        // Explicit top-level ceiling: a constructor is a root
        // execution, so it runs under the same GAS_CEILING as a top-level
        // EXECUTE. Passing it explicitly (instead of relying on the VM's
        // constructor-time default) keeps the ceiling the clamp below
        // assumes (constructorGas = GAS_CEILING on resource termination)
        // bound to the ceiling the VM actually enforced.
        gasCeiling:       GAS_CEILING,
        blockContext: {
            height:    data['BLOCK_INDEX'],
            timestamp: data['BLOCK_TIME'],
            hash:      blockHash
        },
        balances:         vmLedger.balances,
        tokenInfo:        vmLedger.tokenInfo,
        network:          deploy.config['NETWORK'],
        oracleData:       await ((deploy.actions && deploy.actions.hubDb) || deploy.indexerDb).getOracleDataForVM(data['BLOCK_INDEX'], data['BLOCK_TIME'], parseInt(deploy.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800),
        crossChainData:   await deploy.indexerDb.getCrossChainDataForVM(data['BLOCK_INDEX']),
        // Expose each poll's electorate TICK in the VM snapshot at/after the flag-day.
        pollData:         await deploy.indexerDb.getPollResultsForVM(data['BLOCK_INDEX'], await deploy.actions.protocolChanges.isEnabled('VOTE_POLL_TICK_VISIBLE', data['BLOCK_INDEX'])),
        providerDeadlines: deploy.providerDeadlineWindows
    });
}

/**
 * Clamp the constructor's gas into totalGas and turn a failure into the deploy's verdict.
 *
 * @param {object} run  the deployment's run state (mutated: totalGas, constructorError, error)
 */
function settleConstructorOutcome(run){
    let constructorResult = run.constructorResult;
    // Defense-in-depth (consensus): mirror the gasUsed clamp in actions/execute/index.js so a
    // resource termination in the constructor can never cause totalGas (hashed via
    // contract_executions.gas_used into contract_hash) to diverge across validators. The
    // VM already clamps these; this guards a VM regression. Keep the family regex
    // identical to util.vmFailureStatus and execute.js (out_of_gas included so the
    // regexes never drift; it is a no-op for the fee since out_of_gas == ceiling already).
    let constructorGas = constructorResult.gasUsed;
    if(!constructorResult.success && /^(out_of_gas|timeout|out_of_memory|out_of_stack|out_of_resource)\b/.test(String(constructorResult.error)))
        constructorGas = GAS_CEILING;
    run.totalGas += constructorGas;

    if(!constructorResult.success){
        run.constructorError = 'constructor failed: ' + constructorResult.error;
        run.error = 'invalid: ' + run.constructorError;
    }
}

module.exports = { planConstructor, executeConstructor };
