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
 * XChain Indexer - ATTEST handler part
 *
 * ATTEST v2: the system-synthesized expiry leg.
 *
 * A v2 is an internal lifecycle marker, not a response and not a broadcast.
 * Its generic action row intentionally contains only ACTION, BLOCK_INDEX and
 * FORMAT. The database therefore stores null transaction/source fields and no
 * request, signature or response binding on that row. REQUEST_ID exists only
 * in the sweep's in-memory context so this handler can resolve the original v0
 * request; the contract callback is a separate synthesized EXECUTE action.
 * ATTEST_ZERO_CONF_ACTIVATION applies to fulfilled response fee splitting and
 * has no bearing on whether, when or how this expiry row is synthesized.
 *
 * Installed onto Attest.prototype by actions/attest/index.js, so call sites stay
 * this.<method>().
 *
 ********************************************************************/

'use strict';

const { rethrowIfInfraFault } = require('../../consensus/fault_guard.js');
const { getLogger } = require('../../observability/index.js');

module.exports = {
    // ATTEST v2: Expire (system-synthesized)
    async parseExpire(params, data, error){

        // System-synthesized only. The decoder accepts ATTEST in VALID_ACTION_NAMES but the
        // user-broadcast path can't legitimately produce v2; guard against accidental
        // synthesis from a user transaction.
        if(!data['IS_SYNTHETIC']){
            getLogger().warn('\t ATTEST v2 : rejected (user-broadcast not allowed for synthetic expire)');
            data['STATUS'] = 'invalid: ATTEST v2 must be system-synthesized';
            return;
        }

        // Look up the request to expire. data['REQUEST_ID'] is set by
        // util.processAttestationExpirations from getExpiredAttestationRequests.
        let requestId = String(data['REQUEST_ID'] || '').toLowerCase();
        let request   = await this.indexerDb.getAttestationRequestById(requestId);

        // Bail if the request no longer exists or has already been resolved (race-protected).
        if(!request || request.request_status !== 'pending')
            return;

        // Synthesized actions arrive without an ACTION_INDEX; allocate one now
        // (mirrors order_expire.js). Without this, mapper.createMappings and the
        // injected callback's EMITTER reference both NULL out.
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex({
            ACTION:      'ATTEST',
            BLOCK_INDEX: data['BLOCK_INDEX'],
            FORMAT:      2
        }, true);

        data['STATUS'] = 'valid';

        getLogger().info("\t ATTEST v2 : id=" + requestId.substring(0,16) + '...' +
                    ' : deadline=' + request.deadline_block +
                    ' : block=' + data['BLOCK_INDEX']);

        // Flip request status to 'expired' (resolved_block anchors the flip for the
        // reorg-rollback reset; without it a reorged expiry stayed terminal and
        // replay skipped re-synthesizing the v2 row)
        await this.indexerDb.updateAttestationRequestStatus(requestId, 'expired', data['BLOCK_INDEX']);

        // Refund the request fee; never reached the responsible set's quorum.
        await this.settleRequestFee(request, data, 'expired');

        await this.chargeExpiryMisses(request, requestId, data);

        await this.fireExpiryCallback(request, data);

        await this.mapper.createMappings(data);
    },

    // Fault the ASSIGNED responsible set for a request nobody answered.
    async chargeExpiryMisses(request, requestId, data){
        // Mark missed_count on each responsible validator (deterministic by SHA256(request_id || pubkey))
        try {
            let responsible = await this.computeResponsibleSet(
                requestId, request.redundancy, Number(request.block_index), request.provider_id
            );
            for(let pk of responsible){
                await this.indexerDb.incrementAttestationValidatorStat(
                    pk, String(request.provider_id), 'missed_count', data['BLOCK_INDEX']
                );
            }
        } catch(e){
            // This catch only absorbs older-schema gaps (missing table/column);
            // a driver-level fault (deadlock, lock-wait timeout) must halt the
            // block or this validator alone drops the stat rows (consensus/fault_guard.js).
            rethrowIfInfraFault(e);
            getLogger().warn('Attestation expire: missed_count update failed:', e);
        }
    },

    async fireExpiryCallback(request, data){
        // Synthesize the callback EXECUTE so the contract can clean up (status='expired').
        // Skipped for a relay-materialized row on the home chain, whose contract
        // lives on the origin chain (see the same guard on the v1 path). The origin
        // chain's own copy of the request expires on its own deadline and fires the
        // contract's expired callback there.
        try {
            if(!this.isForeignOrigin(request))
                await this.injectExpiredCallback(request, data);
        } catch(e){
            // Same infra-fault gate as the response-path callback above (consensus/fault_guard.js).
            rethrowIfInfraFault(e);
            getLogger().warn('Attestation expiry callback failed:', e);
        }
    }
};
