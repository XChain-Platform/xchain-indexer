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

const { getLogger } = require('../observability/index.js');
const { CONFIG_ENV } = require('../config.js');
const { sendHubRequest, HUB_RATE_LIMIT_RPC_CODE, readRateLimitHeaders } = require('./hub_client/request.js');
const { resolveConfigEndpoint } = require('./hub_client/config_endpoint.js');
const { readEnvNow } = require('./hub_db_sync/env.js');
// Hub rejections inside a successful JSON-RPC envelope ({accepted:false,reason}, {error}) that a
// replay can never clear, since a queued row replays the payload byte for byte; unknown reasons stay
// retryable. 'insufficient quorum|signer stake' are absent on purpose: the hub counts sigs on its own snapshot.
const TERMINAL_HUB_REJECTIONS = [
    /^duplicate$/i,                        // the hub already holds this action key
    /^stale \(retracted generation\)$/i,   // ingest fence; it only ever hardens
    /^invalid\b/i,                         // structural reject of the payload's own fields
    /\b(is|are) required$/i,               // api.js missing-field guards
    /^chain must be one of\b/i             // api.js validateChain
];

// Per-method terminal replies for the reorg retractions. A hub without peers never builds its
// cross-chain call, dex or bridge engine, so it holds no relay, match or transfer rows and a
// retraction aimed at that engine has nothing to undo. Left retryable, the reply keeps the
// uncapped *_retraction rows pending forever and every reorg that orphans an action adds three.
// Keyed on the method so only the reply from the engine a retraction targets drops it; a forward
// push answered the same way keeps its row, since it may be needed once the engine is up.
const TERMINAL_REORG_REJECTIONS = {
    pushxcallreorg:  /^cross-chain call engine not active$/i,
    pushdexreorg:    /^cross-chain dex engine not active$/i,
    pushbridgereorg: /^cross-chain bridge engine not active$/i
};

function isTerminalInResultRejection(method, reason){
    if(TERMINAL_HUB_REJECTIONS.some(rx => rx.test(reason))) return true;
    let reorgRx = Object.prototype.hasOwnProperty.call(TERMINAL_REORG_REJECTIONS, method)
        ? TERMINAL_REORG_REJECTIONS[method] : null;
    return reorgRx !== null && reorgRx.test(reason);
}

// Thrown JSON-RPC codes a replay can never clear: only -32602 (Invalid params) judges the payload.
// -32603, the -32029 throttle and transport errors describe hub state and stay retryable; durable
// push types have no attempt cap, so a terminal code left retryable would replay forever.
const TERMINAL_HUB_RPC_CODES = new Set([-32602]);

// Terminal reason of a REJECTION, or null when a retry could still clear it. Keyed on the code, never
// the message: client transport text ('Invalid JSON response') matches /^invalid\b/ and would drop a
// durable row on a truncated body.
function terminalHubRejection(err){
    if(!err) return null;
    // A throttle is the hub declining to LOOK at the payload, never a verdict on it, and
    // it can carry an rpcCode; check it first so a future terminal code cannot swallow one.
    if(err.rateLimited) return null;
    // call re-homes the envelope's code as rpcCode so it cannot collide with Node's own
    // string `code` on a socket error; `code` is still honoured when it is numeric, for a
    // caller that hands back the hub's error object as the hub stamped it.
    let code = (err.rpcCode !== undefined) ? err.rpcCode
             : (typeof err.code === 'number' ? err.code : undefined);
    if(!TERMINAL_HUB_RPC_CODES.has(code)) return null;
    return String(err.message || code);
}

// Total wall-clock budget for one hub call (env HUB_CALL_DEADLINE_MS). The request `timeout` is an idle-socket
// timer reset by every byte, so this sits far above a healthy push and fires only on a wedged request.
const HUB_CALL_DEADLINE_MS = 60000;

// Rejection reason out of a hub result, or null when accepted. Checks both shapes: `accepted` alone
// misses the api.js { error } path, which carries the transient failures.

function hubRejectionReason(result){
    if(!result || typeof result !== 'object') return null;
    if(result.error) return String((result.error && result.error.message) || result.error);
    if(result.accepted === false)
        return (typeof result.reason === 'string' && result.reason) ? result.reason : 'rejected';
    return null;
}

class HubClient {

    // The transport layer (./hub_client/request.js) owns the hub's rate-limit code and
    // header reader; they ride the class as static fields so a caller reading them off
    // this module's export finds them there, with the class as the one export shape.
    static HUB_RATE_LIMIT_RPC_CODE = HUB_RATE_LIMIT_RPC_CODE;
    static readRateLimitHeaders    = readRateLimitHeaders;

    constructor(hubUrl, apiKey, configUrl, configApiKey){
        this.hubUrl = hubUrl || CONFIG_ENV.HUB_API_URL || '';
        this.apiKey = apiKey || CONFIG_ENV.HUB_API_KEY || '';
        // getallconfigs returns every service's DB credentials, so the hub keeps it off its public feed port
        // (-32601); HUB_CONFIG_URL points at a private API port, and unset it falls back to the API endpoint,
        // while a feed-port-only indexer's config poll fails silently.
        let configEndpoint = resolveConfigEndpoint({
            configUrl: configUrl || CONFIG_ENV.HUB_CONFIG_URL,
            apiUrl: this.hubUrl,
            seedUrls: readEnvNow('HUB_SEED_URLS'),
            configApiKey: configApiKey || CONFIG_ENV.HUB_CONFIG_API_KEY,
            apiKey: this.apiKey
        });
        this.configUrl     = configEndpoint.url;
        this.configApiKey  = configEndpoint.apiKey;
        this.configEnabled = configEndpoint.enabled;
        if(configEndpoint.notice) getLogger().warn(configEndpoint.notice);
        // Retraction rails (push*reorg) use HUB_REORG_API_KEY when the hub gates them behind it;
        // unset keeps the single bulk key.
        this.reorgApiKey = CONFIG_ENV.HUB_REORG_API_KEY || this.apiKey;
        this.enabled = !!this.hubUrl;
        // Wall-clock ceiling for a single call; see HUB_CALL_DEADLINE_MS.
        let deadline = Number(CONFIG_ENV.HUB_CALL_DEADLINE_MS);
        this.callDeadlineMs = Number.isFinite(deadline) && deadline > 0 ? deadline : HUB_CALL_DEADLINE_MS;
        this.selectorAddressSource = null;
        this.selectorCandidateSource = null;
    }

    setAddressSource(fn){
        this.selectorAddressSource = (typeof fn === 'function') ? fn : null;
        let selected = this.selectorAddressSource && this.selectorAddressSource();
        this.enabled = !!this.hubUrl || (typeof selected === 'string' && selected.length > 0);
    }

    setCandidateSource(fn){
        this.selectorCandidateSource = (typeof fn === 'function') ? fn : null;
    }

    // Read the hub's operational params; the one method off the feed-port allowlist, so it goes to
    // configUrl (a private API port) rather than hubUrl.
    async getAllConfigs(){
        if(!this.configEnabled) return null;
        return this.call('getallconfigs', {}, this.configApiKey, this.configUrl);
    }

    // Push a chain tip update (fire-and-forget); network scopes chain_tips on multi-network hubs. chainId
    // (block-1 hash) is sent by the BITCOIN indexer only, so the hub can stamp cross-chain rows and mirrors
    // refuse a re-genesised chain; omitted when absent, so older hubs see the same wire.
    async pushChainTip(coin, network, blockHeight, blockTime, chainId){
        if(!this.enabled) return;
        try {
            let params = {
                coin:         coin,
                network:      network,
                block_height: blockHeight,
                block_time:   blockTime
            };
            if(chainId !== null && chainId !== undefined) params.chain_id = chainId;
            let candidateStatus = this.selectorCandidateSource && this.selectorCandidateSource();
            if(candidateStatus && candidateStatus.pinned === false &&
               Array.isArray(candidateStatus.candidates)){
                let results = await Promise.allSettled(candidateStatus.candidates.map((url) =>
                    this.call('pushchaintip', params, undefined, url)));
                for(let result of results){
                    if(result.status === 'rejected')
                        getLogger().warn('HubClient: pushChainTip failed:', result.reason);
                }
                return;
            }
            await this.call('pushchaintip', params);
        } catch (err) {
            // Best-effort: log and continue
            getLogger().warn('HubClient: pushChainTip failed:', err);
        }
    }

    // Push a validated PRICE v0 round to the hub for cross-chain aggregation
    // The hub deduplicates by round_number into the unified price_snapshots table
    async pushPriceRound(roundData){
        if(!this.enabled) return;
        return this.push('pushpriceround', roundData);
    }

    // Push a validated PRICE v1 user oracle price to the hub for cross-chain aggregation
    async pushOraclePrice(priceData){
        if(!this.enabled) return;
        return this.push('pushoracleprice', priceData);
    }

    // Push a validated PRICE batch (signed window of rounds) via pushpricebatch; batchData mirrors pushPriceRound
    // plus rounds[] and block_time, required because the hub keys its per-round pair-name flag day on it and
    // batching widens the hub/chain time skew to ~70 minutes.
    async pushPriceBatch(batchData){
        if(!this.enabled) return;
        return this.push('pushpricebatch', batchData);
    }

    // Push a validated ATTEST batch (finalized responses parsed off the DOGE rail) via pushattestbatch; the hub
    // re-verifies quorum and re-serves the rows through the mirror. batchData is the delivery arm's payload
    // verbatim (the hub destructures exact names), rows and sigs as they came off the chain.
    async pushAttestBatch(batchData){
        if(!this.enabled) return;
        return this.push('pushattestbatch', batchData);
    }

    // Retract PRICE rows seeded by rolled-back actions: fromActionIndex (lowest rolled-back, the hub deletes >=),
    // optional toActionIndex (closed range for a deferred retraction), retractionGeneration (PRE-bump; fences the
    // delete to push_generation <=) and batches [{first_round,last_round,block_time?}] to clear each landing's clock.
    async retractPriceRange(sourceChain, fromActionIndex, toActionIndex, retractionGeneration, batches){
        if(!this.enabled) return;
        let params = { source_chain: sourceChain, from_action_index: fromActionIndex };
        if(toActionIndex !== undefined && toActionIndex !== null) params.to_action_index = toActionIndex;
        if(retractionGeneration !== undefined && retractionGeneration !== null) params.retraction_generation = retractionGeneration;
        if(Array.isArray(batches) && batches.length > 0) params.batches = batches;
        return this.push('pushpricereorg', params, this.reorgApiKey);
    }

    // Retract XCALL relay rows (cross_chain_calls) seeded by rolled-back requests; the hub marks them 'retracted'
    // and broadcasts deletions so no orphan stays eligible for re-injection. Params as retractPriceRange; matches
    // source_action_index >= fromActionIndex.
    async retractXcallRange(sourceChain, fromActionIndex, toActionIndex, retractionGeneration){
        if(!this.enabled) return;
        let params = { source_chain: sourceChain, from_action_index: fromActionIndex };
        if(toActionIndex !== undefined && toActionIndex !== null) params.to_action_index = toActionIndex;
        if(retractionGeneration !== undefined && retractionGeneration !== null) params.retraction_generation = retractionGeneration;
        return this.push('pushxcallreorg', params, this.reorgApiKey);
    }

    // Retract cross_chain_matches whose leg references a rolled-back DEX ORDER; the hub marks them 'retracted',
    // restores both legs' capacity and broadcasts deletions. Params as retractPriceRange; matches
    // a_action_index/b_action_index >= fromActionIndex, fenced per leg.
    async retractMatchRange(sourceChain, fromActionIndex, toActionIndex, retractionGeneration){
        if(!this.enabled) return;
        let params = { source_chain: sourceChain, from_action_index: fromActionIndex };
        if(toActionIndex !== undefined && toActionIndex !== null) params.to_action_index = toActionIndex;
        if(retractionGeneration !== undefined && retractionGeneration !== null) params.retraction_generation = retractionGeneration;
        return this.push('pushdexreorg', params, this.reorgApiKey);
    }

    // Retract bridge_transfers whose SOURCE leg sits in a rolled-back XBRIDGE range; the hub marks them 'retracted',
    // releases the source-leg guard and broadcasts deletions. Params as retractPriceRange; matches
    // src_action_index >= fromActionIndex, fenced on push_generation.
    async retractBridgeRange(sourceChain, fromActionIndex, toActionIndex, retractionGeneration){
        if(!this.enabled) return;
        let params = { source_chain: sourceChain, from_action_index: fromActionIndex };
        if(toActionIndex !== undefined && toActionIndex !== null) params.to_action_index = toActionIndex;
        if(retractionGeneration !== undefined && retractionGeneration !== null) params.retraction_generation = retractionGeneration;
        return this.push('pushbridgereorg', params, this.reorgApiKey);
    }

    // Un-land an ATTEST v5/v6 batch after a reorg: NOT a range retraction and never a delete, the hub only NULLs the
    // batch link so the batch can re-land (mirror rows stay legitimate). Sends batch_key with its window bounds (the hub
    // re-derives the key) and the landing push's action_index; no generation fence.
    async retractAttestBatch(sourceChain, retraction){
        if(!this.enabled) return;
        let params = {
            source_chain: sourceChain,
            network:      retraction.network,
            batch_key:    retraction.batch_key,
            window_start: retraction.window_start,
            window_end:   retraction.window_end,
            action_index: retraction.action_index
        };
        return this.push('retractattestbatch', params, this.reorgApiKey);
    }

    // Deliver one push and judge both refusal shapes (the in-result message requireHubAccepted reads, the JSON-RPC
    // error call rejects on). A terminal rejection resolves as { error } like the in-result path, because queue and
    // indexer key on throw-versus-resolve alone, so the row is dropped, not replayed forever.
    async push(method, params, apiKeyOverride){
        let result;
        try {
            result = await this.call(method, params, apiKeyOverride);
        } catch (err) {
            let reason = terminalHubRejection(err);
            if(reason === null) throw err;
            // Never silently: a rail the hub refuses on the payload is a standing condition
            // an operator has to clear, and this is the log line that says so. Worded like
            // the in-result branch below so one grep finds both.
            getLogger().warn('HubClient: ' + method + ' rejected terminally by the hub (' +
                reason + '); dropping the queued row');
            return { error: reason };
        }
        return this.requireHubAccepted(method, result);
    }

    // Throw on a missing acknowledgement or a hub rejection a retry could still clear, so
    // the durable outbox keeps the row. Returns an acknowledged result untouched otherwise.
    requireHubAccepted(method, result){
        if(result === null || typeof result !== 'object' || Array.isArray(result)){
            let err = new Error('hub returned no acknowledgement for ' + method);
            err.hubRejection = 'no acknowledgement';
            throw err;
        }
        let reason = hubRejectionReason(result);
        if(reason === null) return result;
        if(isTerminalInResultRejection(method, reason)){
            // Terminal: a replay carries the same payload into the same verdict, so keep
            // today's drop. Never silently, though: a rail stopped by the ingest fence is a
            // standing condition an operator has to clear, and this is the log line that says so.
            getLogger().warn('HubClient: ' + method + ' rejected terminally by the hub (' +
                reason + '); dropping the queued row');
            return result;
        }
        let err = new Error('hub rejected ' + method + ': ' + reason);
        err.hubRejection = reason;
        throw err;
    }

    // Make a JSON-RPC 2.0 call to the hub. The http(s) request, response parsing and
    // rate-limit classification live in ./hub_client/request.js, which knows nothing of
    // hub method names; this wrapper supplies the client's own URL, key and deadline.
    call(method, params, apiKeyOverride, urlOverride){
        let key = apiKeyOverride || this.apiKey;
        let address = this.hubUrl;
        if(!urlOverride && this.selectorAddressSource){
            let sourcedAddress = this.selectorAddressSource();
            if(typeof sourcedAddress === 'string' && sourcedAddress.length > 0)
                address = sourcedAddress;
        }
        return sendHubRequest(urlOverride || address, method, params, key, this.callDeadlineMs);
    }
}

module.exports = HubClient;
