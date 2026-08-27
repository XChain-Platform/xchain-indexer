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

// Name the hub rejections a REPLAY can never turn into an acceptance.
// A push can fail INSIDE a successful JSON-RPC envelope: PriceAggregator returns
// { accepted:false, reason } and api.js returns { error:'...' } as an ordinary method
// result, and _call rejects on neither. Every pattern here judges the PAYLOAD itself,
// which a queued row replays byte for byte, so retrying only grows the queue. Anything
// else is retryable, including a reason this list has never seen: a needless retry costs
// a queue slot, a wrong drop costs a never-re-derivable oracle price (actions/price.js).
const TERMINAL_HUB_REJECTIONS = [
    /^duplicate$/i,                        // the hub already holds this action key
    /^stale \(retracted generation\)$/i,   // ingest fence; it only ever hardens
    /^invalid\b/i,                         // structural reject of the payload's own fields
    /^insufficient quorum\b/i,             // the sigs ride in the payload and never change
    /\b(is|are) required$/i,               // api.js missing-field guards
    /^chain must be one of\b/i             // api.js validateChain
];

// Read the application-level rejection out of a hub result, or null when the call was
// accepted. Covers BOTH shapes the hub uses: a check on `accepted` alone misses the
// api.js { error } path, and that path carries the transient failures (a hub still
// booting its aggregator, an unexpected exception inside a handler).
function hubRejectionReason(result){
    if(!result || typeof result !== 'object') return null;
    if(result.error) return String((result.error && result.error.message) || result.error);
    if(result.accepted === false)
        return (typeof result.reason === 'string' && result.reason) ? result.reason : 'rejected';
    return null;
}

class HubClient {

    constructor(hubUrl, apiKey){
        this.hubUrl = hubUrl || process.env.HUB_API_URL || '';
        this.apiKey = apiKey || process.env.HUB_API_KEY || '';
        // Interim credential scoping: when the hub gates its retraction rails
        // (push*reorg) behind a dedicated HUB_REORG_API_KEY, the reorg pushes
        // must carry that key; everything else keeps the bulk key.
        // Unset = legacy single-key behavior.
        this.reorgApiKey = process.env.HUB_REORG_API_KEY || this.apiKey;
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
            console.warn('HubClient: pushChainTip failed:', err);
        }
    }

    // Push a validated PRICE v0 round to the hub for cross-chain aggregation
    // The hub deduplicates by round_number into the unified price_snapshots table
    async pushPriceRound(roundData){
        if(!this.enabled) return;
        return this._requireHubAccepted('pushpriceround', await this._call('pushpriceround', roundData));
    }

    // Push a validated PRICE v1 user oracle price to the hub for cross-chain aggregation
    async pushOraclePrice(priceData){
        if(!this.enabled) return;
        return this._requireHubAccepted('pushoracleprice', await this._call('pushoracleprice', priceData));
    }

    // Push a validated PRICE v2 batch (a signed window of rounds) to the hub for cross-chain
    // aggregation via pushpricebatch. batchData mirrors pushPriceRound's payload one-for-one
    // (source_chain, btc_block_height, sigs, action_index, block_index, push_generation) plus
    // rounds[] carrying the window's per-round data and block_time, the landing block's own
    // time. block_time is required here (not just for a single round) because the hub keys its
    // pair-name flag day per round on it, and batching widens the hub/chain time skew from the
    // ~10 minutes a single round carries to ~70 minutes for a six-round window.
    async pushPriceBatch(batchData){
        if(!this.enabled) return;
        return this._requireHubAccepted('pushpricebatch', await this._call('pushpricebatch', batchData));
    }

    // Notify the hub that a reorg rolled back PRICE actions on this chain so it can
    // retract any price_snapshots / oracle_prices rows seeded from those actions.
    // sourceChain:     the chain this indexer serves (BTC/LTC/DOGE)
    // fromActionIndex: lowest rolled-back action_index; the hub deletes rows for
    //                  this source_chain whose action_index is >= this value.
    // toActionIndex (optional): upper bound for a CLOSED-range retraction. The live retraction
    // omits it (open-ended is safe before forward processing resumes); a DEFERRED retraction from
    // the queue passes it so a row re-published at A' inside the original range is not wiped.
    // retractionGeneration (optional): the rollback's PRE-bump push generation. Both the live and
    // deferred retractions carry it so the hub fences the delete to push_generation <= it,
    // leaving a row re-published at a recycled action_index (higher generation) intact.
    async retractPriceRange(sourceChain, fromActionIndex, toActionIndex, retractionGeneration){
        if(!this.enabled) return;
        let params = { source_chain: sourceChain, from_action_index: fromActionIndex };
        if(toActionIndex !== undefined && toActionIndex !== null) params.to_action_index = toActionIndex;
        if(retractionGeneration !== undefined && retractionGeneration !== null) params.retraction_generation = retractionGeneration;
        return this._requireHubAccepted('pushpricereorg', await this._call('pushpricereorg', params, this.reorgApiKey));
    }

    // Notify the hub that a reorg rolled back XCALL request actions on this chain so it
    // can retract any cross_chain_calls relay rows seeded from those requests. The hub
    // marks them 'retracted' and broadcasts deletions, so every indexer mirroring its
    // cross_chain_calls table purges the orphaned rows (otherwise a 'finalized' relay row
    // from an orphaned request stays eligible for re-injection on the target chain).
    // sourceChain:     the chain this indexer serves (BTC/LTC/DOGE)
    // fromActionIndex: lowest rolled-back action_index; the hub retracts relay rows for
    //                  this source_chain whose source_action_index is >= this value.
    // toActionIndex (optional): closed-range upper bound for a deferred retraction.
    // retractionGeneration (optional): see retractPriceRange.
    async retractXcallRange(sourceChain, fromActionIndex, toActionIndex, retractionGeneration){
        if(!this.enabled) return;
        let params = { source_chain: sourceChain, from_action_index: fromActionIndex };
        if(toActionIndex !== undefined && toActionIndex !== null) params.to_action_index = toActionIndex;
        if(retractionGeneration !== undefined && retractionGeneration !== null) params.retraction_generation = retractionGeneration;
        return this._requireHubAccepted('pushxcallreorg', await this._call('pushxcallreorg', params, this.reorgApiKey));
    }

    // Notify the hub that a reorg rolled back DEX ORDER actions on this chain so it can retract
    // any cross_chain_matches rows whose retracted leg references those orders. The hub marks the
    // matching matches 'retracted', restores both legs' remaining capacity, and broadcasts
    // deletions, so every indexer mirroring its cross_chain_matches table purges the orphaned rows
    // (otherwise a 'finalized' match against an orphaned order stays eligible for settlement).
    // sourceChain:     the chain this indexer serves (BTC/LTC/DOGE)
    // fromActionIndex: lowest rolled-back action_index; the hub retracts matches for this
    //                  source_chain whose a_action_index/b_action_index is >= this value.
    // toActionIndex (optional): closed-range upper bound for a deferred retraction.
    // retractionGeneration (optional): see retractPriceRange (fenced per-leg by the hub).
    async retractMatchRange(sourceChain, fromActionIndex, toActionIndex, retractionGeneration){
        if(!this.enabled) return;
        let params = { source_chain: sourceChain, from_action_index: fromActionIndex };
        if(toActionIndex !== undefined && toActionIndex !== null) params.to_action_index = toActionIndex;
        if(retractionGeneration !== undefined && retractionGeneration !== null) params.retraction_generation = retractionGeneration;
        return this._requireHubAccepted('pushdexreorg', await this._call('pushdexreorg', params, this.reorgApiKey));
    }

    // Throw on an application-level hub rejection a retry could still clear, so the durable
    // outbox RETAINS the row instead of deleting it. _call resolves any
    // error-free JSON-RPC envelope, so before this every rejection read as a delivery:
    // HubPushQueue._attempt called markHubPushDelivered and XChainIndexer's post-commit
    // path did the same, which destroyed the only remaining copy of a price the hub had
    // just refused for a transient reason (no validator snapshot, a hub DB error, an
    // aggregator still booting). Returns the result untouched when there is nothing wrong.
    _requireHubAccepted(method, result){
        let reason = hubRejectionReason(result);
        if(reason === null) return result;
        if(TERMINAL_HUB_REJECTIONS.some(rx => rx.test(reason))){
            // Terminal: a replay carries the same payload into the same verdict, so keep
            // today's drop. Never silently, though: a rail stopped by the ingest fence is a
            // standing condition an operator has to clear, and this is the log line that says so.
            console.warn('HubClient: ' + method + ' rejected terminally by the hub (' +
                reason + '); dropping the queued row');
            return result;
        }
        let err = new Error('hub rejected ' + method + ': ' + reason);
        err.hubRejection = reason;
        throw err;
    }

    _call(method, params, apiKeyOverride){
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
            let key = apiKeyOverride || this.apiKey;
            if(key) headers['x-api-key'] = key;

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
