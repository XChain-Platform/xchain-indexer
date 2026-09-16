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
 * XChain Platform Action - XCALL (cross-chain contract call request)
 *
 * Source-chain side of a cross-chain contract call, with two
 * version-discriminated phases (mirrors ATTEST's lifecycle shape):
 *   v0: Request (VM emission only; originated by xchain.emit.crossExecute()).
 *        A system action row derived from the user's EXECUTE tx (recoverable
 *        from a pure chain parse by replaying the emitting execution.
 *   v2: Expire (system-synthesized; never user-broadcast). Fires the
 *        requester's callback with status='expired' when deadline_block
 *        passes without a relayed result (deterministic from block height
 *        alone, so federation censorship is liveness-bounded.
 *
 * The relay itself (dispatch to the target chain, result back) rides the
 * hub-DB mirror as quorum-signed cross_chain_calls rows; see
 * utility.processCrossChainCalls (injection passes) and actions/xexec.js
 * (target-chain execution).
 *
 * A mirrored result row that can never deliver here (no local request, a routing
 * mismatch, or signatures that miss the cross_chain quorum) is RETIRED once it has
 * aged out, rather than being re-rejected on every block forever: see
 * retireUndeliverableResult. Retirement is consensus-visible and
 * flag-day gated.
 *
 * Spec: xchain-documentation/protocol/actions/XCALL.md
 *
 * FORMATS:
 *   v0 - VERSION|CALL_ID|TARGET_CHAIN|TARGET_CONTRACT_INDEX|METHOD|PARAMS_JSON|GAS_LIMIT|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|DEADLINE_BLOCKS|CROSS_HOPS
 *   v2 - VERSION|CALL_ID            (synthesized only; CALL_ID is sufficient, handler looks up the row)
 *
 ********************************************************************/

const crypto  = require('crypto');
const ed25519 = require('../../consensus/ed25519.js');
const swq     = require('../../stake_weighted_quorum.js');
const eq      = require('../../equivocation_header.js');
const ah      = require('../../mirror_admission_activation.js');

// Vendored from ../protocol/constants.js (byte-identical to xchain-documentation/
// protocol/constants.js; same convention as the VM_MAX_CALL_DEPTH /
// VM_MIN_CALL_GAS mirrors in execute.js). The VM enforces these at emit time;
// this handler re-validates host-side (defense in depth).
const PROTO = require('../../protocol/constants.js');
// Handler parts. Each is called with this handler as the receiver, so the rows
// written and their order do not depend on which file the code sits in.
const request  = require('./request.js');
const expire   = require('./expire.js');
const result   = require('./result.js');
const callback = require('./callback_inject.js');
const { CALL_ID_PREIMAGE_FIELDS, CALL_ID_MISMATCH_ERROR, STATUS_MAX_LENGTH, callIdMismatchStatus } = require('./call_id.js');
const XCALL_MIN_GAS             = PROTO.XCALL_MIN_GAS;             // = VM_MIN_CALL_GAS
const XCALL_MAX_GAS             = PROTO.XCALL_MAX_GAS;             // target-side ceiling cap (calls are fee-less on the target chain)
const XCALL_MAX_HOPS            = PROTO.XCALL_MAX_HOPS;            // user→Y = 1, Y→back = 2; further hops need a fresh user tx
const XCALL_MIN_DEADLINE_BLOCKS = PROTO.XCALL_MIN_DEADLINE_BLOCKS;
const XCALL_MAX_DEADLINE_BLOCKS = PROTO.XCALL_MAX_DEADLINE_BLOCKS; // generous: must cover both chains' confirmation depths + relay rounds
const XCALL_MAX_CALLS_PER_BLOCK = PROTO.XCALL_MAX_CALLS_PER_BLOCK; // deterministic per-block injection cap (overflow carries forward; never dropped)
const XCALL_RESULT_ORPHAN_GRACE_SECONDS = PROTO.XCALL_RESULT_ORPHAN_GRACE_SECONDS; // age-out clock for a result row with no local request

// Flag-day gating the retirement of undeliverable result rows. See the
// registration in src/protocol_changes.js and retireUndeliverableResult
// (result.js), which is handed this gate name by the delegate below.
const ORPHAN_RETIREMENT_GATE = 'XCALL_RESULT_ORPHAN_RETIREMENT';

class Xcall {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Per-version format strings
        this.formats = {};
        this.formats[0] = 'VERSION|CALL_ID|TARGET_CHAIN|TARGET_CONTRACT_INDEX|METHOD|PARAMS_JSON|GAS_LIMIT|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|DEADLINE_BLOCKS|CROSS_HOPS';
        this.formats[2] = 'VERSION|CALL_ID';
    }

    // Stringified call_id preimage values, in CALL_ID_PREIMAGE_FIELDS order.
    // NETWORK and COIN come from node config (uniform across the fleet); the rest
    // are chain data, so every node derives the same bytes.
    callIdPreimageValues(data){
        const src = {
            NETWORK:           this.config['NETWORK'],
            COIN:              this.config['COIN'],
            TX_HASH:           data['TX_HASH'],
            ROOT_ACTION_INDEX: data['ROOT_ACTION_INDEX'],
            CONTRACT_INDEX:    data['CONTRACT_INDEX'],
            EMITTER_PATH:      data['EMITTER_PATH'],
            EMITTER_POSITION:  data['EMITTER_POSITION'],
            TARGET_CHAIN:      data['TARGET_CHAIN']
        };
        return CALL_ID_PREIMAGE_FIELDS.map((f) => String(src[f]));
    }

    // Kept on the handler, in this file, because bin/check-preimage-golden-parity.js
    // pins the golden-vector assertion (the handler routing the preimage through its own
    // callIdPreimageValues) to xcall/index.js: request.js calls this through the handler.
    //
    // Re-derive call_id and compare. Defends against a compromised VM by anchoring
    // the request to (network, source chain, tx_hash, contract_index, emitter_path,
    // emitter_position, target_chain). Network + chain are bound in (unlike the
    // ATTEST preimage) because BTC-family chains share tx-hash space; a call must
    // never collide or replay across chains/networks.
    //
    // EMITTER_PATH (the emitting execution's deterministic call-path, the '>'-joined
    // per-execution emission positions from the root on-chain action down to this
    // execution, root = '') replaces the emitting EXECUTE's action_index. action_index
    // was a function of injection *timing* (it advances with every synthetic action the
    // indexer injects ahead of the EXECUTE); binding it forked call_id across nodes on
    // any injection slip and never re-converged. But dropping it entirely (the prior
    // fix) was unsafe: (tx_hash, contract_index, emitter_position) are NOT unique because
    // emitter_position is per-execution, so two nested runs of the SAME contract each
    // emitting their first call collide. The call-path is BOTH content-derived (stable
    // across nodes/reorgs) AND unique per execution in the call tree; it fixes both.
    //
    // MUST byte-match the VM's derivation in xchain-vm/src/gateway_emit.js
    // (crossExecute). All inputs are REQUIRED; their absence is a hard failure
    // (no silent bypass). NOTE: EMITTER_PATH '' (root on-chain action) is VALID;
    // check === undefined / null, never falsy.
    deriveCallId(data, error){
        if(!error){
            if(data['EMITTER_POSITION'] === undefined || data['EMITTER_POSITION'] === null){
                error = 'invalid: EMITTER_POSITION (required for call_id derivation)';
            } else if(data['EMITTER_PATH'] === undefined || data['EMITTER_PATH'] === null){
                error = 'invalid: EMITTER_PATH (required for call_id derivation)';
            } else if(data['ROOT_ACTION_INDEX'] === undefined || data['ROOT_ACTION_INDEX'] === null){
                // The per-root discriminator (deterministic root on-chain action_index). Required;
                // check === undefined/null (0 is a valid index). Hashed as the raw string it
                // arrives as: for a root that is a BATCH subcommand it is the composite
                // "<TX_VOUT>.<position>" (src/consensus/batch_root_discriminator.js), never Number()-coerced.
                error = 'invalid: ROOT_ACTION_INDEX (required for call_id derivation)';
            } else if(!data['TX_HASH']){
                error = 'invalid: TX_HASH (required for call_id derivation)';
            } else {
                // Assembled through CALL_ID_PREIMAGE_FIELDS so order and count live in
                // one declared list; the joined bytes are identical to the former
                // hand-written concatenation (NETWORK:COIN:TX_HASH:ROOT_ACTION_INDEX:
                // CONTRACT_INDEX:EMITTER_PATH:EMITTER_POSITION:TARGET_CHAIN).
                let values   = this.callIdPreimageValues(data);
                let preimage = values.join(':');
                let expected = crypto.createHash('sha256').update(preimage).digest('hex');
                if(expected !== String(data['CALL_ID']).toLowerCase())
                    error = callIdMismatchStatus(values, expected, data['CALL_ID']);
            }
        }
        return error;
    }

    async parse(params, data, error){

        let format = data['FORMAT'];
        // Verify VERSION is one this handler knows (only the v0 request and the v2 expire exist)
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        if(format === 0) return await this.parseRequest(params, data, error);
        if(format === 2) return await this.parseExpire(params, data, error);
    }

    // XCALL v0: Request (VM emission only). The field checks and the emitter-contract
    // lookup live in request.js; the call_id re-derivation is deriveCallId above. The
    // phase stays a method here because the suites drive and stub it as one.
    async parseRequest(params, data, error){
        return request.parseRequest.call(this, params, data, error);
    }

    // XCALL v2: Expire (system-synthesized). Body in expire.js.
    async parseExpire(params, data, error){
        return expire.parseExpire.call(this, params, data, error);
    }

    // Canonical signing string for the result phase; MUST byte-match the hub's
    // CrossChainCallEngine.canonicalMatch (result branch) and the archive verifier.
    resultCanonical(r){
        let raw = [
            'XCALL', 'RESULT', r.call_id, String(r.snapshot_block), r.network || '',
            r.target_chain, String(r.result_status || ''),
            crypto.createHash('sha256').update(String(r.return_payload_b64 == null ? '' : r.return_payload_b64), 'utf8').digest('hex'),
            String(r.effective_time)
        ].join('|');
        // The admission map the hub signed, rebuilt from the mirrored row's admit_block_*
        // columns and era-keyed on the ROW's snapshot_block, the same field and position the
        // dispatch twin in xexec.js appends. Empty below the producer activation, so the
        // legacy bytes are unchanged; a modern row with no columns REFUSES rather than
        // rebuilding legacy bytes no honest quorum signed.
        raw += ah.admissionCanonicalField('CrossChainCall', r.network, r.snapshot_block, ah.columnsAdmitBlocks(r));
        // EQUIV header (the equivocation flag day): TAG=XCALL, ROUND_ID = sha256('XCALLROUND|result|'+call_id)
        // (distinct from the dispatch key), VIEW = finalizing_view.
        if(eq.isEquivHeaderActive(r.snapshot_block, r.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL,
                crypto.createHash('sha256').update('XCALLROUND|result|' + r.call_id, 'utf8').digest('hex'),
                (r.finalizing_view != null ? r.finalizing_view : 0), raw);
        return raw;
    }

    // Verify the cross_chain quorum over a mirrored result row's canonical.
    // Stake-weighted (source-deduped 3·Σ>2·S) at/above STAKE_WEIGHTED_QUORUM
    // (BTC snapshot_block + network), else legacy 2f+1 signer count. Returns
    //   { synced:false }                        - capability snapshot not mirrored yet (defer)
    //   { synced:true, quorumMet, N, validSigners } - snapshot present; quorum verdict
    // Shared by processResult (delivery) and resultSuppressesExpiry (the deadline
    // gate) so the two can never drift on what counts as a deliverable result.
    async verifyResultQuorum(r){
        let snapshotBlock = Number(r.snapshot_block);
        let weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, r.network);
        let validators = weighted
            ? await this.indexerDb.getStakeWeightsByCapability('cross_chain', snapshotBlock)
            : await this.indexerDb.getValidatorsByCapability('cross_chain', snapshotBlock);
        let N = (validators && validators.length) ? validators.length : 0;
        if(N === 0) return { synced: false, quorumMet: false, N: 0, validSigners: [], weighted };

        let sigs;
        try { sigs = JSON.parse(r.validator_signatures || '[]'); }
        catch(_) { sigs = []; }

        let canonical = this.resultCanonical(r);
        let snapPubkeys = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
        let validSigners = [], seen = new Set();
        for(let s of sigs){
            let pk  = String(s.pubkey || '').toLowerCase();
            let sig = String(s.sig || '').toLowerCase();
            if(seen.has(pk)) continue;
            if(!/^[0-9a-f]{64}$/.test(pk) || !/^[0-9a-f]{128}$/.test(sig)) continue;
            if(!snapPubkeys.has(pk)) continue;
            if(!ed25519.verify(canonical, sig, pk)) continue;
            // Mark seen only AFTER the signature verifies, matching the hub
            // finalizer and the SDK/explorer/sync verifiers (and anchor.js):
            // marking on first encounter lets a garbage-then-valid pair for one
            // qualified validator suppress the real signature (order-dependent
            // quorum under-count, flipping a quorate result verdict closed).
            seen.add(pk);
            validSigners.push(pk);
        }
        let quorumMet = weighted
            ? swq.meetsStakeThreshold(validators, validSigners)
            : (validSigners.length >= ((N <= 1) ? 1 : Math.max(2 * Math.floor((N - 1) / 3) + 1, Math.ceil((N + 1) / 2))));
        return { synced: true, quorumMet, N, validSigners, weighted };
    }

    // Does a mirrored, effective result row for `call_id` legitimately defer or
    // satisfy the request (and therefore MUST suppress deadline expiry)? True when
    // either the capability snapshot is not mirrored yet (defer, as processResult
    // does) OR the 2f+1 quorum verifies. A finalized-but-unverifiable result row
    // (Byzantine/buggy hub mirror) returns FALSE, so deadline expiry still fires:
    // otherwise processResult rejects that row every block while the expiry gate saw
    // only its presence and suppressed expiry forever - deadlocking the requester's
    // callback and diverging indexers that mirror different hubs on whether the v2
    // expiry action exists. (processResult also RETIRES such a row once the request's
    // deadline_block has passed, which is downstream of this gate: the request must
    // reach that deadline in the first place, and it only does because this returns
    // false.)
    // Mirrors processResult's exact delivery gates (network, local request, routing,
    // quorum) so the two paths agree byte-for-byte on deliverability.
    async resultSuppressesExpiry(r){
        if(String(r.network || '') !== String(this.config['NETWORK'] || '')) return false;
        let request = await this.indexerDb.getCrossChainCallRequestById(String(r.call_id || '').toLowerCase());
        if(!request) return false;
        if(String(request.target_chain) !== String(r.target_chain)) return false;
        let q = await this.verifyResultQuorum(r);
        // Snapshot not synced yet → the result will deliver once mirrored; keep the
        // request alive (defer expiry), matching processResult's deferral. Otherwise
        // suppress only on a verified quorum.
        return q.synced ? q.quorumMet : true;
    }

    // Has an undeliverable result row aged out, i.e. can it no longer become
    // deliverable on any branch this chain could still adopt? Both clocks live in
    // result.js; it stays a method here because retirement and the suites read it
    // through the handler.
    resultAgedOut(r, request, data){
        return result.resultAgedOut.call(this, r, request, data);
    }

    // Retire a result row this chain can never deliver (body in result.js). The
    // flag-day gate name is passed in rather than re-declared there, so the gate
    // this handler exports and the gate the retirement asks about are one string.
    async retireUndeliverableResult(r, data, callId, request, reason){
        return result.retireUndeliverableResult.call(this, r, data, callId, request, reason, ORPHAN_RETIREMENT_GATE);
    }

    // Process one mirrored, effective result row for a request THIS chain
    // originated (body in result.js).
    async processResult(r, data){
        return result.processResult.call(this, r, data);
    }

    // Synthesize the callback EXECUTE delivering a cross-chain call outcome to the
    // requesting contract (body in callback_inject.js). Shared by the result pass
    // and the expiry path; returns the callback EXECUTE's action_index.
    async injectCallback(request, contextData, resultStatus, resultPayload){
        return callback.injectCallback.call(this, request, contextData, resultStatus, resultPayload);
    }
}

// The protocol limits and the call_id declarations, readable off the class
// (Xcall.XCALL_MAX_CALLS_PER_BLOCK, Xcall.CALL_ID_PREIMAGE_FIELDS and the rest). They hang on
// the handler rather than on a second export object, so the module's one export stays
// the class and every consumer reads the same names it always did.
Xcall.XCALL_MIN_GAS             = XCALL_MIN_GAS;
Xcall.XCALL_MAX_GAS             = XCALL_MAX_GAS;
Xcall.XCALL_MAX_HOPS            = XCALL_MAX_HOPS;
Xcall.XCALL_MIN_DEADLINE_BLOCKS = XCALL_MIN_DEADLINE_BLOCKS;
Xcall.XCALL_MAX_DEADLINE_BLOCKS = XCALL_MAX_DEADLINE_BLOCKS;
Xcall.XCALL_MAX_CALLS_PER_BLOCK = XCALL_MAX_CALLS_PER_BLOCK;
Xcall.XCALL_RESULT_ORPHAN_GRACE_SECONDS = XCALL_RESULT_ORPHAN_GRACE_SECONDS;
Xcall.ORPHAN_RETIREMENT_GATE           = ORPHAN_RETIREMENT_GATE;
Xcall.CALL_ID_PREIMAGE_FIELDS          = CALL_ID_PREIMAGE_FIELDS;
Xcall.CALL_ID_MISMATCH_ERROR           = CALL_ID_MISMATCH_ERROR;
Xcall.STATUS_MAX_LENGTH                = STATUS_MAX_LENGTH;
Xcall.callIdMismatchStatus             = callIdMismatchStatus;

module.exports = Xcall;
