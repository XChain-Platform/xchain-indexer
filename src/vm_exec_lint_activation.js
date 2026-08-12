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
 * Execute-time consensus source-lint enforcement flag-day.
 *
 * Indexer-side registration of the activation the VM enforces at EXECUTE time.
 *
 * The problem it closes: every consensus source-lint ban (banned-async,
 * banned-generator, banned-wasm and the VM_LINT_HARDENING rule set) is checked only
 * when a contract DEPLOYS. deploy.js runs validateSyntax over the submitted source
 * and records the verdict; execute() then meters and runs the PERSISTED
 * contractInfo.code with no re-check, at all three of this repo's vm.execute call
 * sites (actions/execute.js root + emit.execute, actions/deploy.js constructor). So a
 * contract accepted before a ban activates keeps executing banned syntax forever
 * afterwards, which is precisely the state each ban exists to prevent (a live
 * banned-generator instance can still leak __stackDepth toward the 512 cap; a live
 * WebAssembly reference still runs unmetered native code on nodes that have not
 * applied the runtime strip).
 *
 * The remedy re-runs validateSyntax at execute time against the bans active for THAT
 * block and fails the execution deterministically when the stored source no longer
 * passes. That flips previously-succeeding executions into failures, so it needs its
 * OWN activation: the existing gates cannot be ridden. Both 1786060800 block-time
 * gates are already open on every network and the Pkg 3 heights are in the past, so
 * reusing either would retroactively rewrite settled history rather than gate a
 * future change.
 *
 * WHY THIS MODULE HAS NO CALL SITE. The gate lives entirely inside the VM, on the
 * PKG3_SANDBOX_ACTIVATION template: xchain-vm derives the coin from the
 * C:<COIN>:<action_index> contract address it is already passed, reads the height from
 * blockContext.height, and resolves the activation itself (isExecLintActive). No
 * indexer-side opts change is needed, and adding a second resolver here would create
 * the exact divergence surface the twin exists to prevent. This file is the indexer's
 * REGISTRATION of that consensus parameter: the value the fleet's operators read and
 * ratify on this side of the pair, pinned equal to the VM's map by
 * test/unit/vm_exec_lint_activation.test.js here and by the consensus-params suite in
 * xchain-vm. A height armed on one side only forks the fleet.
 *
 * *** NOT YET ARMED ON MAINNET. *** The operator ratified the MECHANISM on 2026-08-11
 * (execute-time enforcement, the validateSyntax verdict cached by the existing metering
 * sha256 key, its cost metered as gas) but still owes the concrete per-coin train
 * heights. `null` is the explicit unarmed sentinel: it resolves to inactive at every
 * mainnet height, so mainnet behaviour is byte-identical to today. Arming means filling
 * the ratified height into BOTH this map and xchain-vm's EXEC_LINT_ACTIVATION in the
 * same change, and deploying the fleet before the earliest of the three heights.
 * testnet + regtest are genesis-active: both are pre-launch and both already enforce
 * the identical rule set at deploy from genesis, so every contract that exists there
 * passes the execute-time check and the only observable change is the metered lint gas.
 *
 * Because it is an EXECUTION-path gate, NOT a hashing-path change, it is INDEXER-ONLY
 * and has NO xchain-sync twin: BlockHasher reads the already-materialized action rows
 * and never re-runs contract execution (like vm_deploy_lint_pkg3_activation.js).
 *
 ********************************************************************/

// Per-chain activation height, interpreted as the processing chain's OWN block_index.
// At/after the height the VM re-lints stored contract code on every EXECUTE and fails
// the execution when a now-banned construct is present; below it there is no check and
// no gas charge (byte-identical replay).
// MUST equal xchain-vm/src/index.js EXEC_LINT_ACTIVATION.
// null = UNARMED, awaiting the operator's ratified per-coin train heights.
const VM_EXEC_LINT_ACTIVATION = {
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    testnet: 0,
    regtest: 0,
};

// Resolve the per-chain threshold: '<COIN>:<network>' key first, then the bare
// network key. Unknown chain -> undefined -> off; unarmed (null) -> off.
function _activationThreshold(network, coin){
    if(coin != null && VM_EXEC_LINT_ACTIVATION[coin + ':' + network] !== undefined)
        return VM_EXEC_LINT_ACTIVATION[coin + ':' + network];
    return VM_EXEC_LINT_ACTIVATION[network];
}

// Whether execute-time source-lint enforcement is in effect at `blockIndex` on
// `network` for `coin`. Below the threshold, on an unknown chain, or while the coin's
// entry is still the unarmed null -> off (no re-lint, no gas; byte-identical replay).
function isVmExecLintActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    // Number.isFinite rejects both the absent key (undefined) and the unarmed sentinel.
    if(!Number.isFinite(threshold)) return false;
    return b >= threshold;
}

module.exports = {
    VM_EXEC_LINT_ACTIVATION,
    isVmExecLintActive
};
