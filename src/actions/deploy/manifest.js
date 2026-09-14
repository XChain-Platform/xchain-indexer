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
 * XChain Platform - DEPLOY: the permissions manifest and contract meta
 *
 * Reads the contract's declared policy (permissions, maxTakeBps, whether it
 * exports initialize) and its CONTRACT_META_REQUIRED meta off its exports,
 * and judges both. A part of actions/deploy/index.js, run by runDeployment
 * after the lint gate and before the gas fee.
 *
 ********************************************************************/

// CONTRACT_META_REQUIRED: the seven verdict strings and the meta text grammar.
const contractMeta = require('./contract_meta.js');

/**
 * Read and judge the contract's manifest and meta.
 *
 * @param {Deploy} deploy  the DEPLOY handler (actions, config)
 * @param {object} run     the deployment's run state (mutated: error, declaredPermissions,
 *                         declaredMaxTakeBps, hasInitialize, declaredMeta)
 */
async function readContractManifest(deploy, run){

    /*****************************************************************
     * Permissions Manifest (Phase E)
     *
     * Read the contract's declared policy deterministically off its (immutable)
     * exports. vm.readManifest instantiates the module top-level with no state,
     * so it works even for constructor-less contracts that vm.execute() never
     * runs. The VM surfaces typed values; ALL validation + fail-closed rejection
     * lives here so the rule is in one place and hashes into the deploy status:
     *   - permissions : array of action-type strings the contract may emit
     *                   (enforced in execute.js processEmission across every
     *                    emission path). Absent = unrestricted (legacy).
     *   - maxTakeBps  : tighter per-contract royalty cap, integer in [0, 10000]
     *                   (enforced in execute.js runControllerGuard). Absent =
     *                    global CONTROLLER_MAX_TAKE_BPS applies.
     * A malformed manifest (wrong type / out of range) REJECTS the deploy rather
     * than silently degrading to unrestricted. A module-level throw during the
     * read is treated as "no manifest" (the contract is broken and will fail on
     * its first execute anyway).
     ****************************************************************/
    run.declaredPermissions = null;   // string[] | null
    run.declaredMaxTakeBps  = null;   // number   | null
    run.hasInitialize       = false;  // contract exports a callable constructor (DEPLOY_INIT_STRICT)
    run.declaredMeta        = null;   // { name, description, version, json } | null (CONTRACT_META_REQUIRED)
    // Read the contract's declared permissions, royalty cap and metadata from its code
    if(!run.error && !run.heldVerdict && deploy.actions.vm){
        let manifestRead = await readManifestUnderBlock(deploy, run.data, run.code);
        applyManifestPolicy(run, manifestRead);
        await applyContractMeta(deploy, run, manifestRead);
    }
}

/**
 * vm.readManifest under this DEPLOY's own block context.
 *
 * @param {Deploy} deploy  the DEPLOY handler (actions.vm, config)
 * @param {object} data    the DEPLOY's transaction context
 * @param {string} code    the contract source
 * @returns {Promise<?object>} the raw readManifest result
 */
async function readManifestUnderBlock(deploy, data, code){
    // Read the manifest under THIS DEPLOY's block context, not pre-activation defaults:
    // the verdict hashes into deploy status, so resolving the VM's activation gates from
    // an absent context would read the manifest under a different sandbox rule set than
    // every later execute() of the same contract. contractAddress is passed too and is
    // load-bearing, not cosmetic: the Pkg 3 sandbox gate derives its COIN from this
    // string (pkg3CoinFromAddress), and with no coin the mainnet threshold lookup misses
    // and the gate resolves false regardless of height. Passing only network + height
    // would therefore fix testnet/regtest and silently leave mainnet on the
    // pre-activation reading. Uses the identical expression as the constructor execution
    // further down, and both inputs are already known here, so the two contexts cannot
    // disagree.
    return await deploy.actions.vm.readManifest(code, {
        network:         deploy.config['NETWORK'],
        contractAddress: 'C:' + deploy.config['CHAIN'] + ':' + data['ACTION_INDEX'],
        blockContext: {
            height:    data['BLOCK_INDEX'],
            timestamp: data['BLOCK_TIME']
        }
    });
}

/**
 * Judge the declared permissions and maxTakeBps, recording each conforming value.
 *
 * @param {object}  run           the deployment's run state (mutated: error and the declared fields)
 * @param {?object} manifestRead  the raw readManifest result
 */
function applyManifestPolicy(run, manifestRead){
    if(manifestRead && manifestRead.success && manifestRead.manifest){
        let m = manifestRead.manifest;
        run.hasInitialize = (m.hasInitialize === true);
        if(m.permissionsType !== 'undefined'){
            if(m.permissionsType !== 'array' || !Array.isArray(m.permissions)){
                run.error = 'invalid: CONTRACT_MANIFEST (permissions must be an array)';
            } else if(!m.permissions.every(p => typeof p === 'string')){
                run.error = 'invalid: CONTRACT_MANIFEST (permissions must be action-type strings)';
            } else {
                run.declaredPermissions = m.permissions;
            }
        }
        if(!run.error && m.maxTakeBpsType !== 'undefined'){
            let mtb = m.maxTakeBps;
            if(m.maxTakeBpsType !== 'number' || !Number.isInteger(mtb) || mtb < 0 || mtb > 10000){
                run.error = 'invalid: CONTRACT_MANIFEST (maxTakeBps must be an integer in [0, 10000])';
            } else {
                run.declaredMaxTakeBps = mtb;
            }
        }
    }
}

/**
 * Judge the contract meta, keeping a conforming value whatever the flag day says.
 *
 * @param {Deploy}  deploy        the DEPLOY handler (actions)
 * @param {object}  run           the deployment's run state (mutated: error, declaredMeta)
 * @param {?object} manifestRead  the raw readManifest result
 */
async function applyContractMeta(deploy, run, manifestRead){

    /*************************************************************
     * Contract Meta (CONTRACT_META_REQUIRED)
     *
     * Deliberately OUTSIDE the success/manifest guard above. A REQUIRED
     * field cannot live inside a branch the sender chooses whether to
     * enter: a module-level throw yields success:false and is documented
     * as "treated as no manifest", which would let a nameless contract
     * skip the rule entirely by throwing. evaluateContractMeta takes the
     * raw read and judges that case as row 1.
     *
     * It sits AFTER the permissions and maxTakeBps branches and is
     * assigned under !error, so a contract malformed on permissions AND
     * meta keeps reporting today's permissions string; the verdict order
     * is consensus and a both-bad vector pins it.
     *
     * The evaluation itself is UNGATED: below the flag day the verdict is
     * discarded but a conforming value is still extracted, so a
     * pre-activation contract that happens to carry a good meta gets its
     * columns for free. Only the assignment to `error` is flag-gated, so a
     * from-genesis replay below the flag day reproduces every historic
     * status byte for byte.
     ************************************************************/
    let metaVerdict = contractMeta.evaluateContractMeta(manifestRead);
    run.declaredMeta = metaVerdict.meta;
    // Verify the contract's required metadata (name, description, version) is present once this rule is active
    if(!run.error && metaVerdict.error && await deploy.actions.protocolChanges.isEnabled('CONTRACT_META_REQUIRED', run.data['BLOCK_INDEX']))
        run.error = metaVerdict.error;
}

module.exports = { readContractManifest };
