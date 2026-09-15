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
 * XChain Indexer - the JSON-RPC controller.
 *
 * Merges the route families under this directory into the one flat method
 * table the JSON-RPC router dispatches on. Families are grouped by subsystem;
 * the auth tier a method answers to is decided by the sets in src/api.js,
 * never by which family file holds it.
 *
 ********************************************************************/

const { buildSystemRpc } = require('./system');
const { buildFeesRpc } = require('./fees');
const { buildStakesRpc } = require('./stakes');
const { buildCapabilitiesRpc } = require('./capabilities');
const { buildAttestationRpc } = require('./attestation');
const { buildOrdersRpc } = require('./orders');
const { buildBetsRpc } = require('./bets');
const { buildBridgeRpc } = require('./bridge');
const { buildTokenPolicyRpc } = require('./token_policy');
const { buildCrossChainCallsRpc } = require('./cross_chain_calls');
const { buildPriceBatchesRpc } = require('./price_batches');
const { buildAnchorRpc } = require('./anchor');
const { buildRollcallRpc } = require('./rollcall');
const { buildReorgHistoryRpc } = require('./reorg_history');

const FAMILIES = [
    buildSystemRpc, buildFeesRpc, buildStakesRpc, buildCapabilitiesRpc, buildAttestationRpc,
    buildOrdersRpc, buildBetsRpc, buildBridgeRpc, buildTokenPolicyRpc, buildCrossChainCallsRpc,
    buildPriceBatchesRpc, buildAnchorRpc, buildRollcallRpc, buildReorgHistoryRpc,
];

// NOTE: `pushvalidatorrewards` is RETIRED and the method is gone from this
// controller entirely; see the WRITE_METHODS note in src/api.js. An interim step kept
// it as a refusing stub so an un-upgraded hub read a terminal error instead of
// a method-not-found its push loop misread as acceptance. That reason has
// expired: no hub build carries a push loop or the terminal-refusal
// predicate any more, so there is no caller left for the stub to be kind to.
// A call now gets JSON-RPC -32601, which is the honest answer.

// A method name two families both define is refused at boot: merged silently, the
// later family would replace the earlier handler and the router would serve it with
// nothing to say a handler had gone. `entryFamilies` are the factories src/api.js
// keeps for itself, merged after these under the same refusal.
function buildRpcController(ctx, entryFamilies = []){
    const controller = {};
    for(const build of FAMILIES.concat(entryFamilies)){
        for(const [name, handler] of Object.entries(build(ctx))){
            if(Object.prototype.hasOwnProperty.call(controller, name))
                throw new Error('JSON-RPC method ' + name + ' is defined by two route families');
            controller[name] = handler;
        }
    }
    return controller;
}

module.exports = { buildRpcController, FAMILIES };
