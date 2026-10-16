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
 * tick. From remote_token_admission_activation the row must also be admitted
 * on this chain at or below the create's block, so the verdict is a function
 * of the chain rather than of when the row reached this node's mirror.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../consensus/gate_registry');
const { rethrowIfInfraFault } = require('../consensus/fault_guard.js');
const { columnsAdmitBlocks, encodeAdmitBlocks } = require('../consensus/gates/mirror_admission_gate.js');
const { verifyCanonicalQuorum } = require('./cross_settle/quorum.js');

const REMOTE_TOKEN_KEY = 'cross_chain_remote_token_activation.CROSS_CHAIN_REMOTE_TOKEN_ACTIVATION';
const REMOTE_TOKEN_ADMISSION_KEY = 'remote_token_admission_activation.REMOTE_TOKEN_ADMISSION_ACTIVATION';
const REMOTE_TOKEN_SYNC_STALL_REASON = 'remote_token_sync_barrier';

// A registry with no row for `key` reads as below the activation.
function gateActive(key, network, coin, height){
    try {
        return gateRegistry.activeAt(key, network, coin, height, null);
    } catch(error){
        if(error && error.name === 'RegistryMissError')
            return false;
        throw error;
    }
}

function remoteTokenGateActive(handler, data){
    return gateActive(REMOTE_TOKEN_KEY, handler.config['NETWORK'], handler.config['COIN'], data['BLOCK_INDEX']);
}

/**
 * Whether a create at block `height` on this chain reads the pin by admission height.
 * Read with this chain's own coin, so each chain crosses at its own sized height.
 */
function remoteTokenAdmissionActive(network, coin, height){
    return gateActive(REMOTE_TOKEN_ADMISSION_KEY, network, coin, height);
}

/**
 * Whether a row is in the admission era: read with the bare network entry at the row's
 * own BTC snapshot_block, the reading the hub signs under, so a row's signed bytes are
 * fixed when it is produced.
 */
function remoteTokenRowInAdmissionEra(row){
    return gateActive(REMOTE_TOKEN_ADMISSION_KEY, row.network, null, Number(row.snapshot_block));
}

const NO_PINNED = 'invalid: GET_TICK (no pinned remote token)';

/**
 * The admission field of a remote token canonical: '' below the era, else '|' and the
 * canonical encoding of the row's admit_block_<c> columns. A row in the era with no map
 * throws, because the hub never signs one and no canonical can stand for it.
 *
 * @param {Object} row - a remote_token_snapshots row
 * @returns {string}
 */
function remoteTokenAdmissionField(row){
    if(!remoteTokenRowInAdmissionEra(row))
        return '';
    let map = columnsAdmitBlocks(row);
    if(map === null)
        throw new Error('remote token snapshot ' + String(row.snapshot_id) + ' is in the admission era and carries no admission map');
    return '|' + encodeAdmitBlocks(map);
}

/**
 * The signed content canonical of a remote token snapshot. MUST byte-match the hub's
 * XREMOTE layout. Every field is String()-coerced, a null is an empty string, and the
 * coin is upper-cased the way the hub signs it. In the admission era the admission map
 * is appended last.
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
    ].join('|') + remoteTokenAdmissionField(row);
}

// The pin for this create. Below the admission activation the call shape and the select
// are the ones the presence read has always used; from it the read is bounded to rows
// admitted on this chain at or below the create's block.
async function readPinnedRemoteToken(handler, mirror, data){
    let network = handler.config['NETWORK'];
    let coin = handler.config['COIN'];
    let height = Number(data['BLOCK_INDEX']);
    if(!remoteTokenAdmissionActive(network, coin, height))
        return await mirror.getPinnedRemoteToken(network, data['GET_COIN'], data['GET_TICK']);
    return await mirror.getPinnedRemoteToken(network, data['GET_COIN'], data['GET_TICK'],
        { chain: coin, height: height });
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

    let pinned = await readPinnedRemoteToken(handler, mirror, data);
    if(!pinned)
        return NO_PINNED;

    // Re-verify the pinned row's federation signatures: a row that reached the mirror
    // without a quorum over its own canonical never gates an ORDER or SWAP leg.
    let quorum;
    try {
        quorum = await verifyCanonicalQuorum(handler.indexerDb, remoteTokenCanonical(pinned),
            pinned.validator_signatures, pinned.snapshot_block, handler.config['NETWORK']);
    } catch(error){
        // Halt on an infra fault (DB errno, executor code) so this node never commits a NO_PINNED its peers do not reach.
        rethrowIfInfraFault(error);
        return NO_PINNED;
    }
    return quorum.met ? null : NO_PINNED;
}

module.exports = {
    REMOTE_TOKEN_KEY, REMOTE_TOKEN_ADMISSION_KEY, REMOTE_TOKEN_SYNC_STALL_REASON,
    remoteTokenCanonical, remoteTokenAdmissionField, remoteTokenAdmissionActive, remoteTokenAcceptError
};
