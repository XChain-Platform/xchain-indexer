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
 * ROLLCALL signature pairs: the length-exact pair list and the per-signature
 * verification over the canonical rebuilt from the carried fields. Structure
 * only, like the rest of the handler in ./index.js: who the signers are is a
 * BTC-side question.
 *
 ********************************************************************/

const ed25519 = require('../../consensus/ed25519.js');
const { buildRollcallCanonical } = require('./rollcall_canonical.js');

// (5)/(6) Signature pairs. SIG_COUNT must equal the pair count EXACTLY:
// a short count would let trailing pairs ride unverified, a long one
// would read past the end.
function parseSigPairs(params, countIdx, error){
    let sigs = [];
    if(!error){
        let declared = parseInt(params[countIdx]);
        let rest     = params.length - (countIdx + 1);
        if(!Number.isFinite(declared) || declared < 1)
            error = 'invalid: SIG_COUNT';
        else if(rest !== declared * 2)
            error = 'invalid: SIG_COUNT';
        else {
            for(let i = 0; i < declared; i++){
                let pubkey = String(params[countIdx + 1 + 2 * i] || '');
                let sig    = String(params[countIdx + 2 + 2 * i] || '');
                // Accept either case on the wire, lowercase before use.
                if(!/^[0-9a-fA-F]{64}$/.test(pubkey) || !/^[0-9a-fA-F]{128}$/.test(sig))
                    continue;
                sigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
            }
        }
    }
    return { error, sigs };
}

// Verify each signature over the canonical rebuilt from the CARRIED
// fields, through the same helper the publishing hub and the BTC close
// call. Every ROLLCALL that can exist is at or above
// EQUIV_HEADER_ACTIVATION, so only the wrapped form is ever built; a v1
// canonical appends sha256(GATES) as carried, so a signer whose build knew
// a different list verifies against nothing and is simply absent.
function verifyRollcallSigners(f, sigs){
    let error    = null;
    let verified = [];
    let { network, epochHeight, ledgerHash, gates } = f;
    let canonRaw  = buildRollcallCanonical({ network, epochHeight, ledgerHash, gates });
    let canonical = Buffer.from(canonRaw, 'utf8');

    let seen = new Set();
    for(let s of sigs){
        if(seen.has(s.pubkey)) continue;
        if(!ed25519.verify(canonical, s.sig, s.pubkey)) continue;
        // Mark seen only AFTER the signature verifies. Marking on first
        // encounter lets a garbage-then-valid pair for one key suppress
        // the real signature, which would read as an absence and, over K
        // epochs, evict a validator that was demonstrably present.
        seen.add(s.pubkey);
        verified.push(s);
    }

    // A roll call carrying no signature that verifies is not a roll call.
    if(verified.length === 0)
        error = 'invalid: SIG_COUNT';

    return { error, verified };
}

module.exports = { parseSigPairs, verifyRollcallSigners };
