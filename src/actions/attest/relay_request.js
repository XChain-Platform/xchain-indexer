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
 * ATTEST v3: the relay request leg, which materializes a foreign-origin request onto the home chain.
 *
 * Installed onto Attest.prototype by actions/attest/index.js, so call sites stay
 * this.<method>().
 *
 ********************************************************************/

'use strict';

const attestRelay     = require('../../attest_relay_activation.js');
// Whether a refused v3 withholds its row so the id it named stays free for the
// honest relay. Landing-block plane, unarmed on mainnet.
const relayRejectSlot = require('../../attest_relay_reject_slot_activation.js');
const { getLogger } = require('../../observability/index.js');
const { HOME_CHAIN, ALLOWED_ORIGIN_CHAINS } = require('./constants.js');

module.exports = {
    // ATTEST v3: relay request (federation-broadcast on the home chain).
    //
    // Materializes an LTC/DOGE-origin request onto BTC. The row it writes is an
    // ordinary request row (version 0 in `attests`, the lifecycle table keyed on
    // request_id) carrying origin_chain/origin_action_index, so every existing
    // consumer works on it unchanged: the hub's pending poll finds it, the
    // responsible set resolves at THIS action's BTC block_index, the v1 response
    // path fulfills it, and the deadline sweep expires it. Only the callback is
    // suppressed (the contract is not on this chain); the response relays back
    // as a v4 instead.
    async parseRelayRequest(params, data, error){

        // Home-chain-only leg. Written as a hard return rather than a stored
        // 'invalid' row so a v3 that strays onto an origin chain is treated exactly
        // as an unknown VERSION is: nothing persisted, nothing hashed.
        if(String(this.config['COIN']) !== HOME_CHAIN){
            getLogger().warn("\t ATTEST v3 : rejected (relay requests materialize on " + HOME_CHAIN + " only)");
            return;
        }

        let snapshotBlock = parseInt(params[8]);
        if(!this.relayRequestArmed(data, snapshotBlock))
            return;

        let f = this.relayRequestFields(params, data, snapshotBlock, error);
        error = f.error;
        let { requestId, originChain, originAction, providerId, redundancy } = f;

        let replay = await this.relayRequestReplayError(params, f, error);
        error      = replay.error;

        error = await this.relayRequestQuorumError(f, replay.sigs, snapshotBlock, error);

        this.stampRelayRequestRow(data, f, error);

        getLogger().info("\t ATTEST v3 : id=" + requestId.substring(0,16) + '...' +
                    ' : origin=' + originChain + ':' + originAction +
                    ' : provider=' + providerId +
                    ' : redundancy=' + redundancy +
                    ' : snapshot=' + snapshotBlock +
                    ' : ' + data['STATUS']);

        await this.pinRelayResponsibleSet(data, f);

        await this.persistRelayRequest(data);
        await this.mapper.createMappings(data);
    },

    // Flag-day gate, and it takes BOTH planes because the two answer different
    // questions and only one of them is shared with the rest of the federation.
    //
    // The landing block_index is what makes the leg inert before the flag day:
    // on the home chain it IS a BTC height and cannot be forged, so a v3 carrying
    // an invented future SNAPSHOT_BLOCK still persists nothing below activation,
    // byte-identical to how a node without relay support treats VERSION 3.
    //
    // The carried SNAPSHOT_BLOCK is what keeps this node on the same activation
    // predicate as everyone else. It is the ONLY plane the hub can gate on, since
    // the hub decides whether to co-sign and broadcast BEFORE the action has a
    // landing height at all (xchain-hub AttestationRelay.validateRowEnvelope and
    // the request-round gate), and it is the plane the v4 leg, the
    // isAttestRelayActive contract, and the SNAPSHOT_BLOCK field spec all name.
    // Without it the window landing >= activation > snapshot is accepted here and
    // refused by the hub, and the signer set it resolves quorum against is the
    // pre-activation one.
    //
    // A malformed or negative SNAPSHOT_BLOCK is deliberately NOT hard-returned
    // here: it keeps falling through to the stored 'invalid: SNAPSHOT_BLOCK'
    // verdict below, so this gate changes acceptance for exactly the divergent
    // case and is a strict no-op on any network whose threshold is 0.
    relayRequestArmed(data, snapshotBlock){
        if(!attestRelay.isAttestRelayActive(data['BLOCK_INDEX'], this.config['NETWORK']))
            return false;
        if(snapshotBlock >= 0 && !attestRelay.isAttestRelayActive(snapshotBlock, this.config['NETWORK']))
            return false;
        return true;
    },

    // The v3 wire's fields and their structural rules, including the deadline the
    // landing block implies and the bound on the snapshot the federation signed at.
    relayRequestFields(params, data, snapshotBlock, error){
        let requestId      = String(params[1] || '').toLowerCase();
        let originChain    = String(params[2] || '');
        let originAction   = parseInt(params[3]);
        let providerId     = String(params[4] || '');
        let requestPayload = (params[5] == null) ? '' : String(params[5]);
        let redundancy     = parseInt(params[6]);
        let deadlineBlocks = parseInt(params[7]);

        if(!error && !/^[0-9a-f]{64}$/.test(requestId))
            error = 'invalid: REQUEST_ID (format)';
        if(!error && ALLOWED_ORIGIN_CHAINS.indexOf(originChain) === -1)
            error = 'invalid: ORIGIN_CHAIN (unknown)';
        if(!error && (!Number.isInteger(originAction) || originAction <= 0))
            error = 'invalid: ORIGIN_ACTION_INDEX (must be a positive integer)';
        if(!error && !this.providerRegistry.isKnown(providerId))
            error = 'invalid: PROVIDER_ID (unknown)';
        if(!error && !this.providerRegistry.isRedundancyAllowed(providerId, redundancy))
            error = 'invalid: REDUNDANCY (not allowed for provider)';
        if(!error && !this.providerRegistry.isPayloadSizeAllowed(providerId, Buffer.byteLength(requestPayload, 'utf8')))
            error = 'invalid: REQUEST_PAYLOAD (exceeds provider max)';

        let deadlineBlock = parseInt(data['BLOCK_INDEX']) + (Number.isFinite(deadlineBlocks) ? deadlineBlocks : 0);
        if(!error && !this.providerRegistry.isDeadlineAllowed(providerId, parseInt(data['BLOCK_INDEX']), deadlineBlock))
            error = 'invalid: DEADLINE (outside provider window)';

        // The snapshot the federation signed against must already exist at this
        // action's height. Without the upper bound a broadcaster could name a future
        // snapshot and have the quorum resolved against whatever the mirror holds
        // latest, which both defeats the flag-day and un-pins the signer set from the
        // block it was supposed to be frozen at.
        if(!error && (!Number.isFinite(snapshotBlock) || snapshotBlock < 0 || snapshotBlock > parseInt(data['BLOCK_INDEX'])))
            error = 'invalid: SNAPSHOT_BLOCK (must be a past or current block on this chain)';

        return { requestId, originChain, originAction, providerId, requestPayload,
                 redundancy, deadlineBlocks, deadlineBlock, error };
    },

    // The two exactly-once guards, over the signature tail this leg shares with v4.
    async relayRequestReplayError(params, f, error){
        let { requestId, originChain, originAction } = f;
        let sigs = error ? [] : this.parseRelaySigs(params, 9);
        if(!error && sigs === null)
            error = 'invalid: SIG_COUNT (malformed signature list)';

        // One request_id materializes exactly once. A duplicate v3 is rejected here
        // rather than deduped in the DB layer so the outcome is an explicit, stored
        // verdict every node reaches identically.
        //
        // getRelayRequestById, not getAttestationRequestById: only an ADMITTED row
        // consumes the id. The rejected verdict this branch writes is stored too, and
        // counting stored rows made the guard self-blocking - request_id comes off the
        // wire and is public before the federation broadcasts, so one malformed v3
        // naming a pending id got stored as rejected and then answered this check for
        // the real relay, permanently. Same reasoning as the relay-identity guard
        // below, which already read only admitted rows.
        //
        // Ungated on purpose, and the reason is a measurement with an expiry date: at
        // the time of the change no ATTEST action of any version had ever been admitted
        // on any live network (three mainnet chains, three testnet chains, regtest), so
        // no stored verdict anywhere changes and a from-genesis replay is byte-identical
        // with or without this line. That is what removed the flag day, and it stops
        // being true the moment the first v3 lands: any later change to which rows this
        // guard counts reinterprets real history and needs an activation height.
        if(!error && await this.indexerDb.getRelayRequestById(requestId))
            error = 'invalid: REQUEST_ID (already present on this chain)';

        // ...and one RELAY IDENTITY materializes exactly once, which the check above does
        // NOT imply. request_id is SHA256 over the origin TX_HASH (attests.sql), so an
        // origin reorg deeper than the hub's confirmation depth that re-emits the same
        // origin action_index from a different transaction produces a DIFFERENT request_id,
        // clears the check above, and materializes a second BTC request that nothing on BTC
        // can retract. Rejecting the second is the conservative side of that
        // fork: the stranded origin request expires on its own deadline and refunds its
        // escrow, whereas a double materialization spends real BTC fees irreversibly.
        // Stored as an 'invalid' verdict rather than left to a DB constraint for the same
        // reason the request_id check is: a UNIQUE violation would THROW mid-block inside a
        // consensus indexer instead of producing the identical stored outcome on every node.
        if(!error && await this.indexerDb.getRelayRequestByOrigin(originChain, originAction))
            error = 'invalid: ORIGIN_ACTION_INDEX (relay identity already materialized on this chain)';

        return { sigs, error };
    },

    async relayRequestQuorumError(f, sigs, snapshotBlock, error){
        let { requestId, originChain, originAction, providerId, requestPayload, redundancy, deadlineBlocks } = f;
        if(!error){
            let canonical = this.relayRequestCanonical({
                requestId, snapshotBlock, network: this.config['NETWORK'],
                originChain, originActionIndex: originAction, providerId,
                requestPayload, redundancy, deadlineBlocks
            });
            let quorum = await this.verifyRelayQuorum(canonical, sigs, snapshotBlock, this.config['NETWORK']);
            if(!quorum.ok)
                error = 'invalid: cross_chain quorum (' + quorum.detail + ')';
        }

        return error;
    },

    // The request row this leg materializes, verdict included.
    stampRelayRequestRow(data, f, error){
        let { requestId, originChain, originAction, providerId, requestPayload, redundancy, deadlineBlock } = f;
        data['REQUEST_ID']          = requestId;
        data['PROVIDER_ID']         = providerId;
        data['REQUEST_PAYLOAD']     = requestPayload;
        // The callback lives on the origin chain and never runs here, so these stay
        // off the home-chain wire and out of the home-chain row entirely.
        data['CALLBACK_METHOD']     = null;
        data['CALLBACK_PARAMS']     = null;
        data['REDUNDANCY']          = redundancy;
        data['DEADLINE_BLOCK']      = deadlineBlock;
        data['GAS_ESCROW']          = '0';
        // Feeless on the home chain: the requester's fee was escrowed on the origin
        // chain at its v0 and settles there. A fee_payer here would name an address
        // that never paid anything on this chain.
        data['FEE_PAYER']           = null;
        data['FEE_TICK']            = null;
        data['FEE_AMOUNT']          = null;
        data['CONTRACT_INDEX']      = null;
        data['ORIGIN_CHAIN']        = originChain;
        data['ORIGIN_ACTION_INDEX'] = originAction;

        data['STATUS']         = (error) ? error : 'valid';
        data['REQUEST_STATUS'] = (error) ? 'rejected' : 'pending';
    },

    async pinRelayResponsibleSet(data, f){
        let { requestId, providerId, redundancy } = f;
        // Pin the responsible set as-of THIS block, the same pin-as-of-block rule a
        // native v0 follows. This is the anchor the whole model exists to provide:
        // block_index here is a genuine BTC height, so the set (and the block-echo
        // determinism check that reads it back) resolves exactly as it would for a
        // natively emitted request.
        if(data['REQUEST_STATUS'] === 'pending'){
            let responsibleSet = await this.computeResponsibleSet(requestId, redundancy, data['BLOCK_INDEX'], providerId);
            data['RESPONSIBLE_SET_JSON'] = JSON.stringify(responsibleSet);
        }
    },

    async persistRelayRequest(data){
        // Withhold the row of a REFUSED v3, so the id it named stays free. The single-v0
        // guard in db.createAttestationRequest counts every stored v0 row, and a relay
        // id rides the wire, so a stored refusal answers that guard for the federation's
        // real relay and drops it silently and permanently. Same shape as the two other
        // ways a v3 fails to be a relay (wrong chain, below activation): nothing
        // persisted, nothing hashed, the verdict still on the action row. Flag-day
        // gated, plane and arming state in attest_relay_reject_slot_activation.js.
        let withholdRefusal = (data['REQUEST_STATUS'] === 'rejected') &&
            relayRejectSlot.isAttestRelayRejectSlotActive(data['BLOCK_TIME'], this.config['NETWORK']);
        if(!withholdRefusal)
            await this.indexerDb.createAttestationRequest(data);
    }
};
