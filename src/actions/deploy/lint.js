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
 * XChain Platform - DEPLOY: the VM syntax and lint gate
 *
 * Fails closed when the VM executor is missing, then lints the contract
 * source under the rule set THIS block's activations select. A part of
 * actions/deploy/index.js, run by runDeployment before any gas is charged.
 *
 ********************************************************************/

// Both deploy-lint gates are registry rows read by literal key (W4); the key
// spellings below are the markers bin/check-flagday-deploy.sh greps this file for.
const gateRegistry = require('../../consensus/gate_registry');

/**
 * Throw the EXECUTOR_UNAVAILABLE host fault when a deploy would need the VM and it is absent.
 *
 * @param {Deploy} deploy  the DEPLOY handler (actions.vm)
 * @param {object} run     the deployment's run state
 */
function assertExecutorAvailable(deploy, run){

    /*****************************************************************
     * VM Syntax Validation (before charging gas)
     ****************************************************************/

    // Fail CLOSED when the VM executor is unavailable, exactly as the
    // execute paths do (execute.js: the EXECUTE VM block and
    // runControllerGuard both throw this same code).
    // Without this, a node whose optional `require('xchain-vm')` failed
    // (actions/index.js sets this.vm=null and only warns) would SKIP the entire
    // syntax/lint/consensus gate below plus the manifest read and record
    // the deploy VALID, while the rest of the fleet rejects it: a
    // host-condition-induced ledger divergence (fail-open). Throwing an
    // EXECUTOR_UNAVAILABLE host fault instead writes NO verdict at all:
    // faultGuard.rethrowIfInfraFault treats this code as an infra halt, so
    // the block loop rolls back and retries without committing until the
    // native VM is rebuilt. No consensus rule changes, so no flag-day is
    // needed - a healthy node validates exactly as before.
    if(!run.error && !run.heldVerdict && !deploy.actions.vm){
        let e = new Error('deploy VM executor unavailable');
        e.code = 'EXECUTOR_UNAVAILABLE';
        throw e;
    }
}

/**
 * The consensus lint rule set for this DEPLOY's block, one flag per gated rule.
 *
 * @param {Deploy} deploy  the DEPLOY handler (actions, config)
 * @param {object} data    the DEPLOY's transaction context
 * @returns {Promise<object>} the validateSyntax options, in the order the VM reads them
 */
async function resolveLintFlags(deploy, data){
    // banned-async (async/await/Promise) is a consensus-gated deploy rule:
    // below the VM_BANNED_ASYNC flag-day such a contract was ACCEPTED, so a
    // from-genesis replay must reproduce that historical verdict. Resolve the
    // activation for THIS block and pass it through; all other consensus rules
    // are always enforced.
    let enforceBannedAsync = await deploy.actions.protocolChanges.isEnabled('VM_BANNED_ASYNC', data['BLOCK_INDEX']);
    // The VM_LINT_HARDENING rule set (flag-day Pkg 4) is gated the same
    // way: below its activation a deploy resolves exactly as it did
    // historically (both gates share the same contract-era activation).
    let enforceLintHardening = await deploy.actions.protocolChanges.isEnabled('VM_LINT_HARDENING', data['BLOCK_INDEX']);
    // banned-generator (29912bd8) + banned-wasm (75190596 deploy half) are the
    // Package 3 deploy-lint legs. They share ONE gate with the VM-side runtime
    // strips (xchain-vm PKG3_SANDBOX_ACTIVATION), keyed per-coin on block HEIGHT
    // (not block-time, so it cannot ride protocolChanges.isEnabled, which has no
    // coin dimension); resolved via the standalone activation module the same
    // shape as dispenser_freshness. Below each coin's height both flags are false,
    // so validateSyntax drops both rules and the historical accepted verdict
    // replays byte-identically. Both threaded exactly like the two flags above.
    let enforcePkg3DeployLint = gateRegistry.activeAt('vm_deploy_lint_pkg3_activation.VM_DEPLOY_LINT_PKG3_ACTIVATION', deploy.config['NETWORK'], deploy.config['COIN'], data['BLOCK_INDEX'], null);
    let enforceBannedGenerator = enforcePkg3DeployLint;
    let enforceBannedWasm = enforcePkg3DeployLint;
    // The global-alias refinement of banned-async + banned-wasm + banned-math
    // (sloppy-mode `this` and the globalThis self-reference chain both read the
    // global binding) rides a THIRD, per-coin height gate of its own. The one
    // resolved boolean below widens all three rules: banned-math reaches the same
    // global object through its own matcher (xchain-vm isMathObjectRef), whose
    // object leg resolves through isGlobalObjectRef under this epoch. It cannot ride
    // either gate above: VM_LINT_HARDENING is already open on every network and
    // the Pkg 3 heights are in the past, so reusing either would retroactively
    // reject contracts the chain already accepted. Mainnet is ARMED at genesis
    // by the 2026-09-09 ruling (identity on the indexed mainnet history: 0
    // contracts, 0 DEPLOY, measured 2026-09-09), so this resolves true there
    // from block 0 and no already-accepted deploy is reinterpreted.
    let enforceLintGlobalAlias = gateRegistry.activeAt('vm_lint_global_alias_activation.VM_LINT_GLOBAL_ALIAS_ACTIVATION', deploy.config['NETWORK'], deploy.config['COIN'], data['BLOCK_INDEX'], null);
    // banned-rest (unmeterable rest positions) is the deploy half of
    // REST_PATTERN_METER. Its VM twin wraps a top-level rest's source in the
    // size-charged helper; the positions with no addressable source cannot be
    // metered and are refused here instead. Keyed on block_TIME through
    // protocolChanges like the two gates above, NOT on the contract-era instant:
    // that one is in the past and reusing it would retroactively reject contracts
    // the chain already accepted. Below the flag day the rule is dropped and the
    // historical verdict replays byte-identically.
    let enforceBannedRest = await deploy.actions.protocolChanges.isEnabled('REST_PATTERN_METER', data['BLOCK_INDEX']);
    return { enforceBannedAsync, enforceLintHardening, enforceBannedGenerator, enforceBannedWasm, enforceLintGlobalAlias, enforceBannedRest };
}

/**
 * Lint the contract source and collect its non-blocking float warnings.
 *
 * @param {Deploy} deploy  the DEPLOY handler (actions.vm)
 * @param {object} run     the deployment's run state (mutated: error, floatWarnings)
 */
async function lintContractCode(deploy, run){
    // A held verdict skips every VM gate below: there is no assembled source to lint or read
    // a manifest from (the pending assembler's `code` is empty), and running the gates on
    // empty bytes would let a lint verdict pre-empt the pending landing.
    run.floatWarnings = [];
    // Check the contract's code for syntax and safety problems using the VM, skipped for a held pending deploy
    if(!run.error && !run.heldVerdict && deploy.actions.vm){
        let lintFlags = await resolveLintFlags(deploy, run.data);
        let syntaxResult = deploy.actions.vm.validateSyntax(run.code, lintFlags);
        if(!syntaxResult.valid)
            run.error = 'invalid: CODE_ENCODING (' + syntaxResult.error + ')';

        // Non-blocking float warnings (logged in execution record)
        if(!run.error)
            run.floatWarnings = deploy.actions.vm.checkFloatWarnings(run.code);
    }
}

module.exports = { assertExecutorAvailable, lintContractCode };
