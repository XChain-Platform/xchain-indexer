/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Indexer - Hub Client
 *
 * Lightweight JSON-RPC client for pushing data to xchain-hub.
 * Uses Node's built-in http/https module to avoid adding dependencies.
 * All calls are best-effort — failures are logged but never block indexing.
 *
 ********************************************************************/

const http  = require('http');
const https = require('https');
const url   = require('url');

class HubClient {

    constructor(hubUrl, apiKey){
        this.hubUrl = hubUrl || process.env.HUB_API_URL || '';
        this.apiKey = apiKey || process.env.HUB_API_KEY || '';
        this.enabled = !!this.hubUrl;
    }

    // Push a chain tip update to the hub (fire-and-forget). Network is
    // optional — older hubs ignore it; newer ones use it to scope the
    // chain_tips entry so multi-network hubs don't collide on 'mainnet'.
    async pushChainTip(coin, network, blockHeight, blockTime){
        if(!this.enabled) return;
        try {
            await this._call('pushchaintip', {
                coin:         coin,
                network:      network,
                block_height: blockHeight,
                block_time:   blockTime
            });
        } catch (err) {
            // Best-effort — log and continue
            console.warn('HubClient: pushChainTip failed:', err);
        }
    }

    // Push a validated PRICE v0 round to the hub for cross-chain aggregation
    // The hub deduplicates by round_number into the unified price_snapshots table
    async pushPriceRound(roundData){
        if(!this.enabled) return;
        return this._call('pushpriceround', roundData);
    }

    // Push a validated PRICE v1 user oracle price to the hub for cross-chain aggregation
    async pushOraclePrice(priceData){
        if(!this.enabled) return;
        return this._call('pushoracleprice', priceData);
    }

    // Notify the hub that a reorg rolled back PRICE actions on this chain so it can
    // retract any price_snapshots / oracle_prices rows seeded from those actions.
    // sourceChain:     the chain this indexer serves (BTC/LTC/DOGE)
    // fromActionIndex: lowest rolled-back action_index — the hub deletes rows for
    //                  this source_chain whose action_index is >= this value.
    async retractPriceRange(sourceChain, fromActionIndex){
        if(!this.enabled) return;
        return this._call('pushpricereorg', {
            source_chain:      sourceChain,
            from_action_index: fromActionIndex
        });
    }

    // Make a JSON-RPC 2.0 call to the hub
    _call(method, params){
        return new Promise((resolve, reject) => {
            let parsed = url.parse(this.hubUrl);
            let isHttps = parsed.protocol === 'https:';
            let lib = isHttps ? https : http;

            let body = JSON.stringify({
                jsonrpc: '2.0',
                id:      Date.now(),
                method:  method,
                params:  params
            });

            let headers = {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body)
            };
            if(this.apiKey) headers['x-api-key'] = this.apiKey;

            let opts = {
                hostname: parsed.hostname,
                port:     parsed.port || (isHttps ? 443 : 80),
                path:     parsed.pathname || '/',
                method:   'POST',
                headers:  headers,
                timeout:  5000
            };

            let req = lib.request(opts, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        let parsed = JSON.parse(data);
                        if(parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
                        resolve(parsed.result);
                    } catch (e) {
                        reject(new Error('Invalid JSON response: ' + e.message));
                    }
                });
            });
            req.on('error', (err) => reject(err));
            req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
            req.write(body);
            req.end();
        });
    }
}

module.exports = HubClient;
