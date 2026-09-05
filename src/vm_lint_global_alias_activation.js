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
 * Deploy-lint global-alias flag-day (banned-async + banned-wasm + banned-math
 * refinement).
 *
 * The banned-async, banned-wasm and banned-math deploy rules are identifier-precise:
 * they flag the bare `Promise` / `WebAssembly` / `Math` identifier and the single-hop
 * `globalThis.X` spelling, and that precision is what lets them be error-severity
 * CONSENSUS_RULES the deploy validator blocks on. Two other spellings read the SAME
 * global binding and walked straight past all three rules:
 *   - sloppy-mode `this`. Contract code is evaluated by the saved Function
 *     constructor in global scope as sloppy-mode script, so top-level `this` IS
 *     globalThis and a plain `f()` call hands a sloppy function body the same
 *     receiver. `this.WebAssembly` / `this.Promise` / `this.Math.pow` was never
 *     matched.
 *   - the global object's own `globalThis` self-reference, at any depth:
 *     `globalThis.globalThis.Promise`, `globalThis['globalThis'].WebAssembly`,
 *     `globalThis.globalThis.Math.log`, `this.globalThis.Promise`. The rule compared
 *     node.object.name directly, so a single extra hop defeated it.
 *
 * banned-math is in scope for the same reason and on the same bit, which is easy to
 * miss because it reads the global object through its OWN single-hop matcher rather
 * than the shared one: xchain-vm/src/lint-core.js isMathObjectRef resolves its
 * qualifying-object leg through isGlobalObjectRef under this epoch, and
 * findBannedMathCalls is handed the same flag (lint-core.js validateSyntax, the
 * `globalAlias` argument syntax.js maps enforceLintGlobalAlias onto).
 *
 * Closing all three changes which contracts the chain accepts, so it MUST be
 * height-gated: below the activation the refinement is off and validateSyntax
 * resolves all three rules exactly as it historically did, so a from-genesis replay
 * reproduces the accepted verdict byte for byte; at/after it the wider spellings
 * block. deploy.js threads the resolved activation as
 * vm.validateSyntax(code, {enforceLintGlobalAlias}).
 *
 * It CANNOT ride the existing gates. VM_LINT_HARDENING is a block-time gate already
 * open on every network, so reusing it would apply the tightened rules retroactively
 * to contracts the chain has already accepted; the Package 3 heights
 * (vm_deploy_lint_pkg3_activation.js) are in the past for the same reason. Hence a
 * new epoch of its own.
 *
 * Shape MIRRORS vm_exec_lint_activation.js: keyed on the processing chain's OWN local
 * block_index, '<COIN>:<network>' lookup first then the bare network key;
 * testnet/regtest genesis-active (both pre-launch, so every node deploys together);
 * unknown network/coin, non-finite height, or an unarmed null entry -> off
 * (pre-activation legacy verdict, the byte-identical-replay-safe default).
 *
 * Because it is a DEPLOY-VERDICT (execution-path) gate, NOT a hashing-path change, it
 * is INDEXER-ONLY and has NO xchain-sync twin: BlockHasher reads the already-
 * materialized action rows and never re-runs deploy validation (like
 * vm_deploy_lint_pkg3_activation.js).
 *
 * *** MAINNET IS DELIBERATELY UNARMED. *** null is the explicit unarmed sentinel: it
 * resolves to inactive at every mainnet height, so mainnet behaviour is byte-identical
 * to today until the operator ratifies concrete per-coin train heights here AND in
 * xchain-vm's LINT_GLOBAL_ALIAS_ACTIVATION, which the consensus-params suites in both
 * repos pin to equality. Arming one side alone forks the fleet.
 *
 ********************************************************************/

// Per-chain activation height, interpreted as the processing chain's OWN block_index.
// At/after the height the deploy-lint banned-async / banned-wasm / banned-math rules
// also match sloppy-mode `this` and the globalThis self-reference chain; below it they
// resolve as they historically did (byte-identical replay).
// MUST equal xchain-vm/src/index.js LINT_GLOBAL_ALIAS_ACTIVATION.
// null = UNARMED, awaiting the operator's ratified per-coin train heights.
const VM_LINT_GLOBAL_ALIAS_ACTIVATION = {
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    testnet: 0,
    regtest: 0,
};

// Resolve the per-chain threshold: '<COIN>:<network>' key first, then the bare
// network key. Unknown chain -> undefined -> off; unarmed (null) -> off.
function _activationThreshold(network, coin){
    if(coin != null && VM_LINT_GLOBAL_ALIAS_ACTIVATION[coin + ':' + network] !== undefined)
        return VM_LINT_GLOBAL_ALIAS_ACTIVATION[coin + ':' + network];
    return VM_LINT_GLOBAL_ALIAS_ACTIVATION[network];
}

// Whether the deploy-lint global-alias refinement is in effect at `blockIndex` on
// `network` for `coin`. Below the threshold, on an unknown chain, or while the coin's
// entry is still the unarmed null -> off (historical verdict preserved).
function isVmLintGlobalAliasActive(blockIndex, network, coin){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = _activationThreshold(network, coin);
    // Number.isFinite rejects both the absent key (undefined) and the unarmed sentinel.
    if(!Number.isFinite(threshold)) return false;
    return b >= threshold;
}

module.exports = {
    VM_LINT_GLOBAL_ALIAS_ACTIVATION,
    isVmLintGlobalAliasActive
};
