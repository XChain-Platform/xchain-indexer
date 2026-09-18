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
 * The judgement RollcallProofClient.fetchSigners passes on a getrollcallsigners
 * reply: conditions (2) to (5) of the entry's header, in the order they must
 * be asked, and the signer-map normalization of a reply that survives them.
 * The client keeps the transport, the unconfigured check and the memo.
 *
 ********************************************************************/

const rca = require('../../gates/rollcall_gate.js');

// The signer map, normalized on one field only: ROLLCALL v1's GATES, as
// carried. A peer that predates v1 answers rows without the key at all, and
// the close reads the difference between "no gates" and "these gates" to
// choose which canonical it verifies against, so absence is spelled here as
// an explicit null rather than left as undefined for the close to guess. A
// row that is not an object cannot be a signature and reads as absent, which
// the close already treats as one; every other field is passed through.
function normalizeSigners(rawSigners){
    let signers = {};
    for(let k of Object.keys(rawSigners)){
        let row = rawSigners[k];
        if(!row || typeof row !== 'object'){ signers[k] = null; continue; }
        signers[k] = Object.assign({}, row, {
            gates: (row.gates === undefined || row.gates === null) ? null : String(row.gates)
        });
    }
    return signers;
}

// Decide a reply the peer did give. `client` is the RollcallProofClient, asked
// for its manifest hash only once the reply is known to be well formed.
// Returns the same shapes fetchSigners returns: { decided: false, reason } or
// the decided answer, which the caller memoizes.
function decideReply(client, result, {epochHeight, maxBlockTime, network}){
    // (2) malformed.
    if(!result || result.error || typeof result !== 'object'
       || typeof result.signers !== 'object' || result.signers === null)
        return { decided: false, reason: 'malformed getrollcallsigners reply' };

    // (5) peer software-version signal, checked BEFORE the emptiness of the
    // answer can be mistaken for information.
    let ours = client.manifestHash();
    if(ours === null || String(result.manifest_hash || '') !== String(ours))
        return { decided: false, reason: 'DOGE indexer action-manifest hash mismatch (stale decoder?)' };

    let hcut     = (result.hcut === null || result.hcut === undefined) ? null : parseInt(result.hcut);
    let tipIndex = parseInt(result.tip_block_index);
    let tipTime  = parseInt(result.tip_block_time);

    // (3) no cut exists yet. A null hcut, or a DOGE tip whose stamp has not yet
    // passed the window end, means the window is still open over there.
    if(hcut === null || !Number.isFinite(hcut))
        return { decided: false, reason: 'no DOGE window cut yet for epoch ' + epochHeight };
    if(!Number.isFinite(tipTime) || tipTime <= parseInt(maxBlockTime))
        return { decided: false, reason: 'DOGE tip has not passed the window end for epoch ' + epochHeight };

    // (4) the cut is not buried. This is what bounds the accepted residual: a
    // DOGE reorg deeper than the maturity that removes a counted signature
    // after the BTC close cannot be undone from BTC, because nothing there
    // observes it and no un-evict rail exists.
    let maturity = rca.ROLLCALL_DOGE_MATURITY[network];
    if(!Number.isFinite(parseInt(maturity)))
        return { decided: false, reason: 'unknown network for ROLLCALL_DOGE_MATURITY: ' + network };
    if(!Number.isFinite(tipIndex) || tipIndex < hcut + maturity)
        return { decided: false, reason: 'DOGE cut not buried yet (tip ' + tipIndex + ' < ' + (hcut + maturity) + ')' };

    return {
        decided:    true,
        hcut:       hcut,
        signers:    normalizeSigners(result.signers),
        publishers: (result.publishers && typeof result.publishers === 'object') ? result.publishers : {}
    };
}

module.exports = { decideReply, normalizeSigners };
