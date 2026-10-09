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
 * Accept check shared by ORDER and SWAP: once the remote token gate is
 * active, a cross-chain create naming a non-native GET token is valid only
 * when the hub mirror holds a finalized remote token row for that coin and
 * tick.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../consensus/gate_registry');

const REMOTE_TOKEN_KEY = 'cross_chain_remote_token_activation.CROSS_CHAIN_REMOTE_TOKEN_ACTIVATION';

function remoteTokenGateActive(handler, data){
    try {
        return gateRegistry.activeAt(REMOTE_TOKEN_KEY, handler.config['NETWORK'], handler.config['COIN'], data['BLOCK_INDEX'], null);
    } catch(error){
        if(error && error.name === 'RegistryMissError')
            return false;
        throw error;
    }
}

// Returns an error string, or null when the create is accepted.
async function remoteTokenAcceptError(handler, st){
    let { format, data, isCrossChain } = st;

    if(format!=0 || !isCrossChain || handler.util.isNull(data['GET_TICK']))
        return null;

    if(!remoteTokenGateActive(handler, data))
        return null;

    let mirror = typeof handler.indexerDb.mirrorDb === 'function' ? handler.indexerDb.mirrorDb() : handler.indexerDb;
    if(!mirror || typeof mirror.getPinnedRemoteToken !== 'function')
        return 'invalid: GET_TICK (no pinned remote token)';

    let pinned = await mirror.getPinnedRemoteToken(handler.config['NETWORK'], data['GET_COIN'], data['GET_TICK']);
    return pinned ? null : 'invalid: GET_TICK (no pinned remote token)';
}

module.exports = { REMOTE_TOKEN_KEY, remoteTokenAcceptError };
