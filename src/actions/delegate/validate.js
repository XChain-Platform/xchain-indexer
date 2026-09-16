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
 * DELEGATE wire-field validation shared by the four flavors: the signing
 * pubkey every flavor names, the (TARGET_CONTRACT_INDEX, TICK) slot the two
 * contract-targeted flavors name, and the per-chain activation delay every
 * flavor adds to BLOCK_INDEX.
 *
 ********************************************************************/

// Installed onto Delegate.prototype by delegate.js; each method runs with `this` bound to
// the handler, exactly as the class code it came from.
module.exports = {

    // Verify SIGNING_PUBKEY is provided and is 64 hex characters (Ed25519)
    validateSigningPubkey(data, error){
        if(!error && this.util.isNull(data['SIGNING_PUBKEY']))
            error = 'invalid: SIGNING_PUBKEY (required)';
        if(!error && !/^[0-9a-fA-F]{64}$/.test(String(data['SIGNING_PUBKEY'])))
            error = 'invalid: SIGNING_PUBKEY (format)';
        return error;
    },

    // Verify the contract-targeted slot (v1/v3): TARGET_CONTRACT_INDEX then TICK
    async validateContractSlot(data, error){
        if(!error && this.util.isNull(data['TARGET_CONTRACT_INDEX']))
            error = 'invalid: TARGET_CONTRACT_INDEX (required)';
        // Gated by CONTRACT_INDEX_CANONICAL: reject non-canonical leading zeros at/after the flag-day.
        let idxRe = (await this.actions.protocolChanges.isEnabled('CONTRACT_INDEX_CANONICAL', data['BLOCK_INDEX'])) ? /^[1-9]\d*$/ : /^[0-9]+$/;
        if(!error && (!idxRe.test(String(data['TARGET_CONTRACT_INDEX'])) || Number(data['TARGET_CONTRACT_INDEX']) <= 0))
            error = 'invalid: TARGET_CONTRACT_INDEX (format)';
        if(!error && this.util.isNull(data['TICK']))
            error = 'invalid: TICK (required)';
        return error;
    },

    // DELEGATE v2 target lookup: an active delegation of the key first, else SOURCE's own
    // stake key when it carries no earlier revocation (stakeKeyMode)
    async resolveRevokeTarget(data, error){
        let stakeKeyMode = false;
        if(!error){
            let activeDelegation = await this.indexerDb.getActiveDelegation(data['SOURCE'], data['SIGNING_PUBKEY'], data['BLOCK_INDEX']);
            if(!activeDelegation){
                let stakeRow = await this.indexerDb.getActiveStakeBySourceAndPubkey(data['SOURCE'], data['SIGNING_PUBKEY'], data['BLOCK_INDEX']);
                if(stakeRow){
                    let priorRevocation = await this.indexerDb.getStakeKeyRevocation(data['SOURCE'], data['SIGNING_PUBKEY'], stakeRow.action_index);
                    if(priorRevocation)
                        error = 'invalid: SIGNING_PUBKEY (already revoked)';
                    else
                        stakeKeyMode = true;
                } else {
                    error = 'invalid: no active delegation or stake key for pubkey';
                }
            }
        }
        return { error, stakeKeyMode };
    },

    // The chain's activation delay: STAKING.ACTIVATION_DELAY_BLOCKS when set, else the
    // top-level ACTIVATION_DELAY_BLOCKS
    activationDelay(){
        let staking = this.config['STAKING'];
        return (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS'];
    }
};
