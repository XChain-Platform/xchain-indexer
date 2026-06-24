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
 * XChain Indexer - Hub Client
 *
 * Lightweight JSON-RPC client for pushing data to xchain-hub.
 * Uses Node's built-in http/https module to avoid adding dependencies.
 * All calls are best-effort; failures are logged but never block indexing.
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
    // optional; older hubs ignore it, newer ones use it to scope the
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
            // Best-effort: log and continue
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
    // fromActionIndex: lowest rolled-back action_index; the hub deletes rows for
    //                  this source_chain whose action_index is >= this value.
    // toActionIndex (optional): upper bound for a CLOSED-range retraction. The live retraction
    // omits it (open-ended is safe before forward processing resumes); a DEFERRED retraction from
    // the queue passes it so a row re-published at A' inside the original range is not wiped (5296).
    // retractionGeneration (optional, item 5308): the rollback's PRE-bump push generation. Both the
    // live and deferred retractions carry it so the hub fences the delete to push_generation <= it,
    // leaving a row re-published at a recycled action_index (higher generation) intact.
    async retractPriceRange(sourceChain, fromActionIndex, toActionIndex, retractionGeneration){
        if(!this.enabled) return;
        let params = { source_chain: sourceChain, from_action_index: fromActionIndex };
        if(toActionIndex !== undefined && toActionIndex !== null) params.to_action_index = toActionIndex;
        if(retractionGeneration !== undefined && retractionGeneration !== null) params.retraction_generation = retractionGeneration;
        return this._call('pushpricereorg', params);
    }

    // Notify the hub that a reorg rolled back XCALL request actions on this chain so it
    // can retract any cross_chain_calls relay rows seeded from those requests. The hub
    // marks them 'retracted' and broadcasts deletions, so every indexer mirroring its
    // cross_chain_calls table purges the orphaned rows (otherwise a 'finalized' relay row
    // from an orphaned request stays eligible for re-injection on the target chain).
    // sourceChain:     the chain this indexer serves (BTC/LTC/DOGE)
    // fromActionIndex: lowest rolled-back action_index; the hub retracts relay rows for
    //                  this source_chain whose source_action_index is >= this value.
    // toActionIndex (optional): closed-range upper bound for a deferred retraction (see 5296).
    // retractionGeneration (optional, item 5308): see retractPriceRange.
    async retractXcallRange(sourceChain, fromActionIndex, toActionIndex, retractionGeneration){
        if(!this.enabled) return;
        let params = { source_chain: sourceChain, from_action_index: fromActionIndex };
        if(toActionIndex !== undefined && toActionIndex !== null) params.to_action_index = toActionIndex;
        if(retractionGeneration !== undefined && retractionGeneration !== null) params.retraction_generation = retractionGeneration;
        return this._call('pushxcallreorg', params);
    }

    // Notify the hub that a reorg rolled back DEX ORDER actions on this chain so it can retract
    // any cross_chain_matches rows whose retracted leg references those orders. The hub marks the
    // matching matches 'retracted', restores both legs' remaining capacity, and broadcasts
    // deletions, so every indexer mirroring its cross_chain_matches table purges the orphaned rows
    // (otherwise a 'finalized' match against an orphaned order stays eligible for settlement).
    // sourceChain:     the chain this indexer serves (BTC/LTC/DOGE)
    // fromActionIndex: lowest rolled-back action_index; the hub retracts matches for this
    //                  source_chain whose a_action_index/b_action_index is >= this value.
    // toActionIndex (optional): closed-range upper bound for a deferred retraction (see 5296).
    // retractionGeneration (optional, item 5308): see retractPriceRange (fenced per-leg by the hub).
    async retractMatchRange(sourceChain, fromActionIndex, toActionIndex, retractionGeneration){
        if(!this.enabled) return;
        let params = { source_chain: sourceChain, from_action_index: fromActionIndex };
        if(toActionIndex !== undefined && toActionIndex !== null) params.to_action_index = toActionIndex;
        if(retractionGeneration !== undefined && retractionGeneration !== null) params.retraction_generation = retractionGeneration;
        return this._call('pushdexreorg', params);
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
