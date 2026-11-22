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
 ********************************************************************/

'use strict';

const http   = require('http');
const https  = require('https');
const urllib = require('url');

function parseResponse(data){
    let payload;
    try {
        payload = JSON.parse(data);
    } catch(e){
        throw new Error('Invalid JSON response: ' + e.message);
    }
    if(payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
    return payload.result;
}

// A peer that drops the connection mid-body never emits 'end', and the request
// idle timeout is gone with the socket, so the response's own abort events must
// settle the call or it stays pending until the block watchdog.
function attachResponseHandlers(res, req, resolve, reject){
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        try {
            resolve(parseResponse(data));
        } catch(e){
            reject(e);
        }
    });
    res.on('error', (err) => {
        req.destroy();
        reject(new Error('Peer response error: ' + ((err && err.message) || err)));
    });
    res.on('aborted', () => {
        req.destroy();
        reject(new Error('Peer aborted the response before the body was complete'));
    });
    res.on('close', () => {
        if(res.complete) return;
        req.destroy();
        reject(new Error('Peer closed the connection before the response body was complete'));
    });
}

// The wall-clock bound for one proof call is the block watchdog, never the idle
// timeout: on a normal block a call still running when the watchdog fires belongs
// to a block attempt that was already abandoned, so cutting it there does not turn
// a slow but complete reply into a defer. It only stops a drip-fed reply from holding its socket and
// the abandoned pass open forever. Undefined means no wall-clock bound.
function blockWatchdogDeadline(config){
    let ms = Number((config || {})['BLOCK_PROCESS_TIMEOUT']);
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

// `timeoutMs` is the socket idle timeout. `deadlineMs`, when a positive number,
// bounds the whole call; callers pass blockWatchdogDeadline(config).
function postJsonRpc({ url, apiKey, method, params, timeoutMs, deadlineMs }){
    return new Promise((settleResolve, settleReject) => {
        let settled = false;
        let resolve = (value) => { if(!settled){ settled = true; settleResolve(value); } };
        let reject  = (error) => { if(!settled){ settled = true; settleReject(error); } };
        let parsed  = urllib.parse(url);
        let isHttps = parsed.protocol === 'https:';
        let lib     = isHttps ? https : http;
        let body    = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: method, params: params });
        let headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        if(apiKey) headers['x-api-key'] = apiKey;

        let req = lib.request({
            hostname: parsed.hostname,
            port:     parsed.port || (isHttps ? 443 : 80),
            path:     parsed.pathname || '/',
            method:   'POST',
            headers:  headers,
            timeout:  timeoutMs
        }, (res) => attachResponseHandlers(res, req, resolve, reject));
        req.on('error', (err) => reject(err));
        req.on('timeout', () => req.destroy(new Error('Request timeout')));

        if(Number.isFinite(deadlineMs) && deadlineMs > 0){
            let deadlineTimer = setTimeout(() => {
                req.destroy();
                reject(new Error('Peer JSON-RPC call exceeded its ' + deadlineMs + 'ms deadline'));
            }, deadlineMs);
            if(deadlineTimer.unref) deadlineTimer.unref();
            req.once('close', () => clearTimeout(deadlineTimer));
        }
        req.write(body);
        req.end();
    });
}

module.exports = { postJsonRpc, blockWatchdogDeadline };
