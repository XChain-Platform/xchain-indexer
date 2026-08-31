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
 * ROLLCALL proof client: the BTC indexer's read of its DOGE peer.
 *
 * Roll calls land on Dogecoin; capability stake and the membership predicate
 * live on Bitcoin. So the BTC-side epoch close has to prove a DOGE fact before
 * it may change membership, exactly the way the anchor reward rail already
 * proves a DOGE transaction was mined before it mints a reward. Constructor,
 * env tiers and the JSON-RPC transport are the anchor client's by copy; the
 * indexer deliberately carries no HTTP client dependency and this read sits on
 * the block-processing path, so it does not get to add one.
 *
 * THE ONLY TWO ANSWERS ARE "DECIDED" AND "UNKNOWN", and unknown means the block
 * DEFERS rather than judging. That asymmetry is the whole safety argument: an
 * absence is an eviction, so a wrong "nobody signed" costs a live validator its
 * stake, while a deferral costs a block that will be retried. Every ambiguity
 * therefore resolves to unknown. Five conditions produce it:
 *
 *   1. the client is unconfigured, or the peer is unreachable;
 *   2. the reply is malformed;
 *   3. no window cut exists yet (null hcut, or the DOGE tip has not passed X);
 *   4. the cut is not buried by ROLLCALL_DOGE_MATURITY;
 *   5. the peer's vendored action-manifest hash differs from ours.
 *
 * (5) is the one that is easy to leave out and fatal to leave out. A DOGE
 * indexer running a decoder that predates the ROLLCALL allowlist entry drops
 * every roll call at decode and then answers a perfectly well-formed "nobody
 * signed". Depth cannot detect a peer's software version. Without the manifest
 * check that silence reads as a federation-wide absence and evicts everyone.
 *
 ********************************************************************/

const http    = require('http');
const https   = require('https');
const url     = require('url');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const rca     = require('./rollcall_activation.js');

// Raised by the epoch close when the DOGE side cannot be believed yet. Its own
// class, deliberately NOT AnchorProofUnavailableError, so an operator reading a
// stalled indexer can tell the two cross-chain rails apart at a glance.
class RollcallProofUnavailableError extends Error {
    constructor(message){
        super(message);
        this.name = 'RollcallProofUnavailableError';
    }
}

class RollcallProofClient {

    constructor(config, opts){
        let o = opts || {};
        this.config    = config || {};
        this.url       = String(o.url || process.env.DOGE_INDEXER_API_URL || process.env.DOGE_INDEXER_URL
                                || this.config['DOGE_INDEXER_URL'] || '');
        this.apiKey    = String(o.apiKey || process.env.DOGE_INDEXER_API_KEY || this.config['DOGE_INDEXER_API_KEY'] || '');
        // Shares ANCHOR_PROOF_TIMEOUT_MS on purpose: it is the same peer, the same
        // transport and the same "a timeout is 'cannot tell', never 'not mined'"
        // reading. A second knob would be a second thing to misconfigure.
        this.timeoutMs = parseInt(o.timeoutMs || process.env.ANCHOR_PROOF_TIMEOUT_MS || '15000', 10);
        // Decided answers only. A closed epoch past the maturity is immutable chain
        // data and a block may be re-attempted many times behind a barrier, so
        // re-asking is pure load. 'unknown' is NEVER memoized: it is precisely the
        // state that is expected to change.
        this._memo = new Map();
    }

    configured(){ return !!this.url; }

    // sha256 of THIS indexer's vendored action-manifest.json, cached. Compared
    // against the peer's. Unreadable yields null, which can never match, so we
    // defer rather than silently agreeing with every peer.
    manifestHash(){
        if(this._manifestHash !== undefined) return this._manifestHash;
        try {
            let p = path.join(__dirname, '..', 'test', 'fixtures', 'action-manifest.json');
            this._manifestHash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        } catch(e){
            console.error('RollcallProofClient: cannot read vendored action-manifest.json: ' + (e && e.message));
            this._manifestHash = null;
        }
        return this._manifestHash;
    }

    /**
     * Ask the DOGE peer who signed for `epochHeight` inside the window ending at
     * the BTC header stamp `maxBlockTime`.
     *
     * @param {object} q
     * @param {number} q.epochHeight   BTC height of the epoch
     * @param {number} q.maxBlockTime  BTC block_time at E + ACCEPT_WINDOW (the cut basis)
     * @param {string[]} q.pubkeys     effective keys of R(E) -- the answer is bounded by this
     * @param {string[]} q.publishers  the elected leader (for the publish reward)
     * @returns {Promise<{decided: boolean, reason?: string, hcut?: number,
     *                    signers?: object, publishers?: object}>}
     */
    async fetchSigners({epochHeight, maxBlockTime, pubkeys, publishers}){
        let network = String(this.config['NETWORK']);

        if(this._memo.has(epochHeight)) return this._memo.get(epochHeight);

        // (1) unconfigured. Every BTC indexer must be wired to a DOGE indexer from
        // ROLLCALL_ACTIVATION on, or its blocks defer here from the first close.
        if(!this.url)
            return { decided: false, reason: 'DOGE indexer not configured (DOGE_INDEXER_API_URL)' };

        let result;
        try {
            result = await this._rpc('getrollcallsigners', {
                network:        network,
                epoch_height:   epochHeight,
                max_block_time: maxBlockTime,
                pubkeys:        pubkeys || [],
                publishers:     publishers || []
            });
        } catch(e){
            // (1) unreachable, or the request timed out. A timeout is "cannot tell".
            return { decided: false, reason: 'DOGE indexer unreachable: ' + (e && e.message) };
        }

        // (2) malformed.
        if(!result || result.error || typeof result !== 'object'
           || typeof result.signers !== 'object' || result.signers === null)
            return { decided: false, reason: 'malformed getrollcallsigners reply' };

        // (5) peer software-version signal, checked BEFORE the emptiness of the
        // answer can be mistaken for information.
        let ours = this.manifestHash();
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

        let decided = {
            decided:    true,
            hcut:       hcut,
            signers:    result.signers,
            publishers: (result.publishers && typeof result.publishers === 'object') ? result.publishers : {}
        };
        this._memo.set(epochHeight, decided);
        return decided;
    }

    // JSON-RPC over the node http/https core modules, matching AnchorProofClient.
    _rpc(method, params){
        return new Promise((resolve, reject) => {
            let parsed  = url.parse(this.url);
            let isHttps = parsed.protocol === 'https:';
            let lib     = isHttps ? https : http;
            let body    = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: method, params: params });
            let headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
            if(this.apiKey) headers['x-api-key'] = this.apiKey;
            let req = lib.request({
                hostname: parsed.hostname,
                port:     parsed.port || (isHttps ? 443 : 80),
                path:     parsed.pathname || '/',
                method:   'POST',
                headers:  headers,
                timeout:  this.timeoutMs
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        let payload = JSON.parse(data);
                        if(payload.error) return reject(new Error(payload.error.message || JSON.stringify(payload.error)));
                        resolve(payload.result);
                    } catch(e){ reject(new Error('Invalid JSON response: ' + e.message)); }
                });
            });
            req.on('error',   (err) => reject(err));
            req.on('timeout', ()    => { req.destroy(new Error('Request timeout')); });
            req.write(body);
            req.end();
        });
    }
}

module.exports = { RollcallProofClient, RollcallProofUnavailableError };
