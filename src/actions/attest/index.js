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
 * XChain Platform Action - ATTEST
 *
 * External-data attestation lifecycle with seven version-discriminated phases:
 *   v0: Request (VM emission only; originated by xchain.attestation.request())
 *   v1: Response (validator-broadcast PBFT bundle with signatures)
 *   v2: Expire (system-synthesized; never user-broadcast)
 *   v3: Relay request  (cross_chain-federation-broadcast, BTC only)
 *   v4: Relay response (cross_chain-federation-broadcast, origin chain only)
 *   v5: Response BATCH head         (publisher-broadcast, DOGE only)
 *   v6: Response BATCH continuation (publisher-broadcast, DOGE only)
 *
 * v5/v6 are the periodic on-chain carrier for responses that reached indexers
 * through the hub mirror instead of on a per-response transaction. They exist so
 * full history stays reconstructible from chain parse: a node replaying the chain
 * rebuilds the mirror table from the batches and re-derives every callback. The
 * wire layout, its chunking and its caps live in ../attest_batch_wire.js, which
 * xchain-hub carries a byte-identical twin of.
 *
 * v3/v4 are the cross-chain delivery legs. All
 * `attestation` capability stake lives on BTC, so an ATTEST emitted by an LTC or
 * DOGE contract has no responsible set of its own and cannot be fulfilled where
 * it landed. v3 materializes such a request ONTO BTC, giving it a real BTC
 * block_index: that is the whole point of the model, because CapabilitySnapshot
 * keys the responsible set on a BTC height, and a foreign-origin block_index
 * (DOGE ~6.3M / LTC ~3.16M against BTC ~962K) has no deterministic anchor. Once
 * materialized, the existing v0/v1 machinery services it unchanged. v4 carries
 * the BTC response back so the origin chain can fire the contract callback.
 * Both legs are flag-day gated; see attest_relay_activation.js.
 *
 * Spec: xchain-documentation/protocol/actions/ATTEST.md
 *
 * WHERE THE CODE IS. This file is the entry every requirer already names: it keeps the
 * constructor, the request_id preimage and its derivation check, and the VERSION
 * dispatch. Each leg lives in its own part file beside it (request, fees, response,
 * mirror_apply, expire, batch, batch_absorb, responsible_set, relay, relay_request,
 * relay_response, settle, callbacks) and is installed onto Attest.prototype at the
 * bottom of this file, so every call site and every suite stub stays this.<method>().
 *
 * FORMATS:
 *   v0 -VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS
 *   v1 - VERSION|REQUEST_ID|PROVIDER_ID|RESPONSE_PAYLOAD|STATUS|META|SIG_COUNT|PUBKEY|SIG|...
 *   v2 - VERSION|REQUEST_ID         (synthesized only; REQUEST_ID is sufficient, handler looks up the row)
 *   v3 - VERSION|REQUEST_ID|ORIGIN_CHAIN|ORIGIN_ACTION_INDEX|PROVIDER_ID|REQUEST_PAYLOAD|REDUNDANCY|DEADLINE_BLOCKS|SNAPSHOT_BLOCK|SIG_COUNT|PUBKEY|SIG|...
 *   v4 - VERSION|REQUEST_ID|HOME_RESPONSE_ACTION_INDEX|RESPONSE_PAYLOAD|STATUS|META|SNAPSHOT_BLOCK|SIG_COUNT|PUBKEY|SIG|...
 *   v5 - VERSION|BATCH_KEY|NETWORK|WINDOW_START|WINDOW_END|ROW_COUNT|BTC_BLOCK_HEIGHT|BATCH_CRC32|TOTAL_CHUNKS|BODY_B64
 *   v6 - VERSION|BATCH_KEY|CHUNK_INDEX|TOTAL_CHUNKS|BATCH_CRC32|BODY_B64_CHUNK
 *
 ********************************************************************/


const crypto  = require('crypto');
// The v5/v6 wire: layout, chunking, caps and reassembly. Pure, and byte-twinned
// into xchain-hub so the publisher that BUILDS a batch and this parser cannot
// disagree about its bytes.
const abw     = require('./attest_batch_wire.js');
const ProviderRegistry = require('../../attestation/providerRegistry.js');
const { ATTEST_BATCH_COMPLETION_STAMP, ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK,
        REQUEST_ID_PREIMAGE_FIELDS } = require('./constants.js');

// THE HANDLER'S PARTS. One file per protocol leg or shared concern, each exporting the
// methods it owns. They are installed onto Attest.prototype below the class, so every call
// site and every suite stub stays what it was when one class body held them all. None of
// them requires this file back, so loading them ahead of the class body is the same load
// as loading them after it: the class body itself runs nothing.
const requestPart        = require('./request.js');
const feesPart           = require('./fees.js');
const responsePart       = require('./response.js');
const mirrorApplyPart    = require('./mirror_apply.js');
const expirePart         = require('./expire.js');
const batchPart          = require('./batch.js');
const batchAbsorbPart    = require('./batch_absorb.js');
const responsibleSetPart = require('./responsible_set.js');
const relayPart          = require('./relay.js');
const relayRequestPart   = require('./relay_request.js');
const relayResponsePart  = require('./relay_response.js');
const settlePart         = require('./settle.js');
const callbacksPart      = require('./callbacks.js');

class Attest {

    // The action's constants, read off the class by requirers that predate constants.js
    // (utility.js reads the mirror-apply cap; suites read the stamp and the preimage
    // fields). constants.js is their home and these are the same bindings, carried as
    // statics so the module's one export is the class itself.
    static REQUEST_ID_PREIMAGE_FIELDS          = REQUEST_ID_PREIMAGE_FIELDS;
    static ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK = ATTEST_MAX_MIRROR_APPLIES_PER_BLOCK;
    static ATTEST_BATCH_COMPLETION_STAMP       = ATTEST_BATCH_COMPLETION_STAMP;

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Hub client for the v5 batch's durable push. Absent on a hub-less node, which
        // parses and judges batches exactly the same and simply pushes nothing.
        this.hubClient = action.hubClient || null;

        // Providers are the built-in DEFAULTS (http_get, llm) overlaid with any
        // ATTESTATION.PROVIDERS block in the coin config (see providerRegistry.js).
        this.providerRegistry = new ProviderRegistry(this.config);

        // Per-version format strings
        this.formats = {};
        // FEE_TICK|FEE_AMOUNT are optional trailing fields (paid-attestation
        // wire prep): absent on the wire → null, and the SDK serializer trims
        // trailing empties, so feeless requests stay byte-identical to the
        // 8-field format. v1 consensus accepts only FEE_TICK == GAS (XCHAIN);
        // arbitrary ticks are a post-launch rule loosening, not a wire change.
        this.formats[0] = 'VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS|FEE_TICK|FEE_AMOUNT';
        this.formats[1] = 'VERSION|REQUEST_ID|PROVIDER_ID|RESPONSE_PAYLOAD|STATUS|META|SIG_COUNT|PUBKEY|SIG|...';
        this.formats[2] = 'VERSION|REQUEST_ID';
        // Cross-chain relay legs. Both are broadcast by the elected cross_chain
        // leader on behalf of the federation and carry their quorum inline,
        // structurally mirroring v1. Both are flag-day gated: below activation
        // the handlers write nothing and persist nothing, which is byte-identical
        // to how a node without relay support treats an unknown VERSION.
        this.formats[3] = 'VERSION|REQUEST_ID|ORIGIN_CHAIN|ORIGIN_ACTION_INDEX|PROVIDER_ID|REQUEST_PAYLOAD|REDUNDANCY|DEADLINE_BLOCKS|SNAPSHOT_BLOCK|SIG_COUNT|PUBKEY|SIG|...';
        this.formats[4] = 'VERSION|REQUEST_ID|HOME_RESPONSE_ACTION_INDEX|RESPONSE_PAYLOAD|STATUS|META|SNAPSHOT_BLOCK|SIG_COUNT|PUBKEY|SIG|...';
        // The batch legs take their format strings from the wire module itself rather
        // than restating them, so the layout has exactly one definition and the hub twin
        // and this parser cannot drift by hand-copy.
        this.formats[abw.ATTEST_BATCH_HEAD_VERSION]         = abw.ATTEST_BATCH_HEAD_FORMAT;
        this.formats[abw.ATTEST_BATCH_CONTINUATION_VERSION] = abw.ATTEST_BATCH_CONTINUATION_FORMAT;
    }

    // Stringified request_id preimage values, in REQUEST_ID_PREIMAGE_FIELDS order.
    // Every field is chain data, so every node derives the same bytes. String() is
    // the coercion the derivation has always used and is load-bearing on two of
    // them: CONTRACT_INDEX is deliberately not null-checked here (the caller's
    // guard chain above decides that), and ROOT_ACTION_INDEX must stay the raw
    // string, never Number()-coerced, because a BATCH subcommand root is the
    // composite "<TX_VOUT>.<position>".
    requestIdPreimageValues(data){
        return REQUEST_ID_PREIMAGE_FIELDS.map((f) => String(data[f]));
    }

    // Re-derive request_id and compare. Defends against a compromised VM by anchoring
    // the on-chain request_id to (tx_hash, emitter_path, contract_index,
    // emitter_position). EMITTER_PATH (the emitting execution's deterministic call-path
    // (the '>'-joined per-execution emission positions from the root on-chain action
    // down to this execution, root = '') is part of the preimage because cross-contract
    // calls let the SAME contract run more than once in the SAME tx; without it, two
    // such runs derive identical request_ids for their first attestation. Unlike the old
    // EMITTER_ACTION_INDEX it is content-derived, so it stays byte-stable across nodes
    // and reorgs (action_index advanced with synthetic-action injection timing → forked
    // the PBFT). MUST byte-match the VM's derivation in xchain-vm/src/gateway.js
    // (attestation.request). All inputs are REQUIRED for a legitimate VM emission
    // (execute.processEmission); their absence is a hard failure, not a silent bypass.
    // NOTE: EMITTER_PATH '' (the root on-chain action) is VALID; check === undefined /
    // null, never falsy, or every root-level attestation would be rejected.
    //
    // Returns the verdict string, or null when the derivation matches, so the v0 handler
    // keeps its own `error` value untouched on the matching path.
    requestIdDerivationError(data){
        if(data['EMITTER_POSITION'] === undefined || data['EMITTER_POSITION'] === null)
            return 'invalid: EMITTER_POSITION (required for request_id derivation)';
        if(data['EMITTER_PATH'] === undefined || data['EMITTER_PATH'] === null)
            return 'invalid: EMITTER_PATH (required for request_id derivation)';
        // The per-root discriminator (deterministic root on-chain action_index). Required
        // for every legitimate VM emission; check === undefined/null (0 is a valid index).
        // Hashed as the raw string it arrives as: for a root that is a BATCH subcommand it
        // is the composite "<TX_VOUT>.<position>" (src/consensus/batch_root_discriminator.js), which
        // must NOT be Number()-coerced here or by the VM ('3.10' and '3.1' would fold
        // together and re-collide the roots the discriminator exists to separate).
        if(data['ROOT_ACTION_INDEX'] === undefined || data['ROOT_ACTION_INDEX'] === null)
            return 'invalid: ROOT_ACTION_INDEX (required for request_id derivation)';
        if(!data['TX_HASH'])
            return 'invalid: TX_HASH (required for request_id derivation)';
        let preimage = this.requestIdPreimageValues(data).join(':');
        let expected = crypto.createHash('sha256').update(preimage).digest('hex');
        if(expected !== String(data['REQUEST_ID']).toLowerCase())
            return 'invalid: REQUEST_ID (does not match deterministic derivation)';
        return null;
    }

    // Dispatch on VERSION
    async parse(params, data, error){

        let format = data['FORMAT'];
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        if(format === 0) return await this.parseRequest(params, data, error);
        // A hub-mirror-applied response is a v1 too: same version, same row shape, same
        // effects, no transaction. It is dispatched apart from the chain path because
        // there is no wire to parse (the artifact arrives as a mirrored row, already
        // structured) and because the two must stay distinguishable: the chain path
        // rejects an on-chain v1 for a mirror-era request, and that gate must not fire
        // on the applier's own synthesized action. The marker is set only by
        // utility.processAttestationResponses.
        if(format === 1 && data['IS_SYNTHETIC'] && data['MIRROR_RESPONSE'])
            return await this.applyMirroredResponse(data);
        if(format === 1) return await this.parseResponse(params, data, error);
        if(format === 2) return await this.parseExpire(params, data, error);
        if(format === 3) return await this.parseRelayRequest(params, data, error);
        if(format === 4) return await this.parseRelayResponse(params, data, error);
        if(format === abw.ATTEST_BATCH_HEAD_VERSION)         return await this.parseBatchHead(params, data, error);
        if(format === abw.ATTEST_BATCH_CONTINUATION_VERSION) return await this.parseBatchContinuation(params, data, error);
    }
}

// The parts required at the top of this file, installed here. The list is written out
// rather than read from the directory, so a file dropped into actions/attest/ cannot
// silently add a method to the handler.
const PARTS = [
    requestPart, feesPart, responsePart, mirrorApplyPart, expirePart, batchPart,
    batchAbsorbPart, responsibleSetPart, relayPart, relayRequestPart, relayResponsePart,
    settlePart, callbacksPart
];

// Installed NON-ENUMERABLE, which is what the class body they came from produced: an
// enumerable method would join for-in and Object.keys over an instance, and the suites
// stub these off the prototype. A name two parts both define is a merge accident, not a
// decision, so it throws at require time instead of letting whichever file loads last win
// silently.
for(const part of PARTS){
    let descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)){
        if(Object.prototype.hasOwnProperty.call(Attest.prototype, key))
            throw new Error('actions/attest: ' + String(key) + ' is defined by two part files');
        descriptors[key].enumerable = false;
    }
    Object.defineProperties(Attest.prototype, descriptors);
}

module.exports = Attest;
