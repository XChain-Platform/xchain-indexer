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
 * VM deploy-lint Package 3 flag-day (generator ban + WebAssembly ban, deploy half).
 *
 * deploy.js runs the VM's validateSyntax over a contract's source and records the
 * verdict in the hashed ledger (it decides the DEPLOY action's validity). Two new
 * consensus deploy-lint rules ship in the unshipped VM CONSENSUS_VERSION 3 bundle:
 *   - banned-generator: rejects generator functions (function*, generator methods,
 *     yield). An undrained suspended generator leaks __stackDepth toward the 512 cap
 *     and trips a spurious deterministic out_of_stack;
 *   - banned-wasm: rejects a reference to the global WebAssembly, the deploy-lint
 *     half of the runtime WebAssembly strip. wasm bodies run native code that
 *     carries no __gas metering and are a consensus-fork surface.
 * Both are error-severity CONSENSUS_RULES the deploy validator blocks on. Because
 * arming them changes which contracts the chain accepts, each MUST be height-gated:
 * below the activation the rule is dropped from the deploy-blocking set (validateSyntax
 * enforceBannedGenerator / enforceBannedWasm false), so a from-genesis replay
 * reproduces the historical accepted verdict byte-for-byte; at/after it the rules block.
 *
 * The two rules share ONE gate: they are the deploy-lint legs of the same Package 3
 * VM-sandbox bundle whose RUNTIME strips (WebAssembly global strip, Set/Map metering,
 * musl depth) activate VM-side on xchain-vm's PKG3_SANDBOX_ACTIVATION at these SAME
 * per-coin heights. Gating the deploy verdict on the same heights keeps the deploy-time
 * and execution-time halves calendar-coherent: there is no window where a wasm-referencing
 * contract deploys clean but has WebAssembly stripped from under it at execution.
 *
 * Shape MIRRORS dispenser_freshness_activation.js / state_commitment_activation.js:
 * keyed on the processing chain's OWN local block_index, '<COIN>:<network>' lookup
 * first then the bare network key; testnet/regtest genesis-active (pre-launch, so
 * every node deploys together); unknown network/coin or non-finite height -> off
 * (pre-activation legacy verdict, the byte-identical-replay-safe default).
 *
 * Because it is a DEPLOY-VERDICT (execution-path) gate, NOT a hashing-path change,
 * it is INDEXER-ONLY and has NO xchain-sync twin: BlockHasher reads the already-
 * materialized action rows and never re-runs deploy validation (like
 * dispenser_freshness_activation.js).
 *
 * *** ARMED 2026-07-22 (ratified pre-961000 deploy train). *** mainnet is gated per
 * coin at the ratified train heights (BTC 961000, LTC 3154250, DOGE 6319000), the
 * calendar equivalents of BTC ~961000 (~2026-08-04); testnet + regtest genesis-active.
 * These heights MUST equal xchain-vm's PKG3_SANDBOX_ACTIVATION (a divergence would fork
 * the deploy verdict from the runtime strip); consensus-params.test.js pins the coupling.
 * The indexer fleet must be deployed before BTC 961000.
 *
 ********************************************************************/

// Per-chain activation height, interpreted as the processing chain's OWN block_index.
// At/after the height the deploy-lint generator + wasm bans block; below it they are
// dropped from the deploy-blocking set (historical accepted verdict preserved).
// Mirrors xchain-vm/src/index.js PKG3_SANDBOX_ACTIVATION.
const VM_DEPLOY_LINT_PKG3_ACTIVATION = {
    'BTC:mainnet':  961000,
    'LTC:mainnet':  3154250,
    'DOGE:mainnet': 6319000,
    testnet: 0,
    regtest: 0,
};

// Resolve the per-chain threshold: '<COIN>:<network>' key first, then the bare
// network key. Unknown / unarmed -> undefined -> off.
function _activationThreshold(network, coin){
    if(coin != null && VM_DEPLOY_LINT_PKG3_ACTIVATION[coin + ':' + network] !== undefined)
        return VM_DEPLOY_LINT_PKG3_ACTIVATION[coin + ':' + network];
    return VM_DEPLOY_LINT_PKG3_ACTIVATION[network];
}

// Whether the Package 3 deploy-lint bans (banned-generator + banned-wasm) are in
// effect at `blockIndex` on `network` for `coin`. Below the threshold / unknown chain
// -> off (deploy validator drops both rules; byte-identical historical replay).
function isVmDeployLintPkg3Active(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = {
    VM_DEPLOY_LINT_PKG3_ACTIVATION,
    isVmDeployLintPkg3Active
};
