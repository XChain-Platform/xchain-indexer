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
 * XChain Indexer - Hub Client Transport
 *
 * The raw JSON-RPC-over-http(s) mechanics behind HubClient.call (../hub_client.js),
 * kept apart from the push/retract business methods. Nothing here knows about hub
 * method names or the price/attest/xcall domains; it only sends a JSON-RPC
 * envelope and classifies the reply.
 *
 ********************************************************************/

const http  = require('http');
const https = require('https');
const url   = require('url');

// The hub's own JSON-RPC code for "you are being rate limited"
// (xchain-hub/src/lib/rate_limit_policy.js). Keyed on rather than the HTTP status
// because a fronting proxy can rewrite the status while the envelope survives.
const HUB_RATE_LIMIT_RPC_CODE = -32029;

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
// delivery attempt on a row the hub never even looked at. See HubPushQueue.attempt.
function markRateLimited(err, facts){
    err.rateLimited = true;
    err.httpStatus  = facts.httpStatus || 429;
    err.hubRateLimit    = facts.limit != null ? facts.limit : null;
    // Default to one full minute: the hub's window is 60s, and waiting too long
    // costs a retry tick while waiting too little re-trips the same guard.
    err.retryAfterMs = facts.retryAfterMs != null ? facts.retryAfterMs : 60000;
    return err;
}

// Read a hub JSON-RPC response body into its result, or throw the classified error
// `call` rejects with. The 'end' handler below settles the latch with whichever one
// comes back, so the classification lives here and nowhere else.
function parseHubResponse(data, status, headers){
    let rl = readRateLimitHeaders(headers);
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
            throw markRateLimited(new Error(
                'hub rate limit exceeded (' + limitText + '); retry after ' + waitText +
                ' [HTTP 429, non-JSON body]'), { limit: rl.limit, retryAfterMs: rl.retryAfterMs, httpStatus: status });
        }
        if(status && (status < 200 || status >= 300))
            throw Object.assign(
                new Error('hub returned HTTP ' + status + ' with a non-JSON body: ' +
                    String(data).slice(0, 200)),
                { httpStatus: status });
        throw new Error('Invalid JSON response: ' + e.message);
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
        throw err;
    }
    return parsed.result;
}

// Wire the terminal socket/response events for one hub call onto resolve/reject.
// A hub that disconnects after its headers and a partial body aborts the RESPONSE:
// 'end' never fires, and req 'error' never fires either because the request itself
// completed. Without these three the promise stays pending forever, HubPushQueue.drain()
// keeps `draining` latched across its awaited attempt, and every later tick returns at
// the overlap guard, so the push queue stops for good with the rows neither acked nor
// retried.
function attachResponseHandlers(res, req, resolve, reject){
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        try {
            resolve(parseHubResponse(data, res.statusCode || 0, res.headers));
        } catch (err) {
            reject(err);
        }
    });
    res.on('error',   (err) => { req.destroy(); reject(new Error('hub response error: ' + ((err && err.message) || err))); });
    res.on('aborted', ()    => { req.destroy(); reject(new Error('hub aborted the response before the body was complete')); });
    res.on('close',   ()    => {
        if(res.complete) return;
        req.destroy();
        reject(new Error('hub closed the connection before the response body was complete'));
    });
}

// Make a JSON-RPC 2.0 request to the hub over http/https and settle with the parsed
// result. This owns the transport mechanics only; HubClient.call supplies the URL,
// key and deadline.
function sendHubRequest(targetUrl, method, params, apiKey, callDeadlineMs){
    return new Promise((settleResolve, settleReject) => {
        // Every exit runs through one latch, and the local `resolve`/`reject` below
        // ARE that latch: a hub that dies mid-body can fire several of the terminal
        // events, and a deadline abort races them all, so a direct settle would be a
        // double-settle. Shadowing the executor's own names keeps the classification
        // logic in the 'end' handler unchanged rather than restating it.
        let settled = false;
        let resolve = (v) => { if(!settled){ settled = true; settleResolve(v); } };
        let reject  = (e) => { if(!settled){ settled = true; settleReject(e); } };
        let parsed = url.parse(targetUrl);
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
        if(apiKey) headers['x-api-key'] = apiKey;

        let opts = {
            hostname: parsed.hostname,
            port:     parsed.port || (isHttps ? 443 : 80),
            path:     parsed.pathname || '/',
            method:   'POST',
            headers:  headers,
            timeout:  5000
        };

        let req = lib.request(opts, (res) => attachResponseHandlers(res, req, resolve, reject));
        req.on('error', (err) => reject(err));
        req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
        // The idle-socket timer above cannot bound a drip-fed body, so arm the
        // wall-clock ceiling beside it. Unref'd so it never holds the process open,
        // and cleared on the request's own teardown so a settled call drops it.
        let deadlineTimer = setTimeout(() => {
            req.destroy();
            reject(new Error('hub call exceeded its ' + callDeadlineMs + 'ms deadline'));
        }, callDeadlineMs);
        if(deadlineTimer.unref) deadlineTimer.unref();
        req.once('close', () => clearTimeout(deadlineTimer));
        req.write(body);
        req.end();
    });
}

module.exports = {
    sendHubRequest,
    HUB_RATE_LIMIT_RPC_CODE,
    readRateLimitHeaders
};
