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
 * XChain Platform - DEPLOY: the non-VM validations
 *
 * The parse-time staking and SLASH_DESTINATION checks, and the deployment's
 * size, GAS_LIMIT and sleeping checks plus the landing of a held chunk
 * verdict. A part of actions/deploy/index.js. Every verdict string here is
 * consensus (it becomes the deploy status and hashes into contract_hash), and
 * each check runs only while no earlier verdict has been reached, so the
 * order of the calls in index.js is part of the rule.
 *
 ********************************************************************/

/**
 * Resolve an explicit SLASH_DESTINATION reference, recording whether it resolved.
 *
 * @param {Deploy}  deploy      the DEPLOY handler (util, indexerDb)
 * @param {object}  data        the DEPLOY's transaction context (mutated: SLASH_DESTINATION)
 * @param {boolean} hasStaking  the format carries the v1/v3 staking config
 * @param {?string} error       a verdict already reached, or null
 * @returns {Promise<{slashDestExplicit: boolean, slashDestUnresolvable: boolean}>}
 */
async function resolveSlashDestination(deploy, data, hasStaking, error){
    // Resolve a compacted ^<id> SLASH_DESTINATION back to its canonical address (the SDK
    // compacts this field by default). 'BURN' and null pass through untouched; a
    // non-resolvable/malformed reference is left as-is here (see resolveAddressRefChecked),
    // which also keeps a malformed id off the slash-credit FK path, and is
    // hard-rejected below on its own flag-day, independent of the separate
    // DEPLOY_SLASH_DEST_ADDRESS_VALID gate: without that reject a bogus caret would intern
    // into the IMMUTABLE contracts.slash_destination and every later slash would route stake
    // nowhere. `slashDestExplicit` marks a user-supplied, non-BURN destination: only those
    // get the isCryptoAddress format reject below (BURN and the default-to-BURN path already
    // resolve to the trusted configured burn address). The verdict is captured here but
    // APPLIED with the sibling address check further down, so the existing
    // pairing/cooldown verdicts still win, in the same ordering the
    // DEPLOY_SLASH_DEST_ADDRESS_VALID check was written to preserve.
    let slashDestExplicit = hasStaking && !deploy.util.isNull(data['SLASH_DESTINATION']) && data['SLASH_DESTINATION'] !== 'BURN';
    let slashDestUnresolvable = false;
    // Resolve an explicit SLASH_DESTINATION reference to its real address before checking it
    if(!error && slashDestExplicit){
        let slashRef = await deploy.indexerDb.resolveAddressRefChecked(data['SLASH_DESTINATION'], data['BLOCK_INDEX']);
        data['SLASH_DESTINATION'] = slashRef.value;
        slashDestUnresolvable = slashRef.rejected;
    }
    return { slashDestExplicit, slashDestUnresolvable };
}

/**
 * Validate the v1/v3 staking config: COOLDOWN_BLOCKS, its pairing with
 * SLASH_DESTINATION, and the BURN default.
 *
 * @param {Deploy}  deploy      the DEPLOY handler (actions, config, util, cooldown bounds)
 * @param {object}  data        the DEPLOY's transaction context (mutated: the staking fields)
 * @param {boolean} hasStaking  the format carries the v1/v3 staking config
 * @param {?string} error       a verdict already reached, or null
 * @returns {Promise<?string>} the verdict after these checks
 */
async function validateStakingConfig(deploy, data, hasStaking, error){
    // Validate v1/v3 staking config (both optional, but pairing rules apply)
    if(!error && hasStaking){
        let hasCooldown = !deploy.util.isNull(data['COOLDOWN_BLOCKS']) && data['COOLDOWN_BLOCKS'] !== '';
        let hasDest     = !deploy.util.isNull(data['SLASH_DESTINATION']) && data['SLASH_DESTINATION'] !== '';
        // SLASH_DESTINATION without COOLDOWN_BLOCKS is meaningless
        if(hasDest && !hasCooldown){
            error = 'invalid: SLASH_DESTINATION (requires COOLDOWN_BLOCKS)';
        }
        if(!error && hasCooldown){
            // Gate: COOLDOWN_BLOCKS_INTEGER adds the isInteger check the doc contract
            // (unsigned int, Contract_Staking.md) always specified; isNumeric alone
            // accepted fractional strings ('50.5'), storing a fractional
            // contracts.cooldown_blocks that flowed a non-integer COOLDOWN_END_BLOCK
            // into UNSTAKE. Gated on the contract-era flag-day so a from-genesis
            // replay reproduces any historic fractional accept verdict below it.
            let cooldownIntegerStrict = await deploy.actions.protocolChanges.isEnabled('COOLDOWN_BLOCKS_INTEGER', data['BLOCK_INDEX']);
            if(!deploy.util.isNumeric(data['COOLDOWN_BLOCKS'])){
                error = 'invalid: COOLDOWN_BLOCKS (not numeric)';
            } else if(cooldownIntegerStrict && !deploy.util.isInteger(data['COOLDOWN_BLOCKS'])){
                error = 'invalid: COOLDOWN_BLOCKS (not an integer)';
            } else {
                let cb = Number(data['COOLDOWN_BLOCKS']);
                if(cb < deploy.MIN_COOLDOWN_BLOCKS || cb > deploy.MAX_COOLDOWN_BLOCKS){
                    error = 'invalid: COOLDOWN_BLOCKS (out of range)';
                }
            }
        }
        // If contract opted into staking but didn't name a destination, default to BURN.
        // Validate identically to the explicit 'BURN' sentinel below: a missing BURN
        // address must reject here too, or the contract is stakeable but permanently
        // un-slashable (slash throws at runtime because slash_destination is NULL).
        if(!error && hasCooldown && !hasDest){
            data['SLASH_DESTINATION'] = (deploy.config['ADDRESS'] && deploy.config['ADDRESS']['BURN']) || null;
            if(deploy.util.isNull(data['SLASH_DESTINATION']))
                error = 'invalid: SLASH_DESTINATION (BURN address not configured)';
        }
        // Resolve BURN sentinel to the configured BURN address
        if(!error && data['SLASH_DESTINATION'] === 'BURN'){
            data['SLASH_DESTINATION'] = (deploy.config['ADDRESS'] && deploy.config['ADDRESS']['BURN']) || null;
            if(deploy.util.isNull(data['SLASH_DESTINATION']))
                error = 'invalid: SLASH_DESTINATION (BURN address not configured)';
        }
        // Clear staking config on non-stakeable deployments so createContract stores NULLs
        if(!hasCooldown){
            data['COOLDOWN_BLOCKS']   = null;
            data['SLASH_DESTINATION'] = null;
        }
    }
    return error;
}

/**
 * Apply the two explicit-SLASH_DESTINATION rejects captured by resolveSlashDestination.
 *
 * @param {Deploy}  deploy     the DEPLOY handler (actions, util)
 * @param {object}  data       the DEPLOY's transaction context
 * @param {{slashDestExplicit: boolean, slashDestUnresolvable: boolean}} slashDest
 * @param {?string} error      a verdict already reached, or null
 * @returns {Promise<?string>} the verdict after these checks
 */
async function validateSlashDestinationAddress(deploy, data, slashDest, error){
    let { slashDestExplicit, slashDestUnresolvable } = slashDest;

    // Pkg6 / dede7788 (gated DEPLOY_SLASH_DEST_ADDRESS_VALID): an EXPLICIT SLASH_DESTINATION
    // must resolve to a well-formed chain address. resolveAddressRef leaves an unresolvable
    // caret id or a malformed literal UNCHANGED, and isCryptoAddress is false for both, so
    // without this guard a bogus destination is interned into the IMMUTABLE
    // contracts.slash_destination and every later slash routes stake to an unspendable
    // address (permanent money loss). Runs after the pairing/cooldown checks so the existing
    // 'requires COOLDOWN_BLOCKS' verdict still wins for a dest-without-cooldown DEPLOY, and
    // only for a still-present explicit destination (BURN paths already resolved to the
    // trusted configured address). Gated because a reject here changes a historic 'valid'
    // acceptance verdict and the contract_hash; see the flag-day note in protocol_changes.js.
    if(!error && slashDestExplicit && !deploy.util.isNull(data['SLASH_DESTINATION'])
        && await deploy.actions.protocolChanges.isEnabled('DEPLOY_SLASH_DEST_ADDRESS_VALID', data['BLOCK_INDEX'])
        && !deploy.util.isCryptoAddress(data['SLASH_DESTINATION']))
        error = 'invalid: SLASH_DESTINATION (invalid address)';

    // Same reject for an unresolvable ^<id>, on its own flag-day and independent of the
    // gate above (an unresolvable caret is a wire-reference fault, not merely a
    // badly-formatted address). Same position, so the pairing/cooldown verdicts and the
    // address-format verdict both still win, and only while the destination survived the
    // clear-on-no-cooldown path above.
    if(!error && slashDestUnresolvable && !deploy.util.isNull(data['SLASH_DESTINATION']))
        error = 'invalid: SLASH_DESTINATION (unresolvable ^id)';

    return error;
}

/**
 * The deployment's first two checks: the assembled source's size and GAS_LIMIT.
 *
 * @param {Deploy} deploy  the DEPLOY handler (util, MAX_CODE_SIZE)
 * @param {object} run     the deployment's run state (mutated: error)
 */
function checkCodeAndGasLimit(deploy, run){
    // Verify code size
    if(!run.error && Buffer.byteLength(run.code, 'utf8') > deploy.MAX_CODE_SIZE)
        run.error = 'invalid: CODE_ENCODING (exceeds max size)';

    // Verify GAS_LIMIT is provided and valid
    if(!run.error && (deploy.util.isNull(run.gasLimit) || !deploy.util.isNumeric(run.gasLimit)))
        run.error = 'invalid: GAS_LIMIT (required)';
}

/**
 * The sleeping check for the deploying source.
 *
 * @param {Deploy} deploy  the DEPLOY handler (indexerDb)
 * @param {object} run     the deployment's run state (mutated: error)
 */
async function checkSourceAwake(deploy, run){
    let data = run.data;
    // Skipped only for a deferred deployment: the action that carries this deployment ran
    // the identical check for the identical source in the identical block before reaching
    // here, so re-running it would be a second read of the same answer.
    if(!run.error && !run.skipSleeping && await deploy.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']) == false)
        run.error = 'invalid: SOURCE (sleeping)';
}

/**
 * Land a held chunk verdict once the fee and sleeping checks have had their say.
 *
 * @param {object} run  the deployment's run state (mutated: error, landedPending)
 */
function landHeldVerdict(run){
    // The held chunk verdict lands here, after the two checks it must not pre-empt. From
    // this point it behaves exactly as any other rejection: nothing below deploys anything.
    if(!run.error && run.heldVerdict){
        run.error = run.heldVerdict;
        run.landedPending = (run.pendingCodeHash !== null);
    }
}

module.exports = {
    resolveSlashDestination,
    validateStakingConfig,
    validateSlashDestinationAddress,
    checkCodeAndGasLimit,
    checkSourceAwake,
    landHeldVerdict
};
