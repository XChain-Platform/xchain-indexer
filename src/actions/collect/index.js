const { getLogger } = require('../../observability/index.js');
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
 * XChain Platform Action - COLLECT
 *
 * This action collects accrued validator rewards.
 * BTC chain only.
 *
 * PARAMS:
 * - VERSION - Format Version
 * - AMOUNT  - OPTIONAL trailing partial-claim amount, gated by
 *             PARTIAL_UNSTAKE_COLLECT: absent = claim the full unclaimed
 *             total (the historical behavior, byte-identical); present =
 *             claim only AMOUNT, the remainder stays pending. Below the
 *             flag-day a present AMOUNT is ignored (a legacy node cannot
 *             see it, so ignoring is the only pre-activation rule the
 *             whole fleet agrees on).
 *
 * FORMATS:
 * - 0 = Collect accrued validator rewards
 *
 ********************************************************************/

// The handler's phases, grouped by concern and installed onto Collect.prototype below
const validatePart = require('./validate.js');
const settlePart   = require('./settle.js');

class Collect {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|AMOUNT';    // AMOUNT optional (partial claim)
    }

    // Handle parsing the COLLECT transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined ))
            error = 'invalid: VERSION (unknown)';

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        // Chain restriction and stake existence (collect/validate.js)
        error = await this.validateCollector(data, error);

        // Reward calculation, the optional partial AMOUNT and the pool's cover (collect/validate.js)
        let rewardAmount;
        ({ error, rewardAmount } = await this.validateRewardClaim(params, data, error));

        data['AMOUNT'] = rewardAmount;

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Print status message
        getLogger().info("\t COLLECT : amount=" + this.util.logAmount(data['AMOUNT']) + ' : ' + data['STATUS']);

        // Create record in reward_claims table
        await this.indexerDb.createRewardClaim(data);

        // Pay the reward out of the pool and post the ledger changes (collect/settle.js)
        await this.payReward(data, status, rewardAmount);
    }
}

// Install the phase methods from collect/ NON-ENUMERABLE, the shape the class body they came
// from produced: parse() reaches them as this.<method>, suites can stub them through
// Collect.prototype, and for-in over a handler stays empty. Same install as db/index.js uses
// for its query mixins.
for(const part of [validatePart, settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Collect.prototype, descriptors);
}

module.exports = Collect;
