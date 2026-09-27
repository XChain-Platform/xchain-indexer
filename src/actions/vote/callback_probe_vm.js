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
 * XChain Platform Action - VOTE callback manifest probe VM
 *
 ********************************************************************/

'use strict';

const { MAX_CODE_SIZE } = require('../../protocol/constants.js');

const CALLBACK_METHOD_MAX_CHARS = 64;
const JSON_ESCAPE_MAX_BYTES_PER_CHAR = 6;
const PROBE_PREFIX = '\n;module.exports={initialize:(typeof module.exports==="function"||typeof module.exports[';
const PROBE_SUFFIX = ']==="function")?function(){}:null};';
const LISTING_PROBE_SUFFIX = '\n;(()=>{let E=module.exports,L=[];if(typeof E==="function")L="*";else if(E!=null){let S=new Set(),O=Object(E);while(O!==null){for(let N of Object.getOwnPropertyNames(O)){if(typeof N==="string"&&N.length<=' +
    CALLBACK_METHOD_MAX_CHARS + '&&!S.has(N)){S.add(N);try{if(typeof E[N]==="function")L.push(N)}catch(e){}}}O=Object.getPrototypeOf(O)}}module.exports={initialize:null,meta:{callbackFns:L}}})();';

// Reserve enough VM input for the fixed probe syntax plus a method whose every
// UTF-16 code unit needs JSON's six-byte \uXXXX escape.
const METHOD_PROBE_SUFFIX_ALLOWANCE = Buffer.byteLength(PROBE_PREFIX + '""' + PROBE_SUFFIX, 'utf8') +
    CALLBACK_METHOD_MAX_CHARS * JSON_ESCAPE_MAX_BYTES_PER_CHAR;
const PROBE_SUFFIX_ALLOWANCE = Math.max(
    METHOD_PROBE_SUFFIX_ALLOWANCE,
    Buffer.byteLength(LISTING_PROBE_SUFFIX, 'utf8')
);

// Append the non-dispatching initialize probe and enforce the derived allowance
// before code reaches the VM configured to accept it.
function buildProbeCode(code, method){
    let suffix = PROBE_PREFIX + JSON.stringify(String(method)) + PROBE_SUFFIX;
    if(Buffer.byteLength(suffix, 'utf8') > PROBE_SUFFIX_ALLOWANCE)
        throw new Error('VOTE callback manifest probe suffix exceeds its configured allowance');
    return String(code) + suffix;
}

// Append one method-independent inspection suffix so the VM can reuse its code-text
// caches for every callback method on the same contract.
function buildListingProbeCode(code){
    return String(code) + LISTING_PROBE_SUFFIX;
}

// Convert a complete callback listing into the same boolean produced by the
// per-method probe, or request that probe when the listing cannot be trusted.
function listingVerdict(manifest, method){
    if(!manifest || manifest.metaOversize === true || manifest.metaError === true ||
        typeof manifest.metaJson !== 'string') return null;
    let parsed;
    try { parsed = JSON.parse(manifest.metaJson); } catch(e) { return null; }
    let callbackFns = parsed && parsed.callbackFns;
    if(callbackFns === '*') return true;
    if(!Array.isArray(callbackFns) || !callbackFns.every(name => typeof name === 'string')) return null;
    return callbackFns.includes(String(method));
}

// Copy the main VM's execution mode, gas settings and limits so the probe differs
// only in admitting its bounded inspection suffix beyond stored contract code.
function createProbeVm(actions){
    let mainVm = actions.vm;
    let ProbeVm = mainVm && mainVm.constructor;
    if(typeof ProbeVm !== 'function')
        throw new Error('VOTE callback admission requires a size-adjustable manifest reader');
    return new ProbeVm({
        execution:   mainVm.execution,
        gasSchedule: mainVm.gasSchedule,
        gasCeiling:  mainVm.gasCeiling,
        limits: Object.assign({}, mainVm.limits, {
            maxCodeSize: MAX_CODE_SIZE + PROBE_SUFFIX_ALLOWANCE
        })
    });
}

// Create one probe worker on first use and retain it on the Actions instance.
function getProbeVm(actions){
    if(!actions.voteCallbackProbeVm)
        actions.voteCallbackProbeVm = createProbeVm(actions);
    return actions.voteCallbackProbeVm;
}

// Detach before awaiting shutdown so a failed worker cannot be returned to a
// later VOTE while its teardown is still settling.
async function discardProbeVm(actions, expectedVm){
    let probeVm = actions.voteCallbackProbeVm;
    if(!probeVm || (expectedVm && probeVm !== expectedVm)) return;
    actions.voteCallbackProbeVm = null;
    if(typeof probeVm.shutdown === 'function') await probeVm.shutdown();
}

module.exports = {
    CALLBACK_METHOD_MAX_CHARS,
    PROBE_SUFFIX_ALLOWANCE,
    buildProbeCode,
    buildListingProbeCode,
    listingVerdict,
    getProbeVm,
    discardProbeVm
};
