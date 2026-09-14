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
 * NODEPROOF verdict wire validation: the header and accept-window checks, the
 * challenge-id derivation, and the PASS and verifier signature lists. Each
 * helper takes the running error and hands it back, so the verdict in
 * ../nodeproof.js keeps its first-failure-wins order.
 *
 ********************************************************************/

const crypto = require('crypto');

// The verdict header: chain scope, the epoch and its accept window, and the
// challenge id re-derived from chain. The parsed values are returned whatever
// the verdict, because the log line and the verification rows read them.
async function validateVerdictHeader(handler, params, data, error){

    // BTC-only: capability staking + oracle-round rewards are BTC-only, so the
    // proof and its verified set live on BTC. Other chains receive the rows via
    // xchain-sync replication, never by processing a NODEPROOF tx.
    if(!error && handler.config['COIN'] !== 'BTC')
        error = 'invalid: NODEPROOF is BTC-only';

    let fn        = handler.fnConfig();
    let interval  = parseInt(fn['CHALLENGE_INTERVAL_BLOCKS'])     || 0;
    let depth     = parseInt(fn['CONFIRM_DEPTH'])                 || 0;
    let acceptWin = parseInt(fn['VERDICT_ACCEPT_WINDOW_BLOCKS'])  || 0;

    let challengeId = String(params[1] || '').toLowerCase();
    let epochHeight = parseInt(params[2]);
    let blockIndex  = parseInt(data['BLOCK_INDEX']);

    if(!error && !/^[0-9a-f]{64}$/.test(challengeId))
        error = 'invalid: CHALLENGE_ID (format)';
    if(!error && interval <= 0)
        error = 'invalid: full-node challenges not configured';
    if(!error && (!Number.isFinite(epochHeight) || epochHeight % interval !== 0))
        error = 'invalid: EPOCH_HEIGHT (not a challenge epoch)';
    if(!error && epochHeight > blockIndex)
        error = 'invalid: EPOCH_HEIGHT (in the future)';
    if(!error && (blockIndex - epochHeight) > acceptWin)
        error = 'invalid: verdict too late (epoch=' + epochHeight + ', block=' + blockIndex + ')';

    let targetHeight = epochHeight - depth;
    if(!error && targetHeight < 0)
        error = 'invalid: target height below genesis';

    // Recompute the derived challenge id from real chain history. Binds the
    // verdict to the epoch's ledger hash, so a verdict can't claim an epoch
    // that never happened (or fabricate a different target).
    if(!error){
        let row = await handler.indexerDb.getStoredBlockHashes(epochHeight);
        if(!row || !row.ledger_hash){
            error = 'invalid: EPOCH_HEIGHT (no block / ledger hash)';
        } else {
            let preimage = String(handler.config['NETWORK']) + ':' + epochHeight + ':' + String(row.ledger_hash) + ':' + targetHeight;
            let expected = crypto.createHash('sha256').update(preimage).digest('hex');
            if(expected !== challengeId)
                error = 'invalid: CHALLENGE_ID (does not match derivation)';
        }
    }

    return { error, challengeId, epochHeight, blockIndex, targetHeight };
}

// Parse the PASS list (validators being attested as having answered).
function parsePassList(params, data, error){
    let passList = [];
    if(!error){
        try {
            let passCount = parseInt(params[3]);
            if(!Number.isFinite(passCount) || passCount < 0)
                throw new Error('invalid PASS_COUNT');
            let seen = new Set();
            for(let i = 0; i < passCount; i++){
                let pk = String(params[4 + i] || '').toLowerCase();
                if(!/^[0-9a-f]{64}$/.test(pk)) throw new Error('invalid PASS_PK at index ' + i);
                if(seen.has(pk)) continue;
                seen.add(pk);
                passList.push(pk);
            }
            // Offset where the signature block begins (after PASS_COUNT + n pubkeys)
            data['_SIG_OFFSET'] = 4 + passCount;
        } catch(e){
            error = 'invalid: ' + e.message;
        }
    }
    return { error, passList };
}

// Parse the verifier signature list.
function parseVerifierSigs(params, data, error){
    let sigs = [];
    if(!error){
        try {
            let off      = data['_SIG_OFFSET'];
            let sigCount = parseInt(params[off]);
            if(!Number.isFinite(sigCount) || sigCount < 1)
                throw new Error('invalid SIG_COUNT');
            for(let i = 0; i < sigCount; i++){
                let pubkey = params[off + 1 + 2 * i];
                let sig    = params[off + 1 + 2 * i + 1];
                if(!pubkey || !sig) throw new Error('missing sig data at index ' + i);
                if(!/^[0-9a-fA-F]{64}$/.test(pubkey))  throw new Error('invalid pubkey format at index ' + i);
                if(!/^[0-9a-fA-F]{128}$/.test(sig))    throw new Error('invalid sig format at index ' + i);
                sigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
            }
        } catch(e){
            error = 'invalid: ' + e.message;
        }
    }
    return { error, sigs };
}

module.exports = { validateVerdictHeader, parsePassList, parseVerifierSigs };
