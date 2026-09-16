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
 * XChain Indexer - ROLLCALL federation read: request and presence parts
 *
 * The request check and the per-key presence lookup behind the
 * getrollcallsigners JSON-RPC handler in src/api.js. The handler keeps the
 * readiness guard, the committed-only view, the tip and window-cut reads and
 * the manifest hash; these parts take the already-bound view and never reach
 * for a raw database handle.
 *
 ********************************************************************/

'use strict';

// Upper bound on the key lists getrollcallsigners will answer over. The BTC
// close asks for |R(E)| + 1 keys, so this is a sanity ceiling on a malformed or
// hostile caller, not a paging limit: the method never enumerates, so a caller
// that needs more keys than this is not doing what the method is for.
const ROLLCALL_READ_MAX_KEYS = 2048;

// The caller's request checked in the order the handler has always checked it
// (DOGE only, this network, numeric epoch and window, bounded hex key lists).
// Returns { error } on the first refusal, else the parsed request.
function rollcallSignersRequest(config, {network, epoch_height, max_block_time, pubkeys, publishers}){
    if(String(config['COIN']) !== 'DOGE')
        return { error: 'getrollcallsigners is DOGE-only' };
    if(network !== undefined && String(network) !== String(config['NETWORK']))
        return { error: 'network mismatch' };

    let epoch = parseInt(epoch_height);
    let maxT  = parseInt(max_block_time);
    if(!Number.isFinite(epoch) || epoch < 0) return { error: 'invalid epoch_height' };
    if(!Number.isFinite(maxT))               return { error: 'invalid max_block_time' };

    let keys = Array.isArray(pubkeys)    ? pubkeys    : [];
    let pubs = Array.isArray(publishers) ? publishers : [];
    // Hex-shaped and bounded. A caller asking about a key it cannot name is
    // asking to enumerate, which this method does not do.
    const HEX64 = /^[0-9a-fA-F]{64}$/;
    keys = keys.filter((k) => HEX64.test(String(k))).map((k) => String(k).toLowerCase());
    pubs = pubs.filter((k) => HEX64.test(String(k))).map((k) => String(k).toLowerCase());
    if(keys.length > ROLLCALL_READ_MAX_KEYS || pubs.length > ROLLCALL_READ_MAX_KEYS)
        return { error: 'too many keys requested' };
    return { epoch, maxT, keys, pubs };
}

// Every asked-about key's presence signature and every asked-about publisher's
// roll call at or below the window cut, keyed lowercase. A key with no row, and
// every key when there is no cut yet, stays null.
async function rollcallPresence(db, epoch, keys, pubs, hcut){
    let signers = {};
    for(let k of keys) signers[k] = null;
    let publishersOut = {};
    for(let k of pubs) publishersOut[k] = null;

    // A null cut means no DOGE block is inside the window yet. Answer the
    // shape with an explicit null hcut so the caller defers rather than
    // reading empty maps as a positive "none".
    if(hcut !== null){
        for(let r of await db.getRollcallSignersForKeys(epoch, keys, hcut)){
            signers[String(r.pubkey).toLowerCase()] = {
                sig:          String(r.sig).toLowerCase(),
                ledger_hash:  String(r.ledger_hash).toLowerCase(),
                publisher:    String(r.publisher).toLowerCase(),
                action_index: Number(r.action_index),
                block_index:  Number(r.block_index),
                // ROLLCALL v1 GATES as carried, null on a v0 row: the BTC close
                // needs it to rebuild the v1 canonical it re-verifies against.
                gates:        (r.gates === undefined || r.gates === null) ? null : String(r.gates)
            };
        }
        for(let r of await db.getRollcallPublishers(epoch, pubs, hcut)){
            publishersOut[String(r.publisher).toLowerCase()] = {
                action_index: Number(r.action_index),
                block_index:  Number(r.block_index)
            };
        }
    }
    return { signers, publishersOut };
}

module.exports = { ROLLCALL_READ_MAX_KEYS, rollcallSignersRequest, rollcallPresence };
