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
 * XChain Platform - DEPLOY: the v0-v3 wire parameters
 *
 * Reads a v0-v3 DEPLOY's pipe-delimited params into its transaction context
 * by format family. A part of actions/deploy/index.js, called from parse()
 * once the format is known and is not the v4 chunk carrier.
 *
 ********************************************************************/

/**
 * Extract the v0-v3 params into `data` and name the format's family.
 *
 * @param {object} data    the DEPLOY's transaction context (mutated: the wire fields)
 * @param {Array}  params  the pipe-split action params
 * @param {number} format  the DEPLOY format, 0 through 3
 * @returns {{isChunked: boolean, hasStaking: boolean}}
 */
function readWireParams(data, params, format){

    // Format families. Chunked (v2/v3) carries CODE_HASH in params[1] and assembles the
    // code from prior v4 carrier actions; inline (v0/v1) carries the base64 source there.
    // v0/v2 take CONSTRUCTOR_PARAMS as a rest field (a multi-arg constructor sends each arg
    // as its own pipe segment, like EXECUTE's METHOD_PARAMS); v1/v3 keep the single-field
    // form because COOLDOWN_BLOCKS + SLASH_DESTINATION trail the constructor args, so a
    // multi-arg v1/v3 constructor must sub-delimit within params[3]. v1/v3 carry the
    // optional staking config; v0/v2 do not.
    let isChunked  = (format === 2 || format === 3);
    let isRestCtor = (format === 0 || format === 2);
    let hasStaking = (format === 1 || format === 3);

    // Extract params
    if(isChunked)
        data['CODE_HASH_PARAM'] = params[1];
    else
        data['CODE_ENCODING']   = params[1];
    data['GAS_LIMIT']          = params[2];
    data['CONSTRUCTOR_PARAMS'] = isRestCtor ? params.slice(3).join('|') : params[3];
    // v1/v3 optional staking config
    data['COOLDOWN_BLOCKS']    = hasStaking ? params[4] : null;
    data['SLASH_DESTINATION']  = hasStaking ? params[5] : null;

    return { isChunked, hasStaking };
}

module.exports = { readWireParams };
