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
 * PRICE v1: the user TOKEN/FIAT oracle price.
 *
 * The field rules and the hub payload shape live here, apart from the handler,
 * because v1 shares nothing with the batch wire but the row it is stored in:
 * these are the only rules a v1 action is judged by, and the payload key names
 * are destructured by name on the hub side.
 *
 ********************************************************************/

const priceRange = require('../../price_zero_validity_activation.js');

// Every v1 field rule, in order. Returns the error chain.
function validatePriceV1(config, util, params, data, error){
    // Extract fields
    data['V1_COIN']  = params[1];
    data['V1_TICK']  = params[2];
    data['V1_FIAT']  = params[3];
    data['V1_VALUE'] = params[4];
    data['V1_FEE']   = params[5];
    data['MEMO']     = params[6];

    // Validate COIN
    if(!error && (!data['V1_COIN'] || !config['COINS'].includes(data['V1_COIN'])))
        error = 'invalid: COIN (unsupported)';

    // Validate TICK
    if(!error && (!data['V1_TICK'] || data['V1_TICK'].length === 0 || data['V1_TICK'].length > config['MAX_TICK_LENGTH']))
        error = 'invalid: TICK (format)';

    // Validate FIAT
    if(!error && (!data['V1_FIAT'] || util.isNull(config['FIATS'][data['V1_FIAT']])))
        error = 'invalid: FIAT (unsupported)';

    // Validate VALUE (positive 8-decimal string)
    if(!error && (!data['V1_VALUE'] || !/^[0-9]+(\.[0-9]{1,8})?$/.test(data['V1_VALUE']) || util.bclte(data['V1_VALUE'], '0')))
        error = 'invalid: VALUE (format)';

    // VALUE ceiling, behind the same flag day the v0 pair prices ride. The hub's v1 ingest
    // refuses a value not `< PRICE_MAX` and the check above bounds only the lower end, so
    // an at/above-ceiling oracle price is chain-valid and hub-invalid, the same seam as v0
    // on the one action version whose loss is never re-derivable. Same expression as the
    // hub's, so the two verdicts agree at/above the gate; below it nothing runs.
    if(!error && !priceRange.isPriceRangeValid(data['V1_VALUE'], data['BLOCK_TIME'], config['NETWORK']))
        error = 'invalid: VALUE (range)';

    // Validate FEE (decimal between 0 and 1, optional). The regex caps precision at 18
    // decimals (bcmath width) and the range gate uses exact bcmath comparators, not
    // parseFloat: an unbounded-precision value like '1.0000000000000000001' rounds to
    // exactly 1.0 under IEEE-754 and would slip past a parseFloat `> 1` check while
    // downstream bcmath (bcmul @18) treats it as > 1, a validator/consensus-math
    // divergence on a money path.
    if(!error && data['V1_FEE'] && (!/^[0-9]+(\.[0-9]{1,18})?$/.test(data['V1_FEE']) || util.bclt(data['V1_FEE'], '0') || util.bcgt(data['V1_FEE'], '1')))
        error = 'invalid: FEE (format)';
    return error;
}

// KEY NAMES ARE CONSENSUS-ADJACENT AND UNVALIDATED BY THE TRANSPORT: the hub
// destructures exactly these names, so a typo fails silently at runtime.
function buildV1PushPayload(data, pushGeneration){
    return {
        source_chain:   data['COIN'],
        source_address: data['SOURCE'],
        coin:           data['V1_COIN'],
        tick:           data['V1_TICK'],
        fiat:           data['V1_FIAT'],
        value:          data['V1_VALUE'],
        fee:            data['V1_FEE'],
        memo:           data['MEMO'],
        block_time:     data['BLOCK_TIME'],
        action_index:   data['ACTION_INDEX'],
        push_generation: pushGeneration
    };
}

module.exports = { validatePriceV1, buildV1PushPayload };
