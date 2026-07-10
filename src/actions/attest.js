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
 * External-data attestation lifecycle with three version-discriminated phases:
 *   v0: Request (VM emission only; originated by xchain.attestation.request())
 *   v1: Response (validator-broadcast PBFT bundle with signatures)
 *   v2: Expire (system-synthesized; never user-broadcast)
 *
 * Spec: xchain-documentation/protocol/actions/ATTEST.md
 *
 * FORMATS:
 *   v0 - VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS
 *   v1 - VERSION|REQUEST_ID|PROVIDER_ID|RESPONSE_PAYLOAD|STATUS|META|SIG_COUNT|PUBKEY|SIG|...
 *   v2 - VERSION|REQUEST_ID         (synthesized only; REQUEST_ID is sufficient, handler looks up the row)
 *
 ********************************************************************/

const crypto  = require('crypto');
const ed25519 = require('../ed25519.js');
const swq     = require('../stake_weighted_quorum.js');
const eq      = require('../equivocation_header.js');
const ProviderRegistry = require('../attestation/providerRegistry.js');

class Attest {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Providers are registered in-process via ProviderRegistry (http_get and llm supported).
        this.providerRegistry = new ProviderRegistry();

        // Per-version format strings
        this.formats = {};
        // FEE_TICK|FEE_AMOUNT are optional trailing fields (E1 paid-attestation
        // wire prep): absent on the wire → null, and the SDK serializer trims
        // trailing empties, so feeless requests stay byte-identical to the
        // 8-field format. v1 consensus accepts only FEE_TICK == GAS (XCHAIN);
        // arbitrary ticks are a post-launch rule loosening, not a wire change.
        this.formats[0] = 'VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS|FEE_TICK|FEE_AMOUNT';
        this.formats[1] = 'VERSION|REQUEST_ID|PROVIDER_ID|RESPONSE_PAYLOAD|STATUS|META|SIG_COUNT|PUBKEY|SIG|...';
        this.formats[2] = 'VERSION|REQUEST_ID';
    }

    // Dispatch on VERSION
    async parse(params, data, error){

        let format = data['FORMAT'];
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        if(format === 0) return await this._parseRequest(params, data, error);
        if(format === 1) return await this._parseResponse(params, data, error);
        if(format === 2) return await this._parseExpire(params, data, error);
    }

    // ATTEST v0: Request (VM emission only)
    async _parseRequest(params, data, error){

        // VM-emission-only: reject anything user-initiated.
        // execute.processEmission sets IS_EMISSION=true when synthesizing the action.
        if(!error && !data['IS_EMISSION'])
            error = 'invalid: ATTEST v0 must originate from VM emission';

        // Extract positional params
        data['REQUEST_ID']      = params[1];
        data['PROVIDER_ID']     = params[2];
        data['REQUEST_PAYLOAD'] = params[3];
        data['CALLBACK_METHOD'] = params[4];
        data['CALLBACK_PARAMS'] = params[5];
        data['REDUNDANCY']      = params[6];
        data['DEADLINE_BLOCKS'] = params[7];
        data['FEE_TICK']        = (params[8] !== undefined && String(params[8]).trim() !== '') ? String(params[8]).trim() : null;
        data['FEE_AMOUNT']      = (params[9] !== undefined && String(params[9]).trim() !== '') ? String(params[9]).trim() : null;
        // EMITTER carries the contract's action_index (set by execute.processEmission)
        data['CONTRACT_INDEX']  = data['EMITTER'];

        if(!error)
            data = this.util.setNumberFormats(data);

        if(!error && (!data['REQUEST_ID'] || !/^[0-9a-fA-F]{64}$/.test(String(data['REQUEST_ID']))))
            error = 'invalid: REQUEST_ID (format)';

        if(!error && this.util.isNull(data['PROVIDER_ID']))
            error = 'invalid: PROVIDER_ID (required)';

        if(!error && !this.providerRegistry.isKnown(data['PROVIDER_ID']))
            error = 'invalid: PROVIDER_ID (unknown)';

        if(!error && this.util.isNull(data['CALLBACK_METHOD']))
            error = 'invalid: CALLBACK_METHOD (required)';

        let redundancy = parseInt(data['REDUNDANCY']);
        if(!error && !this.providerRegistry.isRedundancyAllowed(data['PROVIDER_ID'], redundancy))
            error = 'invalid: REDUNDANCY (not allowed for provider)';

        let payloadBytes = Buffer.byteLength(String(data['REQUEST_PAYLOAD'] || ''), 'utf8');
        if(!error && !this.providerRegistry.isPayloadSizeAllowed(data['PROVIDER_ID'], payloadBytes))
            error = 'invalid: REQUEST_PAYLOAD (exceeds provider max)';

        let deadlineBlocks = parseInt(data['DEADLINE_BLOCKS']);
        let deadlineBlock  = parseInt(data['BLOCK_INDEX']) + (Number.isFinite(deadlineBlocks) ? deadlineBlocks : 0);
        data['DEADLINE_BLOCK'] = deadlineBlock;
        if(!error && !this.providerRegistry.isDeadlineAllowed(data['PROVIDER_ID'], parseInt(data['BLOCK_INDEX']), deadlineBlock))
            error = 'invalid: DEADLINE (outside provider window)';

        // Optional request fee (E1). XCHAIN-only in v1: the validator_rewards →
        // COLLECT payout chain is GAS-denominated, so consensus pins FEE_TICK to
        // the GAS tick. The field exists on the wire so post-launch multi-tick
        // support is a rule loosening, not a format change.
        if(!error && !this.util.isNull(data['FEE_TICK']) && data['FEE_TICK'] !== this.config['GAS'])
            error = 'invalid: FEE_TICK (only ' + this.config['GAS'] + ' accepted)';

        // isValidFiatFormat = isValidAmountFormat + a decimal-place cap. The fee
        // must not carry more precision than the GAS tick is issued with: the
        // escrow/debit/credit ledger rows round to the tick's decimals
        // (createLedgerChangeRecord), so a finer fee would be CHARGED rounded
        // while attests.fee_amount keeps the unrounded string, desyncing the
        // reward split (computed from the unrounded fee_amount) from the escrow.
        // Cap at min(8, gasDecimals): 8 is the hard ceiling the equal split
        // floors to (bcmulfloor(...,8)); gasDecimals is the consensus precision
        // of the GAS tick (8 for the production XCHAIN genesis issuance, 0 on
        // the decimals-0 regtest GAS tick). Deterministic: every validator
        // replaying from genesis reads the same issues-table state at this block.
        if(!error && !this.util.isNull(data['FEE_AMOUNT'])){
            let gasDecimals = await this.indexerDb.getTokenDecimalPrecision(
                await this.indexerDb.getTickerId(this.config['GAS'])
            );
            let feeCap = Math.min(8, gasDecimals);
            if(!this.util.isValidFiatFormat(feeCap, data['FEE_AMOUNT']))
                error = 'invalid: FEE_AMOUNT (precision > ' + feeCap + ' dp)';
        }

        let feePresent = !error && !this.util.isNull(data['FEE_AMOUNT']) && this.util.bcgt(data['FEE_AMOUNT'], '0');
        if(!error && feePresent && this.util.isNull(data['FEE_TICK']))
            error = 'invalid: FEE_TICK (required when FEE_AMOUNT > 0)';

        // Validate contract_index references a real contract
        if(!error && data['CONTRACT_INDEX'] != null){
            let contract = await this.indexerDb.getContract(data['CONTRACT_INDEX']);
            if(!contract)
                error = 'invalid: CONTRACT_INDEX (unknown)';
        } else if(!error){
            error = 'invalid: CONTRACT_INDEX (missing emitter)';
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
        if(!error){
            if(data['EMITTER_POSITION'] === undefined || data['EMITTER_POSITION'] === null){
                error = 'invalid: EMITTER_POSITION (required for request_id derivation)';
            } else if(data['EMITTER_PATH'] === undefined || data['EMITTER_PATH'] === null){
                error = 'invalid: EMITTER_PATH (required for request_id derivation)';
            } else if(data['ROOT_ACTION_INDEX'] === undefined || data['ROOT_ACTION_INDEX'] === null){
                // The per-root discriminator (deterministic root on-chain action_index). Required
                // for every legitimate VM emission; check === undefined/null (0 is a valid index).
                error = 'invalid: ROOT_ACTION_INDEX (required for request_id derivation)';
            } else if(!data['TX_HASH']){
                error = 'invalid: TX_HASH (required for request_id derivation)';
            } else {
                let preimage = String(data['TX_HASH']) + ':' + String(data['ROOT_ACTION_INDEX']) + ':' + String(data['EMITTER_PATH']) + ':' + String(data['CONTRACT_INDEX']) + ':' + String(data['EMITTER_POSITION']);
                let expected = crypto.createHash('sha256').update(preimage).digest('hex');
                if(expected !== String(data['REQUEST_ID']).toLowerCase())
                    error = 'invalid: REQUEST_ID (does not match deterministic derivation)';
            }
        }

        // GAS_ESCROW is not yet deducted from the fee-payer's balance at request time;
        // the fee-funding check below validates the payer holds the amount, and
        // REQUEST_STATUS is assigned once `error` is final so structural failures
        // do not enter the 'pending' pool (see the assignment after the fee-funding check).
        data['GAS_ESCROW']     = '0';
        data['FEE_PAYER']      = data['FEE_PAYER'] || data['SOURCE']; // execute.processEmission carries FEE_PAYER

        // Fee escrow funding check: FEE_PAYER (the EXECUTE caller) must hold the
        // fee. Read at (BLOCK_INDEX, ACTION_INDEX) so accept/reject is identical
        // across all validators (same determinism rule as COLLECT's pool check).
        if(!error && feePresent){
            let tokenInfo = await this.indexerDb.getTokenInfo(this.config['GAS'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let balances  = await this.indexerDb.getAddressBalances(data['FEE_PAYER'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(!tokenInfo || !this.util.hasBalance(balances, tokenInfo['TICK_ID'], data['FEE_AMOUNT']))
                error = 'invalid: insufficient funds (FEE_AMOUNT)';
        }

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Terminal request-lifecycle status. A structurally invalid request is
        // recorded as 'rejected' (preserving the audit row) but NEVER enters the
        // 'pending' pool: the hub poll (getPendingAttestationRequests), the
        // deadline-expiry sweep (getExpiredAttestationRequests), and the v1
        // response path all key solely off request_status='pending', so a
        // 'rejected' row is invisible to every one of them. Without this branch a
        // protocol-rejected request (oversize payload, unknown provider, bad
        // deadline, insufficient fee funds, …) would be fetched, quorum-signed,
        // and fire a real callback EXECUTE exactly as if it had passed validation.
        // 'rejected' is terminal at creation (resolved_block stays NULL), so the
        // reorg-rollback reset, which only re-pends rows that went terminal via a
        // later block's flip (request_status IN ('fulfilled','errored','expired')
        // AND resolved_block >= reorg point), never promotes it back to pending.
        data['REQUEST_STATUS'] = (error) ? 'rejected' : 'pending';

        console.log("\t ATTEST v0 : id=" + (data['REQUEST_ID'] ? String(data['REQUEST_ID']).substring(0,16) + '...' : '?') +
                    ' : provider=' + data['PROVIDER_ID'] +
                    ' : contract=' + data['CONTRACT_INDEX'] +
                    ' : redundancy=' + data['REDUNDANCY'] +
                    ' : fee=' + (feePresent ? data['FEE_AMOUNT'] + ' ' + data['FEE_TICK'] : 'none') +
                    ' : ' + data['STATUS']);

        // ATT-RECOMP-1: pin the responsible set AS-OF this request's block so the reorg
        // missed_count recompute (rollback._recomputeAttestationValidatorStats) reads the
        // historical set verbatim rather than re-deriving it against the CURRENT mutable
        // stakes.amount (a later SURVIVING slash reduces it, so a bare re-derive charges
        // missed_count to the wrong set). Only a 'pending' request can ever expire and reach
        // the recompute; a 'rejected' row is invisible to the expiry sweep, so skip the stake
        // query for it. Uses the SAME _computeResponsibleSet the v1 verify + v2 expiry paths
        // use, evaluated at the request's own block_index (the set the recompute keys on).
        if(data['REQUEST_STATUS'] === 'pending'){
            let responsibleSet = await this._computeResponsibleSet(
                String(data['REQUEST_ID'] || '').toLowerCase(), data['REDUNDANCY'], data['BLOCK_INDEX']);
            data['RESPONSIBLE_SET_JSON'] = JSON.stringify(responsibleSet);
        }

        await this.indexerDb.createAttestationRequest(data);

        // Escrow the fee from FEE_PAYER (debit + escrow at this v0 action_index;
        // released to the REWARD pool on fulfillment, refunded on expiry/error).
        // Rollback safety is the generic path: escrows/debits delete by
        // action_index, and the request row resets via resolved_block.
        if(status === 'valid' && feePresent){
            let gas = this.config['GAS'];
            this.util.addAddressTicker(data['FEE_PAYER'], gas);
            let debits  = [[gas, data['FEE_AMOUNT'], data['FEE_PAYER']]];
            let escrows = [[gas, data['FEE_AMOUNT'], data['FEE_PAYER']]];
            await this.util.processTransactionLedgerChanges(this.indexerDb, data, [], debits, escrows);
            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());
            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);
        }

        await this.mapper.createMappings(data);
    }

    // ATTEST v1: Response (validator broadcast)
    async _parseResponse(params, data, error){

        // Extract fixed-position fields. RESPONSE_PAYLOAD travels as base64
        // (binary-safe, no embedded `|` chars). We decode to bytes for
        // signature verification (must hash the same bytes the hub signed)
        // and to UTF-8 text for storage + callback delivery.
        let requestId          = params[1];
        let providerId         = params[2];
        let responsePayloadB64 = String(params[3] || '');
        let responseBodyBytes;
        try { responseBodyBytes = Buffer.from(responsePayloadB64, 'base64'); }
        catch(_)            { responseBodyBytes = Buffer.alloc(0); }
        let responsePayload    = responseBodyBytes.toString('utf8');
        let responseStatus     = params[4];
        let meta               = params[5];

        if(!error && (!requestId || !/^[0-9a-fA-F]{64}$/.test(String(requestId))))
            error = 'invalid: REQUEST_ID (format)';
        if(!error && this.util.isNull(providerId))
            error = 'invalid: PROVIDER_ID (required)';
        let allowedStatuses = ['ok', 'timeout', 'no_quorum', 'provider_error', 'expired'];
        if(!error && allowedStatuses.indexOf(String(responseStatus)) === -1)
            error = 'invalid: STATUS (unknown)';

        // Parse variable-length sig list
        let sigCount, sigs = [];
        if(!error){
            try {
                sigCount = parseInt(params[6]);
                if(!Number.isFinite(sigCount) || sigCount < 1)
                    throw new Error('invalid SIG_COUNT');
                for(let i = 0; i < sigCount; i++){
                    let pubkey = params[7 + 2 * i];
                    let sig    = params[7 + 2 * i + 1];
                    if(!pubkey || !sig) throw new Error('missing sig data at index ' + i);
                    if(!/^[0-9a-fA-F]{64}$/.test(pubkey))  throw new Error('invalid pubkey format at index ' + i);
                    if(!/^[0-9a-fA-F]{128}$/.test(sig))    throw new Error('invalid sig format at index ' + i);
                    sigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
                }
            } catch(e){
                if(!error) error = 'invalid: ' + e.message;
            }
        }

        // Look up the original request
        let request = null;
        if(!error){
            request = await this.indexerDb.getAttestationRequestById(String(requestId).toLowerCase());
            if(!request){
                error = 'invalid: REQUEST_ID (no matching request)';
            } else if(request.request_status !== 'pending'){
                error = 'invalid: REQUEST already ' + request.request_status;
            } else if(request.provider_id !== String(providerId)){
                error = 'invalid: PROVIDER_ID does not match request';
            } else if(parseInt(data['BLOCK_INDEX']) > parseInt(request.deadline_block)){
                error = 'invalid: REQUEST expired (deadline_block=' + request.deadline_block + ')';
            }
        }

        // The responsible-set capability snapshot is locked at the REQUEST's block (also
        // the EQUIV gate input (deterministic from request_id; byte-matches the hub).
        let snapshotBlock = request ? Number(request.block_index) : Number(data['BLOCK_INDEX']);

        // Build canonical signing message (UTF-8 Buffer). At/above the EQUIV flag-day
        // (WI-2 bump 2) the raw string is wrapped in the uniform header (TAG=XATTEST,
        // ROUND_ID=request_id, VIEW=0, no view change), gated on the request's block +
        // network; below it, the bare bytes. Byte-matches AttestationConsensus._buildCanonical.
        let responseHash = crypto.createHash('sha256').update(responseBodyBytes).digest('hex');
        let canonRaw     = String(requestId) + String(providerId) + responseHash + String(responseStatus) + String(meta || '');
        if(eq.isEquivHeaderActive(snapshotBlock, this.config['NETWORK']))
            canonRaw = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, requestId, 0, canonRaw);
        let canonical    = Buffer.from(canonRaw, 'utf8');
        let validSigs    = 0;
        let verifiedSigs = [];
        if(!error){
            let seenPubkey = new Set();
            for(let s of sigs){
                if(seenPubkey.has(s.pubkey)) continue;
                seenPubkey.add(s.pubkey);
                if(!await this.indexerDb.hasCapability(s.pubkey, 'attestation', snapshotBlock))
                    continue;
                if(!ed25519.verify(canonical, s.sig, s.pubkey))
                    continue;
                verifiedSigs.push(s);
            }

            // Restrict the verified signers to the request's deterministic
            // responsible set (the top-REDUNDANCY validators ranked by
            // SHA256(request_id || pubkey), the same set _parseExpire charges
            // missed_count to. Holding the attestation capability and producing a
            // valid ed25519 signature is necessary but NOT sufficient: without
            // this gate any quorum of capable validators could assemble a valid
            // v1, so two different capable coalitions could each land a response
            // (first-lands-wins, non-deterministic) and fulfilled_count (credited
            // to whoever signed) would diverge from missed_count (charged to the
            // hash-selected set on expiry). Filtering here makes fulfillment
            // deterministic and keeps the two stat columns symmetric. (request is
            // guaranteed non-null inside this !error block; a null lookup sets
            // 'no matching request' above and skips the loop.)
            let responsible = new Set(await this._computeResponsibleSet(
                String(requestId).toLowerCase(), request.redundancy, snapshotBlock
            ));
            verifiedSigs = verifiedSigs.filter(s => responsible.has(s.pubkey));
            validSigs    = verifiedSigs.length;

            // Quorum: only REDUNDANCY validators are responsible for fetching (spec §8.2)
            let redundancy = request ? Number(request.redundancy) : 0;
            if(validSigs < redundancy)
                error = 'invalid: insufficient valid signatures (' + validSigs + '/' + redundancy + ')';
        }

        // Stash for DB write
        data['REQUEST_ID']       = String(requestId).toLowerCase();
        data['PROVIDER_ID']      = providerId;
        data['RESPONSE_PAYLOAD'] = responsePayload;
        data['RESPONSE_STATUS']  = responseStatus;
        data['META']             = meta;
        data['RESPONSE_HASH']    = responseHash;
        data['VALID_SIGS']       = validSigs;

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Inline the verified federation signatures as a JSON array on the response
        // row (consolidated `attests` table, no separate signatures table). Only
        // persisted for a valid response, mirroring the prior per-row behavior.
        data['VALIDATOR_SIGNATURES'] = (status === 'valid' && verifiedSigs.length)
            ? JSON.stringify(verifiedSigs.map(s => ({ pubkey: s.pubkey, sig: s.sig })))
            : null;

        console.log("\t ATTEST v1 : id=" + String(requestId).substring(0,16) + '...' +
                    ' : status=' + responseStatus +
                    ' : sigs=' + validSigs + '/' + (request ? request.redundancy : '?') +
                    ' : ' + data['STATUS']);

        // Persist response row (with verified sigs inlined as JSON)
        await this.indexerDb.createAttestationResponse(data);

        if(status === 'valid'){
            // Bump fulfilled_count for each signing validator (only on STATUS=='ok')
            if(String(responseStatus) === 'ok'){
                for(let s of verifiedSigs){
                    await this.indexerDb.incrementAttestationValidatorStat(
                        s.pubkey, String(providerId), 'fulfilled_count', data['BLOCK_INDEX']
                    );
                }
            }

            // Retryable response statuses leave the request OPEN. no_quorum means
            // the responsible set could not agree this round; timeout / provider_error
            // mean a fetch failed transiently. In all three cases another round may
            // still succeed before the deadline, so the request stays `pending`; the
            // deadline-expiry handler flips it to `expired` if no quorum is ever
            // reached. Only `ok` (fulfilled) or a genuinely terminal failure closes the
            // request and fires the callback. (allowedStatuses, see above, is
            // ['ok','timeout','no_quorum','provider_error','expired']; an explicit
            // `expired` response is terminal and maps to `errored`.)
            const RETRYABLE_STATUSES = new Set(['no_quorum', 'timeout', 'provider_error']);
            if(RETRYABLE_STATUSES.has(String(responseStatus))){
                console.log("\t ATTEST v1 : id=" + String(requestId).substring(0,16) + '...' +
                            ' : retryable status=' + responseStatus + ', request left pending for retry');
            } else {
                // Flip request status to its terminal value (resolved_block anchors
                // the flip for the reorg-rollback reset)
                let newRequestStatus = (responseStatus === 'ok') ? 'fulfilled' : 'errored';
                await this.indexerDb.updateAttestationRequestStatus(data['REQUEST_ID'], newRequestStatus, data['BLOCK_INDEX']);

                // Fee disposition (E1). Release/refund rows are written at THIS
                // v1 action_index, so a reorg of the v1 removes them generically
                // and the v0 escrow (earlier action_index) survives intact.
                await this._settleRequestFee(request, data, newRequestStatus);

                // Inject the callback EXECUTE. Wrapped in a savepoint so a failing callback
                // does NOT roll back the response row.
                try {
                    let callbackActionIndex = await this._injectCallbackExecute(request, data);
                    if(callbackActionIndex)
                        await this.indexerDb.setAttestationResponseCallbackIndex(data['ACTION_INDEX'], callbackActionIndex);
                } catch(e){
                    console.warn('Attestation callback injection failed:', e);
                }
            }
        }

        await this.mapper.createMappings(data);
    }

    // ATTEST v2: Expire (system-synthesized)
    async _parseExpire(params, data, error){

        // System-synthesized only. The decoder accepts ATTEST in VALID_ACTION_NAMES but the
        // user-broadcast path can't legitimately produce v2; guard against accidental
        // synthesis from a user transaction.
        if(!data['IS_SYNTHETIC']){
            console.warn('\t ATTEST v2 : rejected (user-broadcast not allowed for synthetic expire)');
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

        console.log("\t ATTEST v2 : id=" + requestId.substring(0,16) + '...' +
                    ' : deadline=' + request.deadline_block +
                    ' : block=' + data['BLOCK_INDEX']);

        // Flip request status to 'expired' (resolved_block anchors the flip for the
        // reorg-rollback reset; without it a reorged expiry stayed terminal and
        // replay skipped re-synthesizing the v2 row)
        await this.indexerDb.updateAttestationRequestStatus(requestId, 'expired', data['BLOCK_INDEX']);

        // Refund the request fee (E1); never reached the responsible set's quorum.
        await this._settleRequestFee(request, data, 'expired');

        // Mark missed_count on each responsible validator (deterministic by SHA256(request_id || pubkey))
        try {
            let responsible = await this._computeResponsibleSet(
                requestId, request.redundancy, Number(request.block_index)
            );
            for(let pk of responsible){
                await this.indexerDb.incrementAttestationValidatorStat(
                    pk, String(request.provider_id), 'missed_count', data['BLOCK_INDEX']
                );
            }
        } catch(e){
            console.warn('Attestation expire: missed_count update failed:', e);
        }

        // Synthesize the callback EXECUTE so the contract can clean up (status='expired')
        try {
            await this._injectExpiredCallback(request, data);
        } catch(e){
            console.warn('Attestation expiry callback failed:', e);
        }

        await this.mapper.createMappings(data);
    }

    // Compute the responsible validator set for a given request (same deterministic rule
    // the hub uses (xchain-hub AttestationRound): sort capability validators by
    // SHA256(request_id || pubkey), take top REDUNDANCY.
    // STAKE_WEIGHTED_QUORUM: at/above activation, dedupe the selection by staking
    // source (one slot per source, keep each source's lowest-hash key) using the
    // source-keyed set; below activation, the legacy per-key selection. The
    // within-subset quorum stays count-based. CONSENSUS-CRITICAL: must match the
    // hub's AttestationRound._computeResponsibleSet byte-for-byte or validation forks.
    async _computeResponsibleSet(requestId, redundancy, blockIndex){
        let weighted = swq.isStakeWeightedQuorumActive(blockIndex, this.config['NETWORK']);
        let validators = weighted
            ? await this.indexerDb.getStakeWeightsByCapability('attestation', blockIndex)
            : await this.indexerDb.getValidatorsByCapability('attestation', blockIndex);
        if(!validators || validators.length === 0) return [];
        let withHash = validators.map(v => {
            let pk = String(v.pubkey).toLowerCase();
            let h  = crypto.createHash('sha256').update(String(requestId), 'utf8').update(pk, 'utf8').digest('hex');
            return { pubkey: pk, source: (v.source != null ? String(v.source) : null), hash: h };
        });
        withHash.sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
        if(weighted){
            let seen = new Set();
            withHash = withHash.filter(v => {
                if(v.source === null) return true;
                if(seen.has(v.source)) return false;
                seen.add(v.source);
                return true;
            });
        }
        return withHash.slice(0, Math.max(1, Number(redundancy) || 1)).map(v => v.pubkey);
    }

    // Settle the request fee escrowed at v0 (E1 paid attestations). Runs at the
    // terminal flip and writes ledger rows at the SETTLING action's action_index
    // (the v1 response or the synthesized v2 expire), so a reorg of the settle
    // action removes them generically while the v0 escrow row survives.
    //   'fulfilled'          → escrow → REWARD pool + equal validator_rewards
    //                          split across the responsible set (floor to GAS
    //                          decimals; remainder dust stays in the pool;
    //                          COLLECT only ever pays what validator_rewards
    //                          reference, so the pool stays solvent).
    //   'errored'/'expired'  → escrow → refund to FEE_PAYER.
    // Feeless requests (fee_amount NULL/0) are a no-op.
    async _settleRequestFee(request, data, terminalStatus){
        let feeAmount = String((request && request.fee_amount) || '0');
        if(!this.util.bcgt(feeAmount, '0')) return;

        let gas      = this.config['GAS'];
        let feePayer = String(request.fee_payer || '');
        if(!feePayer){
            console.warn('Attestation fee settle: missing fee_payer for request ' + String(request.request_id).substring(0,16) + '..., fee left in escrow');
            return;
        }

        // Release the escrow held against FEE_PAYER (negative escrow row, the
        // order_expire idiom) and route the funds per the terminal status.
        let escrows = [[gas, this.util.bcmul(feeAmount, '-1', 8), feePayer]];
        let credits = [];
        this.util.addAddressTicker(feePayer, gas);

        if(terminalStatus === 'fulfilled'){
            let rewardPool = this.config['ADDRESS']['REWARD'];
            this.util.addAddressTicker(rewardPool, gas);
            credits.push([gas, feeAmount, rewardPool]);

            let responsible = await this._computeResponsibleSet(
                String(request.request_id), request.redundancy, Number(request.block_index)
            );
            if(responsible.length > 0){
                // Equal split, floored to GAS decimals (feeCap = min(8, gasDecimals)),
                // matching the precision cap applied at parse time (line 146). Deterministic
                // across validators (bcmulfloor exists for exactly this concern).
                let gasDecimals = await this.indexerDb.getTokenDecimalPrecision(
                    await this.indexerDb.getTickerId(gas)
                );
                let feeCap = Math.min(8, gasDecimals);
                let perValidator = this.util.bcmulfloor(
                    this.util.bcdiv(feeAmount, String(responsible.length), 18), '1', feeCap
                );
                if(this.util.bcgt(perValidator, '0')){
                    for(let pk of responsible){
                        // round_reference is BIGINT; key idempotency on the
                        // REQUEST's action_index (unique per request), not the
                        // 64-hex request_id.
                        await this.indexerDb.createValidatorReward(
                            pk, Number(request.action_index), 'attest_fee', perValidator, data['BLOCK_INDEX'], true
                        );
                    }
                }
            }
            console.log("\t ATTEST fee : " + feeAmount + ' ' + gas + ' → REWARD pool, split ' +
                        responsible.length + ' way(s) [request ' + String(request.request_id).substring(0,16) + '...]');
        } else {
            // errored / expired: service not rendered, refund the payer
            credits.push([gas, feeAmount, feePayer]);
            console.log("\t ATTEST fee : " + feeAmount + ' ' + gas + ' refunded to FEE_PAYER (' + terminalStatus + ')' +
                        ' [request ' + String(request.request_id).substring(0,16) + '...]');
        }

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, [], escrows);
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);
    }

    // Synthesize an EXECUTE that runs the contract's callback method (v1 response path).
    async _injectCallbackExecute(request, responseData){
        if(!this.actions.actionExecute) return null;

        let callbackParams = [];
        if(request.callback_params_json){
            try {
                let parsed = JSON.parse(request.callback_params_json);
                if(Array.isArray(parsed)) callbackParams = parsed;
            } catch(e){
                console.warn('_injectCallbackExecute: malformed callback_params_json for request ' +
                             String(request.request_id).substring(0,16) + '..., using empty params:', e.message);
                callbackParams = [];
            }
        }

        // Callback signature: [request_id, provider_id, status, response_payload, ...originalCallbackParams]
        let callbackArgs = [
            request.request_id,
            request.provider_id,
            responseData['RESPONSE_STATUS'],
            responseData['RESPONSE_PAYLOAD'] || '',
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
            BLOCK_INDEX: responseData['BLOCK_INDEX'],
            TX_INDEX:    responseData['TX_INDEX'],
            TX_VOUT:     responseData['TX_VOUT'],
            FORMAT:      0,
            SOURCE:      'C:' + chain + ':' + request.contract_index
        }, true);

        // SOURCE = contract address so xchain.getSourceAddress() === xchain.getContractAddress() (spec §4.3)
        let emissionData = {
            ACTION_INDEX:  emissionActionIndex,
            SOURCE:        'C:' + chain + ':' + request.contract_index,
            FEE_PAYER:     'C:' + chain + ':' + request.contract_index,
            BLOCK_INDEX:   responseData['BLOCK_INDEX'],
            BLOCK_TIME:    responseData['BLOCK_TIME'],
            TX_INDEX:      responseData['TX_INDEX'],
            TX_HASH:       responseData['TX_HASH'],
            TX_VOUT:       responseData['TX_VOUT'],
            FORMAT:        0,
            IS_EMISSION:   true,
            EMITTER:       responseData['ACTION_INDEX']
        };

        let savepoint = await this.indexerDb.createSavepoint('attestation_callback');
        try {
            await this.actions.actionExecute.parse(actionParams, emissionData, null);
            if(emissionData['STATUS'] && emissionData['STATUS'] !== 'valid'){
                console.warn('Attestation callback execute returned non-valid status: ' + emissionData['STATUS']);
            }
            await this.indexerDb.releaseSavepoint(savepoint);
            return emissionActionIndex;
        } catch(e){
            await this.indexerDb.rollbackToSavepoint(savepoint);
            throw e;
        }
    }

    // Synthesize an EXECUTE that invokes the callback method with status='expired' and empty response payload.
    async _injectExpiredCallback(request, expireData){
        if(!this.actions.actionExecute) return null;

        let callbackParams = [];
        if(request.callback_params_json){
            try {
                let parsed = JSON.parse(request.callback_params_json);
                if(Array.isArray(parsed)) callbackParams = parsed;
            } catch(_) {
                callbackParams = [];
            }
        }

        let callbackArgs = [
            request.request_id,
            request.provider_id,
            'expired',
            '',
            ...callbackParams.map(String)
        ];

        let actionParams = [
            0,
            request.contract_index,
            request.callback_method,
            ...callbackArgs
        ];

        let chain = this.config['CHAIN'];
        let emissionActionIndex = await this.indexerDb.createActionIndex({
            ACTION:      'EXECUTE',
            BLOCK_INDEX: expireData['BLOCK_INDEX'],
            FORMAT:      0,
            SOURCE:      'C:' + chain + ':' + request.contract_index
        }, true);

        let emissionData = {
            ACTION_INDEX: emissionActionIndex,
            SOURCE:       'C:' + chain + ':' + request.contract_index,
            FEE_PAYER:    'C:' + chain + ':' + request.contract_index,
            BLOCK_INDEX:  expireData['BLOCK_INDEX'],
            BLOCK_TIME:   expireData['BLOCK_TIME'],
            FORMAT:       0,
            IS_EMISSION:  true,
            EMITTER:      expireData['ACTION_INDEX']
        };

        let savepoint = await this.indexerDb.createSavepoint('attestation_expire_callback');
        try {
            await this.actions.actionExecute.parse(actionParams, emissionData, null);
            if(emissionData['STATUS'] && emissionData['STATUS'] !== 'valid'){
                console.warn('Attestation expiry callback returned non-valid status: ' + emissionData['STATUS']);
            }
            await this.indexerDb.releaseSavepoint(savepoint);
            return emissionActionIndex;
        } catch(e){
            await this.indexerDb.rollbackToSavepoint(savepoint);
            throw e;
        }
    }
}

module.exports = Attest;
