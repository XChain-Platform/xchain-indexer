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
const { verifyCanonicalQuorum } = require('./cross_settle/quorum.js');

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

const NO_PINNED = 'invalid: GET_TICK (no pinned remote token)';

/**
 * The signed content canonical of a remote token snapshot. MUST byte-match the hub's
 * XREMOTE layout. Every field is String()-coerced, a null is an empty string, and the
 * coin is upper-cased the way the hub signs it.
 *
 * @param {Object} row - a remote_token_snapshots row
 * @returns {string}
 */
function remoteTokenCanonical(row){
    let v = (x) => (x === null || x === undefined) ? '' : String(x);
    return [
        'XREMOTE', v(row.snapshot_id), String(row.finalizing_view != null ? row.finalizing_view : 0),
        v(row.network), v(row.coin).toUpperCase(), v(row.tick), v(row.decimals),
        v(row.owner), v(row.source_action_index), v(row.snapshot_block)
    ].join('|');
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
        return NO_PINNED;

    let pinned = await mirror.getPinnedRemoteToken(handler.config['NETWORK'], data['GET_COIN'], data['GET_TICK']);
    if(!pinned)
        return NO_PINNED;

    // Re-verify the pinned row's federation signatures: a row that reached the mirror
    // without a quorum over its own canonical never gates an ORDER or SWAP leg.
    let quorum;
    try {
        quorum = await verifyCanonicalQuorum(handler.indexerDb, remoteTokenCanonical(pinned),
            pinned.validator_signatures, pinned.snapshot_block, handler.config['NETWORK']);
    } catch(error){
        return NO_PINNED;
    }
    return quorum.met ? null : NO_PINNED;
}

module.exports = { REMOTE_TOKEN_KEY, remoteTokenCanonical, remoteTokenAcceptError };
