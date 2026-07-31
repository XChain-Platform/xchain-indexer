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
 * _retireUndeliverableResult . Retirement is consensus-visible and
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
const ed25519 = require('../ed25519.js');
const swq     = require('../stake_weighted_quorum.js');
const eq      = require('../equivocation_header.js');
const { rethrowIfInfraFault } = require('./faultGuard.js');
const { buildInjectedExecContext, SYNTH_TAGS } = require('./execContext.js');

// Vendored from ../protocol/constants.js (byte-identical to xchain-documentation/
// protocol/constants.js; same convention as the VM_MAX_CALL_DEPTH /
// VM_MIN_CALL_GAS mirrors in execute.js). The VM enforces these at emit time;
// this handler re-validates host-side (defense in depth).
const PROTO = require('../protocol/constants.js');
const XCALL_MIN_GAS             = PROTO.XCALL_MIN_GAS;             // = VM_MIN_CALL_GAS
const XCALL_MAX_GAS             = PROTO.XCALL_MAX_GAS;             // target-side ceiling cap (calls are fee-less on the target chain)
const XCALL_MAX_HOPS            = PROTO.XCALL_MAX_HOPS;            // user→Y = 1, Y→back = 2; further hops need a fresh user tx
const XCALL_MIN_DEADLINE_BLOCKS = PROTO.XCALL_MIN_DEADLINE_BLOCKS;
const XCALL_MAX_DEADLINE_BLOCKS = PROTO.XCALL_MAX_DEADLINE_BLOCKS; // generous: must cover both chains' confirmation depths + relay rounds
const XCALL_MAX_CALLS_PER_BLOCK = PROTO.XCALL_MAX_CALLS_PER_BLOCK; // deterministic per-block injection cap (overflow carries forward; never dropped)
const XCALL_RESULT_ORPHAN_GRACE_SECONDS = PROTO.XCALL_RESULT_ORPHAN_GRACE_SECONDS; // age-out clock for a result row with no local request 

const ALLOWED_CHAINS = ['BTC', 'LTC', 'DOGE'];

// Flag-day gating the retirement of undeliverable result rows . See the
// registration in src/protocol_changes.js and _retireUndeliverableResult below.
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

    // Dispatch on VERSION
    async parse(params, data, error){

        let format = data['FORMAT'];
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        if(format === 0) return await this._parseRequest(params, data, error);
        if(format === 2) return await this._parseExpire(params, data, error);
    }

    // XCALL v0: Request (VM emission only)
    async _parseRequest(params, data, error){

        // VM-emission-only: reject anything user-initiated.
        if(!error && !data['IS_EMISSION'])
            error = 'invalid: XCALL v0 must originate from VM emission';

        // Extract positional params
        data['CALL_ID']               = params[1];
        data['TARGET_CHAIN']          = params[2];
        data['TARGET_CONTRACT_INDEX'] = params[3];
        data['METHOD']                = params[4];
        data['PARAMS_JSON']           = params[5];
        data['GAS_LIMIT']             = params[6];
        data['CALLBACK_METHOD']       = params[7];
        data['CALLBACK_PARAMS']       = params[8];
        data['DEADLINE_BLOCKS']       = params[9];
        data['CROSS_HOPS']            = params[10];
        // EMITTER carries the contract's action_index (set by execute.processEmission)
        data['CONTRACT_INDEX']        = data['EMITTER'];

        if(!error)
            data = this.util.setNumberFormats(data);

        if(!error && (!data['CALL_ID'] || !/^[0-9a-fA-F]{64}$/.test(String(data['CALL_ID']))))
            error = 'invalid: CALL_ID (format)';

        if(!error && (ALLOWED_CHAINS.indexOf(String(data['TARGET_CHAIN'])) === -1))
            error = 'invalid: TARGET_CHAIN (unknown)';

        if(!error && String(data['TARGET_CHAIN']) === String(this.config['COIN']))
            error = 'invalid: TARGET_CHAIN (must differ from this chain)';

        let targetContract = parseInt(data['TARGET_CONTRACT_INDEX']);
        if(!error && (!Number.isInteger(targetContract) || targetContract <= 0))
            error = 'invalid: TARGET_CONTRACT_INDEX (must be a positive integer)';

        if(!error && this.util.isNull(data['METHOD']))
            error = 'invalid: METHOD (required)';
        if(!error && Buffer.byteLength(String(data['METHOD']), 'utf8') > 64)
            error = 'invalid: METHOD (too long)';

        // PARAMS_JSON must be a JSON array of strings (≤32 entries, each ≤1024 bytes);
        // same caps as same-chain emit.execute params.
        if(!error){
            let parsed = null;
            try { parsed = JSON.parse(String(data['PARAMS_JSON'] || '[]')); } catch(_){ parsed = null; }
            if(!Array.isArray(parsed) || parsed.length > 32 ||
               parsed.some(p => typeof p !== 'string' || Buffer.byteLength(p, 'utf8') > 1024))
                error = 'invalid: PARAMS_JSON (must be array of <=32 strings, each <=1024 bytes)';
        }

        let gasLimit = parseInt(data['GAS_LIMIT']);
        if(!error && (!Number.isInteger(gasLimit) || gasLimit < XCALL_MIN_GAS || gasLimit > XCALL_MAX_GAS))
            error = 'invalid: GAS_LIMIT (out of range [' + XCALL_MIN_GAS + ', ' + XCALL_MAX_GAS + '])';

        if(!error && this.util.isNull(data['CALLBACK_METHOD']))
            error = 'invalid: CALLBACK_METHOD (required)';
        if(!error && Buffer.byteLength(String(data['CALLBACK_METHOD']), 'utf8') > 64)
            error = 'invalid: CALLBACK_METHOD (too long)';

        let deadlineBlocks = parseInt(data['DEADLINE_BLOCKS']);
        if(!error && (!Number.isInteger(deadlineBlocks) ||
                      deadlineBlocks < XCALL_MIN_DEADLINE_BLOCKS || deadlineBlocks > XCALL_MAX_DEADLINE_BLOCKS))
            error = 'invalid: DEADLINE_BLOCKS (out of range [' + XCALL_MIN_DEADLINE_BLOCKS + ', ' + XCALL_MAX_DEADLINE_BLOCKS + '])';
        data['DEADLINE_BLOCK'] = parseInt(data['BLOCK_INDEX']) + (Number.isFinite(deadlineBlocks) ? deadlineBlocks : 0);

        let crossHops = parseInt(data['CROSS_HOPS']);
        if(!error && (!Number.isInteger(crossHops) || crossHops < 1 || crossHops > XCALL_MAX_HOPS))
            error = 'invalid: CROSS_HOPS (out of range [1, ' + XCALL_MAX_HOPS + '])';

        // Validate contract_index references a real contract
        if(!error && data['CONTRACT_INDEX'] != null){
            let contract = await this.indexerDb.getContract(data['CONTRACT_INDEX']);
            if(!contract)
                error = 'invalid: CONTRACT_INDEX (unknown)';
        } else if(!error){
            error = 'invalid: CONTRACT_INDEX (missing emitter)';
        }

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
        // MUST byte-match the VM's derivation in xchain-vm/src/gateway-emit.js
        // (crossExecute). All inputs are REQUIRED; their absence is a hard failure
        // (no silent bypass). NOTE: EMITTER_PATH '' (root on-chain action) is VALID;
        // check === undefined / null, never falsy.
        if(!error){
            if(data['EMITTER_POSITION'] === undefined || data['EMITTER_POSITION'] === null){
                error = 'invalid: EMITTER_POSITION (required for call_id derivation)';
            } else if(data['EMITTER_PATH'] === undefined || data['EMITTER_PATH'] === null){
                error = 'invalid: EMITTER_PATH (required for call_id derivation)';
            } else if(data['ROOT_ACTION_INDEX'] === undefined || data['ROOT_ACTION_INDEX'] === null){
                // The per-root discriminator (deterministic root on-chain action_index). Required;
                // check === undefined/null (0 is a valid index).
                error = 'invalid: ROOT_ACTION_INDEX (required for call_id derivation)';
            } else if(!data['TX_HASH']){
                error = 'invalid: TX_HASH (required for call_id derivation)';
            } else {
                let preimage = String(this.config['NETWORK']) + ':' + String(this.config['COIN']) + ':' +
                               String(data['TX_HASH']) + ':' + String(data['ROOT_ACTION_INDEX']) + ':' +
                               String(data['CONTRACT_INDEX']) + ':' + String(data['EMITTER_PATH']) + ':' +
                               String(data['EMITTER_POSITION']) + ':' +
                               String(data['TARGET_CHAIN']);
                let expected = crypto.createHash('sha256').update(preimage).digest('hex');
                if(expected !== String(data['CALL_ID']).toLowerCase())
                    error = 'invalid: CALL_ID (does not match deterministic derivation)';
            }
        }

        data['REQUEST_STATUS'] = 'pending';
        data['FEE_PAYER']      = data['FEE_PAYER'] || data['SOURCE'];

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t XCALL v0 : id=" + (data['CALL_ID'] ? String(data['CALL_ID']).substring(0,16) + '...' : '?') +
                    ' : ' + this.config['COIN'] + ':' + data['CONTRACT_INDEX'] +
                    ' → ' + data['TARGET_CHAIN'] + ':' + data['TARGET_CONTRACT_INDEX'] +
                    ' . ' + data['METHOD'] +
                    ' : gas=' + data['GAS_LIMIT'] + ' hops=' + data['CROSS_HOPS'] +
                    ' : ' + data['STATUS']);

        await this.indexerDb.createCrossChainCallRequest(data);
        await this.mapper.createMappings(data);
    }

    // XCALL v2: Expire (system-synthesized)
    async _parseExpire(params, data, error){

        // System-synthesized only; guard against accidental synthesis from a user tx.
        if(!data['IS_SYNTHETIC']){
            console.warn('\t XCALL v2 : rejected (user-broadcast not allowed for synthetic expire)');
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

        console.log("\t XCALL v2 : id=" + callId.substring(0,16) + '...' +
                    ' : deadline=' + request.deadline_block +
                    ' : block=' + data['BLOCK_INDEX']);

        // Flip request status to 'expired' BEFORE injecting (interlock order).
        await this.indexerDb.updateCrossChainCallRequestStatus(callId, 'expired', 'expired', '', data['BLOCK_INDEX']);

        // Synthesize the callback EXECUTE so the contract can clean up (status='expired').
        try {
            await this._injectCallback(request, data, 'expired', '');
        } catch(e){
            // An infra fault (VM host down, DB driver errno) is not a callback outcome:
            // halt so the block retries, instead of committing a locally-dropped
            // callback that forks contract_hash against healthy peers (faultGuard.js).
            rethrowIfInfraFault(e);
            console.warn('XCALL expiry callback failed:', e);
        }

        await this.mapper.createMappings(data);
    }

    // Canonical signing string for the result phase; MUST byte-match the hub's
    // CrossChainCallEngine._canonicalMatch (result branch) and the archive verifier.
    _resultCanonical(r){
        let raw = [
            'XCALL', 'RESULT', r.call_id, String(r.snapshot_block), r.network || '',
            r.target_chain, String(r.result_status || ''),
            crypto.createHash('sha256').update(String(r.return_payload_b64 == null ? '' : r.return_payload_b64), 'utf8').digest('hex'),
            String(r.effective_time)
        ].join('|');
        // EQUIV (WI-2 bump 2): TAG=XCALL, ROUND_ID = sha256('XCALLROUND|result|'+call_id)
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
    async _verifyResultQuorum(r){
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

        let canonical = this._resultCanonical(r);
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
    // expiry action exists. (Since  processResult also RETIRES such a row once
    // the request's deadline_block has passed, which is downstream of this gate: the
    // request must reach that deadline in the first place, and it only does because
    // this returns false.)
    // Mirrors processResult's exact delivery gates (network, local request, routing,
    // quorum) so the two paths agree byte-for-byte on deliverability.
    async resultSuppressesExpiry(r){
        if(String(r.network || '') !== String(this.config['NETWORK'] || '')) return false;
        let request = await this.indexerDb.getCrossChainCallRequestById(String(r.call_id || '').toLowerCase());
        if(!request) return false;
        if(String(request.target_chain) !== String(r.target_chain)) return false;
        let q = await this._verifyResultQuorum(r);
        // Snapshot not synced yet → the result will deliver once mirrored; keep the
        // request alive (defer expiry), matching processResult's deferral. Otherwise
        // suppress only on a verified quorum.
        return q.synced ? q.quorumMet : true;
    }

    // Has an undeliverable result row aged out, i.e. can it no longer become
    // deliverable on any branch this chain could still adopt? 
    //
    // Two clocks, both node-invariant, both read only from consensus inputs (the
    // block being processed and the quorum-signed mirror row), never wall-clock:
    //
    //   request present  the request's OWN deadline_block is exact. Past it the
    //                    request is terminal (the expiry pass has flipped it, or a
    //                    result already completed it), so no future block can turn
    //                    this row into a delivered callback. Used for the routing
    //                    mismatch and definitively-unquorate cases.
    //
    //   request absent   nothing local carries a deadline, and the mirrored row has
    //                    no deadline field, so the clock is the row's quorum-signed
    //                    effective_time plus XCALL_RESULT_ORPHAN_GRACE_SECONDS of
    //                    block time. The federation only signs a result after the
    //                    request is buried at its source chain's relay confirmation
    //                    depth, and the grace covers the deepest of those windows, so
    //                    a request still absent that far past effectiveness is absent
    //                    because its branch is gone. Should a deeper-than-designed
    //                    reorg restore it anyway, the retirement row is anchored to a
    //                    rollback-able action_index and is erased with it.
    //
    // A row deferred because the capability snapshot is not mirrored yet never reaches
    // here (processResult returns earlier): that row is still expected to deliver, and
    // resultSuppressesExpiry keeps its request alive to receive it.
    _resultAgedOut(r, request, data){
        if(request){
            let deadline = parseInt(request.deadline_block);
            let block    = parseInt(data['BLOCK_INDEX']);
            if(!Number.isFinite(deadline) || !Number.isFinite(block)) return false;
            return block > deadline;
        }
        // parseInt, not Number: Number(null) is 0, which would read a row with a missing
        // effective_time as infinitely old and retire it on sight.
        let effective = parseInt(r.effective_time);
        let blockTime = parseInt(data['BLOCK_TIME']);
        if(!Number.isFinite(effective) || !Number.isFinite(blockTime)) return false;
        return (blockTime - effective) >= XCALL_RESULT_ORPHAN_GRACE_SECONDS;
    }

    // Retire a result row this chain can never deliver, so it stops being re-selected
    // by the capped delivery pass every block . Returns true when the row was
    // retired (the caller must then stop processing it).
    //
    // Without this, an undeliverable row is rejected on every block and pruned by
    // nothing, because pruning is keyed on a recorded callback and the reject paths
    // record none. getEffectiveUnprocessedCallResults orders by (snapshot_block,
    // call_id) and the pass takes only XCALL_MAX_CALLS_PER_BLOCK rows, so as few as 25
    // such rows at a low snapshot_block hold the head of the queue forever and starve
    // every legitimate result behind them ( test-host: 229 rows, head slice 25/25
    // unmatched, blocking the drill's own result at the tail).
    //
    // CONSENSUS-VISIBLE, deliberately. Retirement mints an actions row and frees a slot
    // in a capped per-block pass, which decides which block a real callback EXECUTE
    // lands in; a node-local retirement would fork the delivered set against a node that
    // kept the row. So it is flag-day gated (ORPHAN_RETIREMENT_GATE), decided purely
    // from consensus inputs (_resultAgedOut), and written against a rollback-able
    // action_index like every other cross-chain bookkeeping row, so a source-chain reorg
    // that restores the missing request also erases the retirement and lets the result
    // deliver normally on the branch that carries the request.
    //
    // It delivers NO callback: the requesting contract, if it exists at all, hears the
    // 'expired' outcome from the deadline path, which is the only outcome a chain that
    // never saw the request can agree on.
    async _retireUndeliverableResult(r, data, callId, request, reason){
        if(!(await this.actions.protocolChanges.isEnabled(ORPHAN_RETIREMENT_GATE, data['BLOCK_INDEX'])))
            return false;
        if(!this._resultAgedOut(r, request, data))
            return false;

        // Mint the retirement's own action_index (the rollback anchor). Minted only once
        // the row is genuinely retired: an index minted on a row that stays in the queue
        // would move every later action_index for nothing.
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex({
            ACTION:      'XCALL',
            BLOCK_INDEX: data['BLOCK_INDEX']
        }, true);

        console.log("\t XCALL result : id=" + callId.substring(0,16) + '...' +
                    ' : undeliverable (' + reason + ') and aged out, retiring' +
                    ' : block=' + data['BLOCK_INDEX']);

        await this.indexerDb.recordCrossChainCallCallback(
            data['ACTION_INDEX'], callId, 'retired:' + reason, data['BLOCK_INDEX']);
        return true;
    }

    // Process one mirrored, effective result row for a request THIS chain originated
    // (driven by utility.processCrossChainCalls in (snapshot_block, call_id) order).
    // Verifies the 2f+1 signatures, applies the exactly-once interlock against the
    // deadline-expiry path, injects the requester's callback, and records the
    // processing in cross_chain_call_callbacks (idempotency + rollback anchor).
    // Every exit that is NOT a deferral records something in that table, so no row can
    // sit in the capped queue forever: delivery and the interlock record their outcome,
    // and the three undeliverable exits retire the row once it has aged out .
    async processResult(r, data){
        let callId = String(r.call_id || '').toLowerCase();

        // Network guard (belt-and-suspenders; the query pre-filters).
        if(String(r.network || '') !== String(this.config['NETWORK'] || '')) return;

        // The result must correspond to a request THIS chain knows, with matching
        // routing: a forged result for someone else's call_id can never deliver.
        let request = await this.indexerDb.getCrossChainCallRequestById(callId);
        if(!request){
            if(await this._retireUndeliverableResult(r, data, callId, null, 'no_request')) return;
            console.warn("\t XCALL result : id=" + callId.substring(0,16) + '... : no matching local request, skipping');
            return;
        }
        if(String(request.target_chain) !== String(r.target_chain)){
            if(await this._retireUndeliverableResult(r, data, callId, request, 'routing')) return;
            console.warn("\t XCALL result : id=" + callId.substring(0,16) + '... : target_chain mismatch, skipping');
            return;
        }

        // ── Verify the cross_chain quorum over the result canonical ──────────────
        let q = await this._verifyResultQuorum(r);
        if(!q.synced){
            // Snapshot not mirrored yet; defer (the barriers front-stop this; see xexec.js).
            console.log("\t XCALL result : id=" + callId.substring(0,16) + '... : capability snapshot not synced, deferring');
            return;
        }
        let N = q.N, validSigners = q.validSigners;
        if(!q.quorumMet){
            if(await this._retireUndeliverableResult(r, data, callId, request, 'no_quorum')) return;
            console.warn("\t XCALL result : id=" + callId.substring(0,16) + '... : insufficient ' + (q.weighted ? 'signer stake' : 'valid signatures (' + validSigners.length + '/' + N + ')') + ', skipping');
            return;
        }

        // Mint the internal processing action (rollback anchor for the callback record).
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex({
            ACTION:      'XCALL',
            BLOCK_INDEX: data['BLOCK_INDEX']
        }, true);

        let resultStatus  = String(r.result_status || 'error');
        let resultPayload = '';
        try { resultPayload = Buffer.from(String(r.return_payload_b64 || ''), 'base64').toString('utf8'); }
        catch(_){ resultPayload = ''; }

        // ── Exactly-once interlock vs the deadline-expiry path ──────────────────
        // Both paths are block-height-driven and share request_status: whichever
        // reaches terminal first wins; the loser records itself as skipped so the
        // result row is never re-evaluated (idempotency row below) but the contract
        // hears exactly one outcome.
        if(request.request_status !== 'pending'){
            console.log("\t XCALL result : id=" + callId.substring(0,16) + '... : request already ' + request.request_status + ', recording skip');
            await this.indexerDb.recordCrossChainCallCallback(
                data['ACTION_INDEX'], callId, 'skipped:' + request.request_status, data['BLOCK_INDEX']);
            return;
        }

        console.log("\t XCALL result : id=" + callId.substring(0,16) + '...' +
                    ' : from=' + r.target_chain + ' : status=' + resultStatus +
                    ' : sigs=' + validSigners.length + '/' + N);

        // Flip to terminal BEFORE injecting (interlock order; also feeds getCallResult).
        await this.indexerDb.updateCrossChainCallRequestStatus(callId, 'completed', resultStatus, resultPayload, data['BLOCK_INDEX']);

        // Inject the callback; a failing callback does NOT roll back the bookkeeping.
        try {
            let callbackActionIndex = await this._injectCallback(request, data, resultStatus, resultPayload);
            if(callbackActionIndex)
                await this.indexerDb.setCrossChainCallCallbackIndex(callId, callbackActionIndex);
        } catch(e){
            // Infra faults must halt the block, not record a callback-less result
            // this validator alone commits (see faultGuard.js).
            rethrowIfInfraFault(e);
            console.warn('XCALL result callback injection failed:', e);
        }

        await this.indexerDb.recordCrossChainCallCallback(
            data['ACTION_INDEX'], callId, resultStatus, data['BLOCK_INDEX']);

        await this.mapper.createMappings(data);
    }

    // Synthesize the callback EXECUTE delivering a cross-chain call outcome to the
    // requesting contract. Shared by the result pass (utility.processCrossChainCalls)
    // and the expiry path above. Runs under the fixed callback gas ceiling the caller
    // pre-paid at emit time, inside its own savepoint; a failing callback never rolls
    // back the result/expiry bookkeeping. Returns the callback EXECUTE's action_index.
    //
    // Callback signature: callbackMethod(call_id, target_chain, status, return_payload, ...callbackParams)
    async _injectCallback(request, contextData, resultStatus, resultPayload){
        if(!this.actions.actionExecute) return null;

        // Callback ceiling: read from the gas schedule so it stays in sync with
        // the VM_XCALL_CALLBACK amount charged at emit time (gateway-emit.js crossExecute).
        // Hard-fail on a missing or non-positive value: a silent default would allow the
        // injected ceiling to diverge from the amount the VM charged at emit time if the
        // schedule is misconfigured, producing an ok/out_of_gas split across validators.
        let schedule = (this.config && this.config['GAS_SCHEDULE']) || {};
        let xcallCallbackGasRaw = schedule['VM_XCALL_CALLBACK'];
        let xcallCallbackGasVal = parseInt(xcallCallbackGasRaw, 10);
        if(xcallCallbackGasRaw === undefined || xcallCallbackGasRaw === null || !Number.isInteger(xcallCallbackGasVal) || xcallCallbackGasVal <= 0 || String(xcallCallbackGasRaw).trim() !== String(xcallCallbackGasVal)){
            throw new Error('GAS_SCHEDULE.VM_XCALL_CALLBACK missing or invalid (expected a positive integer, got ' + JSON.stringify(xcallCallbackGasRaw) + ')');
        }
        const XCALL_CALLBACK_GAS = xcallCallbackGasVal;

        let callbackParams = [];
        if(request.callback_params_json){
            try {
                let parsed = JSON.parse(request.callback_params_json);
                if(Array.isArray(parsed)) callbackParams = parsed;
            } catch(_){
                callbackParams = [];
            }
        }

        let callbackArgs = [
            request.call_id,
            String(request.target_chain || ''),
            String(resultStatus),
            String(resultPayload == null ? '' : resultPayload),
            ...callbackParams.map(String)
        ];

        // Positional EXECUTE format: VERSION|CONTRACT_ACTION_INDEX|METHOD|PARAMS...
        let actionParams = [
            0,
            request.contract_index,
            request.callback_method,
            ...callbackArgs
        ];

        let chain = this.config['CHAIN'];
        let emissionActionIndex = await this.indexerDb.createActionIndex({
            ACTION:      'EXECUTE',
            BLOCK_INDEX: contextData['BLOCK_INDEX'],
            FORMAT:      0,
            SOURCE:      'C:' + chain + ':' + request.contract_index
        }, true);

        // SOURCE = contract address (ATTEST callback precedent). The synthetic TX_HASH
        // ('XCALLCB' tag, live consensus, byte-identical to the pre- inline
        // synthesis) is chain/network-namespaced so anything the callback itself emits
        // (ATTEST, emit.execute, crossExecute) derives collision-free ids. CROSS_HOPS
        // carries the call's hop count into the callback context so a contract reacting
        // to a callback by calling out again stays inside the hop budget.
        let emissionData = buildInjectedExecContext({
            chain:         chain,
            network:       this.config['NETWORK'],
            contractIndex: request.contract_index,
            actionIndex:   emissionActionIndex,
            blockIndex:    contextData['BLOCK_INDEX'],
            blockTime:     contextData['BLOCK_TIME'],
            emitter:       contextData['ACTION_INDEX'],
            synthTag:      SYNTH_TAGS.XCALL_CALLBACK,
            synthId:       request.call_id,
            extra: {
                CALL_DEPTH:   0,
                VM_GAS_LIMIT: XCALL_CALLBACK_GAS,
                CROSS_HOPS:   Number(request.cross_hops) || 0
            }
        });

        let savepoint = await this.indexerDb.createSavepoint('xcall_callback_' + emissionActionIndex);
        try {
            await this.actions.actionExecute.parse(actionParams, emissionData, null);
            if(emissionData['STATUS'] && emissionData['STATUS'] !== 'valid'){
                console.warn('XCALL callback execute returned non-valid status: ' + emissionData['STATUS']);
            }
            await this.indexerDb.releaseSavepoint(savepoint);
            return emissionActionIndex;
        } catch(e){
            await this.indexerDb.rollbackToSavepoint(savepoint);
            throw e;
        }
    }
}

module.exports = Xcall;
module.exports.XCALL_MIN_GAS             = XCALL_MIN_GAS;
module.exports.XCALL_MAX_GAS             = XCALL_MAX_GAS;
module.exports.XCALL_MAX_HOPS            = XCALL_MAX_HOPS;
module.exports.XCALL_MIN_DEADLINE_BLOCKS = XCALL_MIN_DEADLINE_BLOCKS;
module.exports.XCALL_MAX_DEADLINE_BLOCKS = XCALL_MAX_DEADLINE_BLOCKS;
module.exports.XCALL_MAX_CALLS_PER_BLOCK = XCALL_MAX_CALLS_PER_BLOCK;
module.exports.XCALL_RESULT_ORPHAN_GRACE_SECONDS = XCALL_RESULT_ORPHAN_GRACE_SECONDS;
module.exports.ORPHAN_RETIREMENT_GATE           = ORPHAN_RETIREMENT_GATE;
