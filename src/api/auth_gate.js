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
 * XChain Indexer - API-key gate.
 *
 * The perimeter gate for the write, federation-read and gated-exec methods, and
 * the constant-time key comparison it uses. The three method sets, the key and
 * the keyless escape hatch are read in src/api.js at boot and arrive here
 * through apiContext(), so a boot under a fresh environment grades against
 * fresh values.
 *
 ********************************************************************/

const crypto = require('crypto');

// Constant-time API-key comparison. A plain `!==` short-circuits at the first
// mismatching byte, leaking the key that guards reward-forging writes through
// response-time differences; timingSafeEqual needs equal-length buffers, so
// length is guarded first (a length mismatch is not itself the secret).
function keyEquals(provided, expected){
    const a = Buffer.from(String(provided == null ? '' : provided));
    const b = Buffer.from(String(expected == null ? '' : expected));
    if(a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// API key enforcement for write + federation read + gated exec methods.
// These methods enumerate the staked validator set, run the VM, or (once a
// write method exists again) mutate replicated state, so they must never be
// reachable by an unauthenticated peer. The gate fails closed by default:
// with INDEXER_API_KEY set, a valid
// x-api-key is required; with no key set and no explicit escape hatch, the
// call is rejected. Only INDEXER_ALLOW_UNAUTHENTICATED=true restores keyless
// pass-through for a single-host / regtest node.
function apiKeyGate({ INDEXER_API_KEY, ALLOW_UNAUTHED, WRITE_METHODS, FEDERATION_READ_METHODS, GATED_EXEC_METHODS }){
    return (req, res, next) => {
        // A JSON-RPC batch arrives as an array of call objects; a single call as
        // one object. express-json-rpc-router dispatches every element of an
        // array body, so the gate must inspect ALL of them: require the key if
        // ANY element invokes a gated method. Reading req.body.method off an
        // array leaves it undefined, which would smuggle a gated method (e.g.
        // feequotedryrun, which runs the VM on the caller's bytes, or
        // getactivevalidators, which enumerates the staked set) past the check
        // unauthenticated inside a one-element batch.
        let calls = Array.isArray(req.body) ? req.body : [req.body];
        let id = (Array.isArray(req.body) ? null : (req.body && req.body.id)) || null;
        let gated = calls.some(call => {
            let method = call && call.method;
            let normalized = method ? method.toLowerCase() : '';
            return method && (WRITE_METHODS.has(normalized) || FEDERATION_READ_METHODS.has(normalized) || GATED_EXEC_METHODS.has(normalized));
        });
        if(gated){
            if(INDEXER_API_KEY){
                let provided = req.headers['x-api-key'] || '';
                if(!keyEquals(provided, INDEXER_API_KEY)){
                    return res.status(401).json({
                        jsonrpc: '2.0', id,
                        error: { code: -32001, message: 'Unauthorized' }
                    });
                }
            } else if(!ALLOW_UNAUTHED){
                return res.status(401).json({
                    jsonrpc: '2.0', id,
                    error: { code: -32001, message: 'Unauthorized: this method requires INDEXER_API_KEY, or set INDEXER_ALLOW_UNAUTHENTICATED=true for keyless single-host/regtest access' }
                });
            }
            // else: no key configured and ALLOW_UNAUTHED set, pass through.
        }
        next();
    };
}

module.exports = { keyEquals, apiKeyGate };
