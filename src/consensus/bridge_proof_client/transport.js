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
 **********************************************************************
 *
 * XChain Platform - bridge escrow proof transport: the wire.
 *
 * Endpoint resolution and the JSON-RPC call, and nothing else: no rule about a transfer, a
 * checkpoint or a proof is decided here.
 *
 ********************************************************************/

'use strict';

// Env reaches this module only through the declared config home. The key is computed
// from the coin symbol, so the frozen CONFIG_ENV map (which spells its keys literally)
// cannot serve it; readEnvNow is the config home's call-time accessor for exactly that
// case, and it keeps a variable rewired after start visible to the next proof call.
const { readEnvNow } = require('../../config.js');
const { postJsonRpc, blockWatchdogDeadline } = require('../peer_json_rpc/index.js');

/**
 * The origin chain's indexer endpoint, resolved with the SAME three-tier idiom
 * anchor_proof_client.js and the hub use for their per-coin indexer calls, so a fleet already
 * wired for the hub needs no new variable:
 *   env <COIN>_INDEXER_API_URL -> env <COIN>_INDEXER_URL -> config <COIN>_INDEXER_URL
 *
 * @param {string} chain  - the origin chain's coin symbol
 * @param {Object} config - the indexer config
 * @returns {{url: string, apiKey: string, deadlineMs: (number|undefined)}} url '' when
 *          nothing is wired, which STALLS; deadlineMs is the block watchdog bound per call
 */
function resolveOriginEndpoint(chain, config){
    const c    = String(chain || '').toUpperCase();
    const conf = config || {};
    if(!/^[A-Z]{2,10}$/.test(c)) return { url: '', apiKey: '' };
    return {
        url: String(readEnvNow(c + '_INDEXER_API_URL') || readEnvNow(c + '_INDEXER_URL')
                    || conf[c + '_INDEXER_URL'] || ''),
        apiKey: String(readEnvNow(c + '_INDEXER_API_KEY') || conf[c + '_INDEXER_API_KEY'] || ''),
        deadlineMs: blockWatchdogDeadline(conf)
    };
}

/**
 * JSON-RPC over the shared proof transport.
 */
function rpc(endpoint, method, params, timeoutMs){
    return postJsonRpc({
        url: endpoint.url,
        apiKey: endpoint.apiKey,
        method: method,
        params: params,
        timeoutMs: timeoutMs,
        deadlineMs: endpoint.deadlineMs
    });
}

module.exports = { resolveOriginEndpoint, rpc };
