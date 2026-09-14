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
 * XCALL v2: the Expire phase (system-synthesized).
 *
 * The deadline half of the exactly-once interlock the result pass (result.js)
 * shares: both flip request_status, and whichever reaches a terminal value
 * first decides which single outcome the requesting contract hears.
 *
 * Called with the handler as `this` (index.js delegates with .call).
 *
 ********************************************************************/

'use strict';

const { rethrowIfInfraFault } = require('../../consensus/fault_guard.js');
const { getLogger } = require('../../observability/index.js');

// XCALL v2: Expire (system-synthesized)
async function parseExpire(params, data, error){

    // System-synthesized only; guard against accidental synthesis from a user tx.
    if(!data['IS_SYNTHETIC']){
        getLogger().warn('\t XCALL v2 : rejected (user-broadcast not allowed for synthetic expire)');
        data['STATUS'] = 'invalid: XCALL v2 must be system-synthesized';
        return;
    }

    // Look up the request to expire. data['CALL_ID'] is set by
    // util.processCrossChainCalls from getExpiredCrossChainCallRequests.
    let callId  = String(data['CALL_ID'] || '').toLowerCase();
    let request = await this.indexerDb.getCrossChainCallRequestById(callId);

    // Bail if the request no longer exists or has already been resolved. This is the
    // exactly-once interlock shared with the result-callback pass: whichever path
    // flips request_status to a terminal value first wins; the other becomes a no-op.
    if(!request || request.request_status !== 'pending')
        return;

    // Synthesized actions arrive without an ACTION_INDEX; allocate one now.
    data['ACTION_INDEX'] = await this.indexerDb.createActionIndex({
        ACTION:      'XCALL',
        BLOCK_INDEX: data['BLOCK_INDEX'],
        FORMAT:      2
    }, true);

    data['STATUS'] = 'valid';

    getLogger().info("\t XCALL v2 : id=" + callId.substring(0,16) + '...' +
                ' : deadline=' + request.deadline_block +
                ' : block=' + data['BLOCK_INDEX']);

    // Flip request status to 'expired' BEFORE injecting (interlock order).
    await this.indexerDb.updateCrossChainCallRequestStatus(callId, 'expired', 'expired', '', data['BLOCK_INDEX']);

    // Synthesize the callback EXECUTE so the contract can clean up (status='expired').
    try {
        await this.injectCallback(request, data, 'expired', '');
    } catch(e){
        // An infra fault (VM host down, DB driver errno) is not a callback outcome:
        // halt so the block retries, instead of committing a locally-dropped
        // callback that forks contract_hash against healthy peers (consensus/fault_guard.js).
        rethrowIfInfraFault(e);
        getLogger().warn('XCALL expiry callback failed:', e);
    }

    await this.mapper.createMappings(data);
}

module.exports = { parseExpire };
