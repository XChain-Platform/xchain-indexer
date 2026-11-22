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
 * XChain Indexer - stored callback params reader
 *
 * The one place a stored request's callback_params_json becomes the list of
 * developer params a synthesized callback receives, shared by the ATTEST
 * response and expiry paths and the XCALL callback path.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../observability/index.js');

// The callback params the request carries, or none when the stored JSON cannot be
// read as an array. The request wire does not validate this field, so a requester
// can store text or a non-list value. The fallback is the same on every node, so the
// callback input stays deterministic; the warning is what makes the substitution
// visible on the expiry and refund paths, where a callback that settles escrow runs
// with none.
function callbackParamsOf(request, label){
    if(!request.callback_params_json) return [];

    let parsed;
    try {
        parsed = JSON.parse(request.callback_params_json);
    } catch(e){
        getLogger().warn(label + ': malformed callback_params_json for request ' + requestKey(request) +
                         '..., using empty params:', e.message);
        return [];
    }
    if(Array.isArray(parsed)) return parsed;

    getLogger().warn(label + ': callback_params_json for request ' + requestKey(request) +
                     '... is not a JSON array, using empty params');
    return [];
}

function requestKey(request){
    return String(request.request_id !== undefined ? request.request_id : request.call_id).substring(0, 16);
}

module.exports = { callbackParamsOf };
