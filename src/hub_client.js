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

// The THROWN counterpart of TERMINAL_HUB_REJECTIONS above. The hub's durable push
// handlers now answer a refusal of the call's own arguments with a JSON-RPC error rather
// than an in-result message, and _call rejects on a top-level `error` before
// _requireHubAccepted ever sees a payload, so without this every such push retried
// forever: the durable push types carry no attempt cap (hub_push_queue.js) and the queued
// row replays the same arguments into the same verdict on every drain.
//
// -32602 (Invalid params) is the only code here, and deliberately. It judges the PAYLOAD,
// which a replay cannot change. -32603 (Internal error), the hub's own -32029 throttle and
// every transport failure describe the HUB's state, which a later attempt can clear, so
// they stay retryable, on the same asymmetry the list above is built on: a needless retry
// costs a queue slot, a wrong drop costs a never-re-derivable oracle price.
const TERMINAL_HUB_RPC_CODES = new Set([-32602]);

// Read the terminal reason out of a REJECTION, or null when a retry could still clear it.
//
// Keyed on the code alone, never on the message. The patterns above are safe against a
// hub RESULT, whose text the hub authored, but a rejection's message can come from this
// client's own transport paths, and one of those reads 'Invalid JSON response: ...', which
// /^invalid\b/ matches. Classifying that terminal would drop a durable row on a truncated
// body. The code is only ever set from a parsed JSON-RPC envelope, so it cannot collide.
function terminalHubRejection(err){
    if(!err) return null;
    // A throttle is the hub declining to LOOK at the payload, never a verdict on it, and
    // it can carry an rpcCode; check it first so a future terminal code cannot swallow one.
    if(err.rateLimited) return null;
    // _call re-homes the envelope's code as rpcCode so it cannot collide with Node's own
    // string `code` on a socket error; `code` is still honoured when it is numeric, for a
    // caller that hands back the hub's error object as the hub stamped it.
    let code = (err.rpcCode !== undefined) ? err.rpcCode
             : (typeof err.code === 'number' ? err.code : undefined);
    if(!TERMINAL_HUB_RPC_CODES.has(code)) return null;
    return String(err.message || code);
}

// Read the application-level rejection out of a hub result, or null when the call was
// accepted. Covers BOTH shapes the hub uses: a check on `accepted` alone misses the
// api.js { error } path, and that path carries the transient failures (a hub still
// booting its aggregator, an unexpected exception inside a handler).
// The hub's own JSON-RPC code for "you are being rate limited"
// (xchain-hub/src/lib/rate_limit_policy.js). Keyed on rather than the HTTP status
// because a fronting proxy can rewrite the status while the envelope survives.
const HUB_RATE_LIMIT_RPC_CODE = -32029;

// Total wall-clock budget for one hub call, overridable with HUB_CALL_DEADLINE_MS.
// The `timeout` request option below is an IDLE-socket timer that resets on every byte
// received, so it bounds a silent socket and nothing else: a hub drip-feeding a body
// holds the call open forever inside it. Set far above any healthy push so the ceiling
// can only fire on a wedged request, never on a slow-but-live hub.
const HUB_CALL_DEADLINE_MS = 60000;

// Turn the hub's RateLimit-* / Retry-After headers into the facts a backoff needs.
// Present on BOTH the JSON 429 this client's own hub now sends and the plain-text
// 429 express-rate-limit sends by default, so an indexer talking to an older hub
// still learns the limit and the wait rather than reporting an unexplained parse
// error.
function readRateLimitHeaders(headers){
    headers = headers || {};
    let limit  = parseInt(headers['ratelimit-limit'] || headers['x-ratelimit-limit'], 10);
    let retry  = parseInt(headers['retry-after'], 10);
    if(!Number.isFinite(retry)) retry = parseInt(headers['ratelimit-reset'] || headers['x-ratelimit-reset'], 10);
    return {
        limit:        Number.isFinite(limit) ? limit : null,
        retryAfterMs: Number.isFinite(retry) && retry >= 0 ? retry * 1000 : null
    };
}

// Stamp an error as a throttle so callers can hold off instead of burning a
// delivery attempt on a row the hub never even looked at. See HubPushQueue._attempt.
function markRateLimited(err, facts){
    err.rateLimited = true;
    err.httpStatus  = facts.httpStatus || 429;
    err.hubRateLimit    = facts.limit != null ? facts.limit : null;
    // Default to one full minute: the hub's window is 60s, and waiting too long
    // costs a retry tick while waiting too little re-trips the same guard.
    err.retryAfterMs = facts.retryAfterMs != null ? facts.retryAfterMs : 60000;
    return err;
}

function hubRejectionReason(result){
    if(!result || typeof result !== 'object') return null;
    if(result.error) return String((result.error && result.error.message) || result.error);
    if(result.accepted === false)
        return (typeof result.reason === 'string' && result.reason) ? result.reason : 'rejected';
    return null;
}

class HubClient {

    constructor(hubUrl, apiKey, configUrl, configApiKey){
        this.hubUrl = hubUrl || process.env.HUB_API_URL || '';
        this.apiKey = apiKey || process.env.HUB_API_KEY || '';
        // The config oracle is not reachable over the mirror feed. getallconfigs returns
        // every service's connection parameters, DB user and password included, so the hub
        // keeps it off the public feed port: api.js admits only FEED_RPC_METHODS there and
        // answers everything else with -32601 'Method not available on this port'. Every
        // push method this client sends IS on that allowlist, so an indexer pointed at a
        // validator's feed port pushes and mirrors correctly and then fails its config poll
        // once a minute forever, silently freezing the hub-supplied params at their startup
        // values. Point HUB_CONFIG_URL at a private hub API port to separate the two roles.
        // Unset, both fall back to the feed values, so a single-hub deployment is unchanged.
        this.configUrl    = configUrl    || process.env.HUB_CONFIG_URL     || this.hubUrl;
        this.configApiKey = configApiKey || process.env.HUB_CONFIG_API_KEY || this.apiKey;
        // Interim credential scoping: when the hub gates its retraction rails
        // (push*reorg) behind a dedicated HUB_REORG_API_KEY, the reorg pushes
        // must carry that key; everything else keeps the bulk key.
        // Unset = legacy single-key behavior.
        this.reorgApiKey = process.env.HUB_REORG_API_KEY || this.apiKey;
        this.enabled = !!this.hubUrl;
        // Tracked separately from `enabled`: a deployment may carry a config oracle
        // without a push endpoint, and the config poll must not be gated on the feed.
        this.configEnabled = !!this.configUrl;
        // Wall-clock ceiling for a single _call; see HUB_CALL_DEADLINE_MS.
        let deadline = Number(process.env.HUB_CALL_DEADLINE_MS);
        this.callDeadlineMs = Number.isFinite(deadline) && deadline > 0 ? deadline : HUB_CALL_DEADLINE_MS;
    }

    // Read the hub's operational params. The one method here that is NOT on the hub's
    // feed-port allowlist, so it goes to configUrl (a private hub API port) rather than
    // hubUrl; see the constructor. Left as a thin wrapper over _call so callers never
    // have to know which endpoint a method belongs to.
    async getAllConfigs(){
        if(!this.configEnabled) return null;
        return this._call('getallconfigs', {}, this.configApiKey, this.configUrl);
    }

    // Push a chain tip update to the hub (fire-and-forget). Network is
    // optional; older hubs ignore it, newer ones use it to scope the
    // chain_tips entry so multi-network hubs don't collide on 'mainnet'.
    //
    // chainId is the block-1 hash of this chain, sent by the BITCOIN indexer only: it is
    // how the hub learns which Bitcoin chain instance it is serving, so it can stamp its
    // cross-chain rows with it and every mirror can refuse the rows of a chain that was
    // re-genesised out from under a hub database. Omitted from the params when absent, so
    // an older hub and every non-BTC indexer are on exactly the wire they were.
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
            await this._call('pushchaintip', params);
        } catch (err) {
            console.warn('HubClient: pushChainTip failed:', err);
        }
    }

    // Push a validated PRICE v0 round to the hub for cross-chain aggregation
    // The hub deduplicates by round_number into the unified price_snapshots table
    async pushPriceRound(roundData){
        if(!this.enabled) return;
        return this._push('pushpriceround', roundData);
    }

    // Push a validated PRICE v1 user oracle price to the hub for cross-chain aggregation
    async pushOraclePrice(priceData){
        if(!this.enabled) return;
        return this._push('pushoracleprice', priceData);
    }

    // Push a validated PRICE batch (a signed window of rounds) to the hub for cross-chain
    // aggregation via pushpricebatch. batchData mirrors pushPriceRound's payload one-for-one
    // (source_chain, btc_block_height, sigs, action_index, block_index, push_generation) plus
    // rounds[] carrying the window's per-round data and block_time, the landing block's own
    // time. block_time is required here (not just for a single round) because the hub keys its
    // pair-name flag day per round on it, and batching widens the hub/chain time skew from the
    // ~10 minutes a single round carries to ~70 minutes for a six-round window.
    async pushPriceBatch(batchData){
        if(!this.enabled) return;
        return this._push('pushpricebatch', batchData);
    }

    // Push a validated ATTEST batch (a signed window of finalized attestation responses,
    // parsed off the DOGE rail) to the hub via pushattestbatch. The hub re-verifies the
    // batch quorum, inserts the carried rows into the response mirror and re-serves them
    // to every BTC indexer through the ordinary mirror path, which is how a chain-only
    // node's mirror is rebuilt from chain parse alone.
    //
    // batchData is the delivery arm's payload verbatim: source_chain, network,
    // window_start, window_end, row_count, btc_block_height, rows[], sigs[], action_index,
    // block_index, block_time, push_generation. The hub destructures exactly those names,
    // so nothing here reshapes them. rows and sigs are the reassembled body as it came off
    // the chain, so the hub verifies the same bytes this node verified.
    async pushAttestBatch(batchData){
        if(!this.enabled) return;
        return this._push('pushattestbatch', batchData);
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
        return this._push('pushpricereorg', params, this.reorgApiKey);
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
        return this._push('pushxcallreorg', params, this.reorgApiKey);
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
        return this._push('pushdexreorg', params, this.reorgApiKey);
    }

    // Notify the hub that a reorg un-landed an ATTEST v5/v6 batch this chain carried, so
    // it can clear the batch link that landing stamped on every response the batch
    // carried (spec §6.3, frontier row 55).
    //
    // NOT A RANGE, and not a delete. The other three retractions above name a rolled-back
    // action range and the hub removes what that range seeded; this one names ONE batch,
    // because the hub-side effect is to NULL a single link column and never to remove a
    // row: a mirror row is legitimate whichever batch carried it (its federation
    // signatures are the authority), and on a chain-only node the batch-inserted row is
    // the only copy in existence. Clearing the link is also what lets the batch re-land,
    // since the hub sets that column only where it IS NULL.
    //
    // The batch is named by its key AND by the signed window bounds that key is derived
    // from, so the hub re-derives the key rather than trusting it, plus the action index
    // the landing push carried (the HEAD's, per row 52), which is the value stamped on
    // the rows. No generation fence: the mirror table has no push_generation column and
    // the link is cosmetic by construction (D78).
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
        return this._push('retractattestbatch', params, this.reorgApiKey);
    }

    // Deliver one push and judge BOTH shapes a hub refusal arrives in: the in-result message
    // _requireHubAccepted reads, and the JSON-RPC error _call rejects on. Every push method
    // above goes through here rather than calling _call directly, so the two shapes cannot
    // drift apart again.
    //
    // A terminal rejection is returned as { error: message }, which is byte for byte what
    // the hub itself returned for this same refusal before it moved the guard into the
    // error slot. Nothing downstream reads the value (HubPushQueue and XChainIndexer both
    // key on throw-versus-resolve alone), so the terminal verdict reaches them as the
    // delivered path and the queued row is dropped instead of replayed forever.
    async _push(method, params, apiKeyOverride){
        let result;
        try {
            result = await this._call(method, params, apiKeyOverride);
        } catch (err) {
            let reason = terminalHubRejection(err);
            if(reason === null) throw err;
            // Never silently: a rail the hub refuses on the payload is a standing condition
            // an operator has to clear, and this is the log line that says so. Worded like
            // the in-result branch below so one grep finds both.
            console.warn('HubClient: ' + method + ' rejected terminally by the hub (' +
                reason + '); dropping the queued row');
            return { error: reason };
        }
        return this._requireHubAccepted(method, result);
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

    _call(method, params, apiKeyOverride, urlOverride){
        return new Promise((settleResolve, settleReject) => {
            // Every exit runs through one latch, and the local `resolve`/`reject` below
            // ARE that latch: a hub that dies mid-body can fire several of the terminal
            // events, and a deadline abort races them all, so a direct settle would be a
            // double-settle. Shadowing the executor's own names keeps the classification
            // logic in the 'end' handler unchanged rather than restating it.
            let settled = false;
            let resolve = (v) => { if(!settled){ settled = true; settleResolve(v); } };
            let reject  = (e) => { if(!settled){ settled = true; settleReject(e); } };
            let parsed = url.parse(urlOverride || this.hubUrl);
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
                    let status = res.statusCode || 0;
                    let rl     = readRateLimitHeaders(res.headers);
                    let parsed;
                    try {
                        parsed = JSON.parse(data);
                    } catch (e) {
                        // A non-2xx with an unparseable body is a TRANSPORT verdict, not a
                        // malformed reply, and reporting it as "Invalid JSON response" hid the
                        // single most common one for a whole drill: express-rate-limit answers
                        // 429 with the text/html string "Too many requests, please try again
                        // later.", which surfaced downstream as `Unexpected token 'T'` and named
                        // neither the throttle nor the limit. Name the status, and
                        // for a 429 name the limit and the wait from the RateLimit-* headers.
                        if(status === 429){
                            let limitText = rl.limit != null ? rl.limit + ' req/min' : 'limit not advertised';
                            let waitText  = rl.retryAfterMs != null ? Math.round(rl.retryAfterMs / 1000) + 's' : 'unknown';
                            return reject(markRateLimited(new Error(
                                'hub rate limit exceeded (' + limitText + '); retry after ' + waitText +
                                ' [HTTP 429, non-JSON body]'), { limit: rl.limit, retryAfterMs: rl.retryAfterMs, httpStatus: status }));
                        }
                        if(status && (status < 200 || status >= 300))
                            return reject(Object.assign(
                                new Error('hub returned HTTP ' + status + ' with a non-JSON body: ' +
                                    String(data).slice(0, 200)),
                                { httpStatus: status }));
                        return reject(new Error('Invalid JSON response: ' + e.message));
                    }
                    if(parsed.error){
                        let err = new Error(parsed.error.message || JSON.stringify(parsed.error));
                        if(parsed.error.code !== undefined) err.rpcCode = parsed.error.code;
                        if(status) err.httpStatus = status;
                        // The hub's own JSON 429: the envelope already names the limit and the
                        // window, so the message needs no rewriting; it only needs classifying
                        // so HubPushQueue holds off instead of retrying into the same guard.
                        if(status === 429 || parsed.error.code === HUB_RATE_LIMIT_RPC_CODE){
                            let errData = parsed.error.data || {};
                            markRateLimited(err, {
                                limit:        Number.isFinite(errData.limit) ? errData.limit : rl.limit,
                                retryAfterMs: Number.isFinite(errData.retryAfterSeconds)
                                    ? errData.retryAfterSeconds * 1000 : rl.retryAfterMs,
                                httpStatus:   status || 429
                            });
                        }
                        return reject(err);
                    }
                    resolve(parsed.result);
                });
                // A hub that disconnects after its headers and a partial body aborts the
                // RESPONSE: 'end' never fires, and req 'error' never fires either because
                // the request itself completed. Without these three the promise stays
                // pending forever, HubPushQueue.drain() keeps `draining` latched across
                // its awaited _attempt, and every later tick returns at the overlap guard,
                // so the push queue stops for good with the rows neither acked nor retried.
                res.on('error',   (err) => { req.destroy(); reject(new Error('hub response error: ' + ((err && err.message) || err))); });
                res.on('aborted', ()    => { req.destroy(); reject(new Error('hub aborted the response before the body was complete')); });
                res.on('close',   ()    => {
                    if(res.complete) return;
                    req.destroy();
                    reject(new Error('hub closed the connection before the response body was complete'));
                });
            });
            req.on('error', (err) => reject(err));
            req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
            // The idle-socket timer above cannot bound a drip-fed body, so arm the
            // wall-clock ceiling beside it. Unref'd so it never holds the process open,
            // and cleared on the request's own teardown so a settled call drops it.
            let deadlineTimer = setTimeout(() => {
                req.destroy();
                reject(new Error('hub call exceeded its ' + this.callDeadlineMs + 'ms deadline'));
            }, this.callDeadlineMs);
            if(deadlineTimer.unref) deadlineTimer.unref();
            req.once('close', () => clearTimeout(deadlineTimer));
            req.write(body);
            req.end();
        });
    }
}

module.exports = HubClient;
module.exports.HUB_RATE_LIMIT_RPC_CODE = HUB_RATE_LIMIT_RPC_CODE;
module.exports.readRateLimitHeaders    = readRateLimitHeaders;
