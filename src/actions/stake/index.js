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
 * XChain Platform Action - STAKE
 *
 * Stakes tokens for hub validation (v1/v2, BTC + XCHAIN only) or against
 * a smart contract (v3, any chain, any registered token).
 *
 * The protocol does not assign tiers. Capabilities (price, cross_chain,
 * oracle_publish, attestation) auto-qualify when stake amount meets the
 * governance-configured min_stake for each.
 *
 * FORMATS:
 *   v1 - VERSION|AMOUNT|SIGNING_PUBKEY                                              (create new capability stake)
 *   v2 - VERSION|AMOUNT|SIGNING_PUBKEY                                              (top-up existing capability stake)
 *   v3 - VERSION|AMOUNT|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK                   (contract-targeted stake, multi-token)
 *
 * Capability staking (v1/v2): XCHAIN-only, qualifies for the four built-in
 * protocol capabilities by amount.
 *
 * Contract staking (v3): any token, targets a specific smart contract that
 * was deployed with cooldown_blocks + slash_destination metadata. New-vs-topup
 * is auto-detected based on whether (target, pubkey, tick) already has an
 * active row owned by the same source.
 *
 ********************************************************************/

const capabilityStake = require('./capability_stake.js');
const contractStake   = require('./contract_stake.js');

class Stake {

    // Handle constructing a class instance
    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[1] = 'VERSION|AMOUNT|SIGNING_PUBKEY';                                       // create new capability stake
        this.formats[2] = 'VERSION|AMOUNT|SIGNING_PUBKEY';                                       // top-up existing capability stake
        this.formats[3] = 'VERSION|AMOUNT|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK';            // contract-targeted stake (any token)
    }

    // Handle parsing the STAKE transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        // v3 = contract-targeted stake; dispatch to its own handler (separate machinery)
        if(!error && format === 3){
            return await this.parseContractStake(params, data, error);
        }

        // v1/v2 capability staking (XCHAIN-only; its phases live in stake/capability_stake.js)
        return await capabilityStake.parseCapabilityStake.call(this, params, data, error, format);
    }

    // STAKE v3: contract-targeted stake. Separate machinery from v1/v2 capability
    // staking; writes to contract_stakes table and supports any token (not just XCHAIN).
    // Its phases live in stake/contract_stake.js; the method stays so the handler keeps its shape.
    async parseContractStake(params, data, error){
        return await contractStake.parseContractStake.call(this, params, data, error);
    }
}

module.exports = Stake;
