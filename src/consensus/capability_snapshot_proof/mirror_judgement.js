/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict';

const { resolveTrustSet } = require('./trust_set.js');

function held(reason){
    return { verdict: 'held', reason, firstUse: false };
}

function errorMessage(error){
    if(error && typeof error.message === 'string') return error.message;
    return String(error);
}

async function judgeMirroredCapabilityRow(row, opts, verifyProof){
    if(!opts || typeof opts.fetchProof !== 'function')
        return held('fetchProof is required');
    if(typeof verifyProof !== 'function')
        return held('verifier is required');

    let response;
    try {
        response = await opts.fetchProof(
            row.snapshot_block, row.capability, [row.signing_pubkey]);
    } catch(error){
        return held(errorMessage(error));
    }
    if(!response || typeof response !== 'object' || Array.isArray(response))
        return held('proof response is missing');

    let resolved;
    try {
        resolved = resolveTrustSet(opts.network, row.snapshot_block, opts.readEnv);
    } catch(error){
        return held(errorMessage(error));
    }
    if(resolved.held) return held(resolved.reason);

    let result;
    try {
        const verifyOpts = {
            network: opts.network,
            firstUse: resolved.firstUse,
        };
        if(typeof opts.noteFirstUseSet === 'function')
            verifyOpts.noteFirstUseSet = opts.noteFirstUseSet;
        result = await verifyProof(row, response, resolved.trustSet, verifyOpts);
    } catch(error){
        return held(errorMessage(error));
    }

    if(!result || !['verified', 'refused', 'held'].includes(result.verdict))
        return held('verifier returned an unknown verdict');
    return {
        verdict: result.verdict,
        reason: result.reason,
        firstUse: resolved.firstUse,
    };
}

module.exports = { judgeMirroredCapabilityRow };
