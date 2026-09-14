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
 **********************************************************************
 *
 * XChain Platform - bridge escrow proof transport: the wire.
 *
 * Endpoint resolution and the JSON-RPC call, and nothing else: no rule about a transfer, a
 * checkpoint or a proof is decided here.
 *
 ********************************************************************/

'use strict';

const http    = require('http');
const https   = require('https');
const urllib  = require('url');

/**
 * The origin chain's indexer endpoint, resolved with the SAME three-tier idiom
 * anchor_proof_client.js and the hub use for their per-coin indexer calls, so a fleet already
 * wired for the hub needs no new variable:
 *   env <COIN>_INDEXER_API_URL -> env <COIN>_INDEXER_URL -> config <COIN>_INDEXER_URL
 *
 * @param {string} chain  - the origin chain's coin symbol
 * @param {Object} config - the indexer config
 * @returns {{url: string, apiKey: string}} url '' when nothing is wired, which STALLS
 */
function resolveOriginEndpoint(chain, config){
    const c    = String(chain || '').toUpperCase();
    const conf = config || {};
    if(!/^[A-Z]{2,10}$/.test(c)) return { url: '', apiKey: '' };
    return {
        url: String(process.env[c + '_INDEXER_API_URL'] || process.env[c + '_INDEXER_URL']
                    || conf[c + '_INDEXER_URL'] || ''),
        apiKey: String(process.env[c + '_INDEXER_API_KEY'] || conf[c + '_INDEXER_API_KEY'] || '')
    };
}

/**
 * JSON-RPC over the node http/https core modules, matching AnchorProofClient.rpc and
 * HubClient.call. The indexer deliberately carries no HTTP client dependency and this read
 * sits on the block-processing path, so it does not get to add one.
 */
function rpc(endpoint, method, params, timeoutMs){
    return new Promise((resolve, reject) => {
        const parsed  = urllib.parse(endpoint.url);
        const isHttps = parsed.protocol === 'https:';
        const lib     = isHttps ? https : http;
        const body    = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: method, params: params });
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        if(endpoint.apiKey) headers['x-api-key'] = endpoint.apiKey;
        const req = lib.request({
            hostname: parsed.hostname,
            port:     parsed.port || (isHttps ? 443 : 80),
            path:     parsed.pathname || '/',
            method:   'POST',
            headers:  headers,
            timeout:  timeoutMs
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const payload = JSON.parse(data);
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

module.exports = { resolveOriginEndpoint, rpc };
