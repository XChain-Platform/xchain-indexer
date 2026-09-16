/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The inputs closeRollcallEpochs gathers before it verifies anything: the
 * responsible set indexed by key, the window cut basis and this indexer's own
 * ledger_hash for the epoch block, and the DOGE peer's signer answer. Every
 * input that is missing throws RollcallProofUnavailableError, so the block
 * defers rather than judging on a guess.
 *
 ********************************************************************/

const rca = require('../gates/rollcall_gate.js');
const { RollcallProofUnavailableError } = require('../doge_peer_clients/rollcall_proof_client.js');

// The responsible set R(E) by effective key: the keys the peer is asked about,
// the source each key speaks for, and every source in the set.
function indexResponsible(responsible){
    let keys       = responsible.map((r) => String(r.pubkey).toLowerCase());
    let sourceOf   = new Map();               // effective key -> its source address
    let allSources = new Set();
    for(let r of responsible){
        sourceOf.set(String(r.pubkey).toLowerCase(), String(r.source));
        allSources.add(String(r.source));
    }
    return { keys: keys, sourceOf: sourceOf, allSources: allSources };
}

// Step (2) of the close. Returns { maxBlockTime, ledgerHash }.
async function readEpochHashes(indexerDb, network, epochHeight){
    // (2) The window cut basis: the RAW header stamp at E + ACCEPT_WINDOW. Raw,
    // because it must be the same number on every BTC indexer; a derived protocol
    // time is a median over a window and would drift between nodes.
    let windowEnd = rca.rollcallWindowEndHeight(epochHeight, network);
    let windowRow = await indexerDb.getStoredBlockHashes(windowEnd);
    if(!windowRow || windowRow.block_time === null || windowRow.block_time === undefined)
        throw new RollcallProofUnavailableError(
            'window-end block ' + windowEnd + ' has no stored block_time for epoch ' + epochHeight);
    let maxBlockTime = parseInt(windowRow.block_time);

    // This indexer's OWN ledger_hash for the epoch block. Every signature is
    // verified against this, never against the hash the action carried.
    let epochRow = await indexerDb.getStoredBlockHashes(epochHeight);
    if(!epochRow || !epochRow.ledger_hash)
        throw new RollcallProofUnavailableError(
            'epoch block ' + epochHeight + ' has no stored ledger_hash');
    let ledgerHash = String(epochRow.ledger_hash).toLowerCase();
    return { maxBlockTime: maxBlockTime, ledgerHash: ledgerHash };
}

// (3) Ask the DOGE peer, bounded by the keys we can name. Returns a decided answer.
async function askSigners(proof, epochHeight, maxBlockTime, keys, leader){
    let answer = await proof.fetchSigners({
        epochHeight:  epochHeight,
        maxBlockTime: maxBlockTime,
        pubkeys:      keys,
        publishers:   leader ? [leader] : []
    });
    if(!answer || !answer.decided)
        throw new RollcallProofUnavailableError(
            'epoch ' + epochHeight + ' undecidable: ' + ((answer && answer.reason) || 'no answer'));
    return answer;
}

module.exports = { indexResponsible, readEpochHashes, askSigners };
