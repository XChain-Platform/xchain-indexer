/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Platform - DEPLOY: obtaining the contract source
 *
 * Turns a v0-v3 DEPLOY's wire fields into the UTF-8 contract source: a
 * chunked deploy assembles it from its prior v4 carriers (or holds a
 * deferred verdict when the group is not complete yet), an inline deploy
 * decodes CODE_ENCODING. A part of actions/deploy/index.js, called from
 * parse() just before the deployment runs.
 *
 ********************************************************************/

/**
 * Obtain the contract source and any held chunk verdict.
 *
 * @param {Deploy}  deploy     the DEPLOY handler (actions, util, indexerDb, chunkStore)
 * @param {object}  data       the DEPLOY's transaction context, number formats applied
 * @param {boolean} isChunked  v2/v3 (assemble) rather than v0/v1 (decode inline)
 * @param {?string} error      a verdict already reached, or null
 * @returns {Promise<{code: string, error: ?string, pendingCodeHash: ?string, deferredError: ?string}>}
 */
async function obtainCode(deploy, data, isChunked, error){

    /*****************************************************************
     * Code Validations
     ****************************************************************/

    // Obtain the contract source `code`. Chunked (v2/v3) assembles base64(code) from the
    // deployer's prior v4 carrier rows then decodes + sha256-verifies it; inline (v0/v1)
    // decodes CODE_ENCODING directly. Post-activation the encoding is base64; pre-activation
    // it is hex (the original format), gated on block_time so a replay/heterogeneous fleet
    // decodes historical DEPLOYs identically. Either way `code` is the UTF-8 source that
    // flows into the SHARED size / syntax / manifest / gas / constructor path below.
    // (base64 is 1.33x vs hex's 2x and has no '|', so it is delimiter-safe;
    // Buffer.from is lenient, so we round-trip to reject non-canonical base64 deterministically.)
    let code = '';
    // A chunk verdict this assembler must not commit to until the fee and sleeping checks
    // have run (deferred assembly). Both stay null pre-activation and on every inline deploy, so the path
    // below is the one this file has always taken.
    let pendingCodeHash = null;  // deferred: land pending under the DECLARED hash
    let deferredError   = null;  // duplicate pending: a verdict the fee/sleeping rejects still win over
    // Assemble the contract's code from its stored chunks when this deploy is chunked
    if(!error && isChunked){
        ({ code, error, pendingCodeHash, deferredError } = await assembleChunkedCode(deploy, data, error));
    } else if(!error){
        ({ code, error } = await decodeInlineCode(deploy, data, error));
    }
    return { code, error, pendingCodeHash, deferredError };
}

/**
 * A chunked (v2/v3) DEPLOY's source, assembled from its deployer's prior carriers.
 *
 * @param {Deploy}  deploy  the DEPLOY handler (actions, indexerDb, chunkStore)
 * @param {object}  data    the DEPLOY's transaction context
 * @param {?string} error   the (empty) verdict so far, returned unchanged on a deferred landing
 * @returns {Promise<{code: string, error: ?string, pendingCodeHash: ?string, deferredError: ?string}>}
 */
async function assembleChunkedCode(deploy, data, error){
    let pendingCodeHash = null;
    let deferredError   = null;
    let declaredHash = String(data['CODE_HASH_PARAM']);
    // Assembly is the chunk store's routine so the deferred path at a completing
    // carrier runs byte-identical dedup / range / decode / sha256 checks; the bound is
    // exclusive, so an assembler assembles from carriers strictly below it.
    let assembly = await deploy.chunkStore.assembleCode(data['SOURCE'], declaredHash, data['ACTION_INDEX']);
    let code = assembly.code;
    // Deferred assembly, post-activation and only for a group that is NOT complete yet ('no chunks' /
    // 'missing chunk i'). Every other assembly verdict (bad hash format, count out of
    // range, bad base64, assembly mismatch) is terminal: the group cannot be repaired by
    // a later carrier, since dedup keeps the LOWEST action_index for each position.
    if(assembly.incomplete && await deploy.actions.protocolChanges.isEnabled('DEPLOY_DEFERRED_ASSEMBLY', data['BLOCK_INDEX'])){
        // One pending assembler per group: without this, a second pending assembler
        // would be re-armed by any later duplicate slice and deploy a surprise second
        // contract. The lookup is bounded below this action, so it never sees itself.
        let pending = await deploy.indexerDb.getPendingDeployAssembler(data['SOURCE'], declaredHash, data['ACTION_INDEX']);
        if(pending)
            deferredError = 'invalid: CODE_HASH (duplicate pending)';
        else
            pendingCodeHash = declaredHash;
    } else {
        error = assembly.error;
    }
    return { code, error, pendingCodeHash, deferredError };
}

/**
 * An inline (v0/v1) DEPLOY's source, decoded from CODE_ENCODING by the era's encoding.
 *
 * @param {Deploy}  deploy  the DEPLOY handler (actions, util)
 * @param {object}  data    the DEPLOY's transaction context
 * @param {?string} error   the (empty) verdict so far
 * @returns {Promise<{code: string, error: ?string}>}
 */
async function decodeInlineCode(deploy, data, error){
    let code = '';
    if(deploy.util.isNull(data['CODE_ENCODING'])){
        error = 'invalid: CODE_ENCODING (required)';
    } else if(await deploy.actions.protocolChanges.isEnabled('DEPLOY_BASE64_CODE', data['BLOCK_INDEX'])){
        // Post-activation: base64. 1.33x vs hex's 2x and no '|', so delimiter-safe.
        // Buffer.from(...,'base64') is lenient, so round-trip to reject non-canonical
        // base64 deterministically across nodes.
        try {
            let b64 = String(data['CODE_ENCODING']);
            code = Buffer.from(b64, 'base64').toString('utf8');
            if(Buffer.from(code, 'utf8').toString('base64') !== b64)
                error = 'invalid: CODE_ENCODING (base64 decode failed)';
        } catch(e){
            error = 'invalid: CODE_ENCODING (base64 decode failed)';
        }
    } else {
        // Pre-activation: hex. Byte-for-byte the original pre-base64 decode so a
        // from-genesis replay reproduces every historical inline DEPLOY's code_hash
        // exactly. Deliberately NO round-trip check; the historical nodes did not
        // round-trip hex, and matching their (lenient) behaviour is the whole point
        // of the gate.
        try {
            code = Buffer.from(data['CODE_ENCODING'], 'hex').toString('utf8');
        } catch(e){
            error = 'invalid: CODE_ENCODING (hex decode failed)';
        }
    }
    return { code, error };
}

module.exports = { obtainCode };
