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
 * ATTEST v4: the relay response leg, which closes the origin chain's request and fires its callback.
 *
 * Installed onto Attest.prototype by actions/attest/index.js, so call sites stay
 * this.<method>().
 *
 ********************************************************************/

'use strict';

const crypto  = require('crypto');
// The relay flag day is a registry row read by literal key (W5); it keys on the
// BTC-anchored SNAPSHOT_BLOCK, never a local height.
const gateRegistry = require('../../consensus/gate_registry');
const ATTEST_RELAY_KEY = 'attest_relay_activation.ATTEST_RELAY_ACTIVATION';
const { rethrowIfInfraFault } = require('../../consensus/fault_guard.js');
const { getLogger } = require('../../observability/index.js');
const { HOME_CHAIN } = require('./constants.js');

module.exports = {
    // ATTEST v4: relay response (federation-broadcast on the origin chain).
    //
    // Carries the home chain's fulfilled v1 back to the chain the request was
    // emitted on. The origin indexer verifies the SAME cross_chain quorum rail the
    // XCALL result leg uses, against the BTC-anchored snapshot, then closes its own
    // pending request and fires the contract callback.
    async parseRelayResponse(params, data, error){

        // Never valid on the home chain: a home-chain request is fulfilled by a v1
        // in place and has nothing to relay to itself.
        if(String(this.config['COIN']) === HOME_CHAIN){
            getLogger().warn("\t ATTEST v4 : rejected (relay responses land on origin chains only)");
            return;
        }

        let f = this.relayResponseFields(params);
        let { requestId, homeResponseIdx, responseStatus, snapshotBlock } = f;

        if(!this.relayResponseArmed(snapshotBlock))
            return;

        let wire = this.relayResponseWireError(params, f, error);
        error    = wire.error;

        let lookup  = await this.relayResponseRequestError(requestId, error);
        let request = lookup.request;
        error       = lookup.error;

        error = await this.relayResponseQuorumError(f, request, wire, error);

        this.stampRelayResponseRow(data, f, request, wire, error);

        getLogger().info("\t ATTEST v4 : id=" + requestId.substring(0,16) + '...' +
                    ' : home_response=' + homeResponseIdx +
                    ' : status=' + responseStatus +
                    ' : snapshot=' + snapshotBlock +
                    ' : ' + data['STATUS']);

        await this.indexerDb.createAttestationResponse(data);

        if(data['STATUS'] === 'valid')
            await this.settleRelayResponse(request, data, requestId, responseStatus);

        await this.mapper.createMappings(data);
    },

    // The v4 wire, field by field.
    relayResponseFields(params){
        let requestId       = String(params[1] || '').toLowerCase();
        let homeResponseIdx = parseInt(params[2]);
        let payloadB64      = String(params[3] || '');
        let responseStatus  = String(params[4] || '');
        let meta            = (params[5] == null) ? '' : String(params[5]);
        let snapshotBlock   = parseInt(params[6]);

        return { requestId, homeResponseIdx, payloadB64, responseStatus, meta, snapshotBlock };
    },

    // Flag-day gate. The origin chain has no BTC height of its own, so the gate is
    // evaluated on the BTC-anchored SNAPSHOT_BLOCK the canonical carries, NOT on
    // where this action landed: a BTC-derived threshold compared against an LTC or
    // DOGE local height is already satisfied there and would ship the leg live
    // instead of inert (the ATTEST_ADMISSION plane trap). A broadcaster cannot use
    // that to jump the gate: the same value pins the signer set, so a forged
    // SNAPSHOT_BLOCK has to be signed by a quorum of the real cross_chain
    // federation, and the matching origin request only exists at all once
    // ATTEST_RELAY_ORIGIN has admitted it.
    relayResponseArmed(snapshotBlock){
        return Number.isFinite(snapshotBlock) &&
               gateRegistry.activeAt(ATTEST_RELAY_KEY, this.config['NETWORK'], null, snapshotBlock, null);
    },

    // The structural rules over those fields, the decoded body and the signature tail.
    relayResponseWireError(params, f, error){
        let { requestId, homeResponseIdx, payloadB64, responseStatus } = f;
        if(!error && !/^[0-9a-f]{64}$/.test(requestId))
            error = 'invalid: REQUEST_ID (format)';
        if(!error && (!Number.isInteger(homeResponseIdx) || homeResponseIdx <= 0))
            error = 'invalid: HOME_RESPONSE_ACTION_INDEX (must be a positive integer)';

        // Only the two TERMINAL outcomes relay. The retryable statuses
        // (no_quorum / timeout / provider_error) leave the home-chain request pending
        // for another round, so relaying one would close an origin request the home
        // chain still intends to fulfill.
        let allowedStatuses = ['ok', 'expired'];
        if(!error && allowedStatuses.indexOf(responseStatus) === -1)
            error = 'invalid: STATUS (not a terminal relay status)';

        let responseBodyBytes;
        try { responseBodyBytes = Buffer.from(payloadB64, 'base64'); }
        catch(_){ responseBodyBytes = Buffer.alloc(0); }
        let responsePayload = responseBodyBytes.toString('utf8');
        let responseHash    = crypto.createHash('sha256').update(responseBodyBytes).digest('hex');

        let sigs = error ? [] : this.parseRelaySigs(params, 7);
        if(!error && sigs === null)
            error = 'invalid: SIG_COUNT (malformed signature list)';

        return { sigs, responsePayload, responseHash, error };
    },

    // The local request this leg closes, and every reason it cannot be closed by relay.
    async relayResponseRequestError(requestId, error){
        // The local request must be one this chain admitted for relay and has not
        // already closed. A native (non-relay) request is NOT relay-closable: it never
        // left this chain, so a v4 naming it is either a mistake or an attempt to close
        // a request the federation was never asked to service.
        let request = null;
        if(!error){
            request = await this.indexerDb.getAttestationRequestById(requestId);
            if(!request)
                error = 'invalid: REQUEST_ID (no matching request)';
            else if(String(request.origin_chain || '') !== String(this.config['COIN']))
                error = 'invalid: REQUEST is not relay-eligible on this chain';
            else if(request.request_status !== 'pending')
                error = 'invalid: REQUEST already ' + request.request_status;
        }

        return { request, error };
    },

    async relayResponseQuorumError(f, request, wire, error){
        let { requestId, homeResponseIdx, responseStatus, meta, snapshotBlock } = f;
        let { sigs, responseHash } = wire;
        if(!error){
            let canonical = this.relayResponseCanonical({
                requestId, snapshotBlock, network: this.config['NETWORK'],
                originChain: String(this.config['COIN']),
                homeResponseActionIndex: homeResponseIdx,
                providerId: String(request.provider_id), responseHash,
                status: responseStatus, meta
            });
            let quorum = await this.verifyRelayQuorum(canonical, sigs, snapshotBlock, this.config['NETWORK']);
            if(!quorum.ok)
                error = 'invalid: cross_chain quorum (' + quorum.detail + ')';
        }

        return error;
    },

    stampRelayResponseRow(data, f, request, wire, error){
        let { requestId, homeResponseIdx, responseStatus, meta } = f;
        let { responsePayload, responseHash } = wire;
        data['REQUEST_ID']       = requestId;
        // attests.provider_id is NOT NULL, and a v4 does not carry the provider on the
        // wire (the request row owns it). A rejected v4 with no matching request has no
        // provider to name, so it stores the empty string rather than failing the INSERT
        // and losing the audit row.
        data['PROVIDER_ID']      = request ? String(request.provider_id) : '';
        data['RESPONSE_PAYLOAD'] = responsePayload;
        data['RESPONSE_STATUS']  = responseStatus;
        data['META']             = meta;
        data['RESPONSE_HASH']    = responseHash;
        data['VALID_SIGS']       = 0;
        data['STATUS']           = (error) ? error : 'valid';
        // The signatures on this row are cross_chain relay signatures, not the
        // attestation quorum that produced the body. That quorum is recorded on the
        // home chain's v1 row, which homeResponseIdx names; inlining them here would
        // invite a reader to mistake one for the other.
        data['VALIDATOR_SIGNATURES'] = null;
    },

    // The terminal flip, the origin-side fee settle and the contract callback.
    async settleRelayResponse(request, data, requestId, responseStatus){
        let newRequestStatus = (responseStatus === 'ok') ? 'fulfilled' : 'errored';
        await this.indexerDb.updateAttestationRequestStatus(requestId, newRequestStatus, data['BLOCK_INDEX']);

        // Settle the fee the origin v0 escrowed, on the same terms a local
        // fulfillment would. The responsible set it splits to is the ORIGIN row's,
        // which is empty off BTC, so the fee lands in the REWARD pool and no
        // per-validator reward row is written; paying the BTC-staked validators
        // out of an origin-chain pool is Phase 3 economics work, not something
        // this relay leg needs to solve.
        await this.settleRequestFee(request, data, newRequestStatus);

        // Fire the contract callback here, on the chain the contract lives on.
        // Same savepoint discipline as the v1 path: a failing callback must not
        // roll back the response row.
        try {
            let callbackActionIndex = await this.injectRelayCallback(request, data);
            if(callbackActionIndex)
                await this.indexerDb.setAttestationResponseCallbackIndex(data['ACTION_INDEX'], callbackActionIndex);
        } catch(e){
            rethrowIfInfraFault(e);
            getLogger().warn('Attestation relay callback injection failed:', e);
        }
    }
};
