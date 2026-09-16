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
 * XCALL v0: the Request phase (VM emission only).
 *
 * The field checks and the emitter-contract lookup of the request phase, one
 * function per check group; the call_id re-derivation is the handler's own
 * deriveCallId (index.js). They run in a fixed order and each returns the
 * running `error`, which is what keeps the FIRST failing check the one that
 * names the status: a phase that returned a verdict of its own would let a
 * later check overwrite an earlier rejection and change what a validator
 * records for the same transaction.
 *
 * Called with the handler as `this` (index.js delegates with .call), so the
 * body reads this.util, this.config, this.indexerDb, this.mapper and the
 * handler's own deriveCallId (which re-derives call_id through the handler's
 * callIdPreimageValues) exactly as it did in place.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability/index.js');
// The same vendored protocol constants the entry reads (byte-identical to
// xchain-documentation/protocol/constants.js). Read here rather than passed in
// from the entry, so the bounds this phase enforces and the bounds the entry
// exports cannot drift apart through a forgotten argument.
const PROTO = require('../../protocol/constants.js');

const ALLOWED_CHAINS = ['BTC', 'LTC', 'DOGE'];

// Extract positional params
function readRequestFields(params, data){
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
}

// Where the call is going and what it runs there.
function validateCallTarget(data, error){
    // Verify CALL_ID is present and is a 64-character hex hash
    if(!error && (!data['CALL_ID'] || !/^[0-9a-fA-F]{64}$/.test(String(data['CALL_ID']))))
        error = 'invalid: CALL_ID (format)';

    // Verify TARGET_CHAIN is one of the chains this platform can call out to
    if(!error && (ALLOWED_CHAINS.indexOf(String(data['TARGET_CHAIN'])) === -1))
        error = 'invalid: TARGET_CHAIN (unknown)';

    // Verify TARGET_CHAIN is not this chain (a same-chain call is a plain contract call, not XCALL)
    if(!error && String(data['TARGET_CHAIN']) === String(this.config['COIN']))
        error = 'invalid: TARGET_CHAIN (must differ from this chain)';

    let targetContract = parseInt(data['TARGET_CONTRACT_INDEX']);
    // Verify TARGET_CONTRACT_INDEX names a contract (contract indexes are positive whole numbers)
    if(!error && (!Number.isInteger(targetContract) || targetContract <= 0))
        error = 'invalid: TARGET_CONTRACT_INDEX (must be a positive integer)';

    // Verify METHOD was supplied (the call needs a function name to run on the far side)
    if(!error && this.util.isNull(data['METHOD']))
        error = 'invalid: METHOD (required)';
    // Verify METHOD fits the 64-byte name limit
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
    return error;
}

// The budgets the call has to stay inside: gas, the callback it must come back
// through, the deadline and the hop count. DEADLINE_BLOCK is derived here
// whatever the verdict, because the row is written for invalid requests too.
function validateCallLimits(data, error){
    let gasLimit = parseInt(data['GAS_LIMIT']);
    // Verify GAS_LIMIT sits in the allowed range (the target chain runs the call fee-less, so its ceiling is capped)
    if(!error && (!Number.isInteger(gasLimit) || gasLimit < PROTO.XCALL_MIN_GAS || gasLimit > PROTO.XCALL_MAX_GAS))
        error = 'invalid: GAS_LIMIT (out of range [' + PROTO.XCALL_MIN_GAS + ', ' + PROTO.XCALL_MAX_GAS + '])';

    // Verify CALLBACK_METHOD was supplied (every outcome comes back to the caller as a callback)
    if(!error && this.util.isNull(data['CALLBACK_METHOD']))
        error = 'invalid: CALLBACK_METHOD (required)';
    // Verify CALLBACK_METHOD fits the 64-byte name limit
    if(!error && Buffer.byteLength(String(data['CALLBACK_METHOD']), 'utf8') > 64)
        error = 'invalid: CALLBACK_METHOD (too long)';

    let deadlineBlocks = parseInt(data['DEADLINE_BLOCKS']);
    // Verify DEADLINE_BLOCKS sits in the allowed range (it has to cover both chains' confirmation depths plus relay rounds)
    if(!error && (!Number.isInteger(deadlineBlocks) ||
                  deadlineBlocks < PROTO.XCALL_MIN_DEADLINE_BLOCKS || deadlineBlocks > PROTO.XCALL_MAX_DEADLINE_BLOCKS))
        error = 'invalid: DEADLINE_BLOCKS (out of range [' + PROTO.XCALL_MIN_DEADLINE_BLOCKS + ', ' + PROTO.XCALL_MAX_DEADLINE_BLOCKS + '])';
    data['DEADLINE_BLOCK'] = parseInt(data['BLOCK_INDEX']) + (Number.isFinite(deadlineBlocks) ? deadlineBlocks : 0);

    let crossHops = parseInt(data['CROSS_HOPS']);
    // Verify CROSS_HOPS is inside the hop budget (out and back only; a further hop needs a fresh user transaction)
    if(!error && (!Number.isInteger(crossHops) || crossHops < 1 || crossHops > PROTO.XCALL_MAX_HOPS))
        error = 'invalid: CROSS_HOPS (out of range [1, ' + PROTO.XCALL_MAX_HOPS + '])';
    return error;
}

// Validate contract_index references a real contract
async function validateEmitterContract(data, error){
    if(!error && data['CONTRACT_INDEX'] != null){
        let contract = await this.indexerDb.getContract(data['CONTRACT_INDEX']);
        if(!contract)
            error = 'invalid: CONTRACT_INDEX (unknown)';
    } else if(!error){
        error = 'invalid: CONTRACT_INDEX (missing emitter)';
    }
    return error;
}

// XCALL v0: Request (VM emission only)
async function parseRequest(params, data, error){

    // VM-emission-only: reject anything user-initiated.
    if(!error && !data['IS_EMISSION'])
        error = 'invalid: XCALL v0 must originate from VM emission';

    readRequestFields(params, data);

    // Put the numeric fields into their canonical number form before the checks below read them
    if(!error)
        data = this.util.setNumberFormats(data);

    error = validateCallTarget.call(this, data, error);
    error = validateCallLimits.call(this, data, error);
    error = await validateEmitterContract.call(this, data, error);
    error = this.deriveCallId(data, error);

    data['REQUEST_STATUS'] = 'pending';
    data['FEE_PAYER']      = data['FEE_PAYER'] || data['SOURCE'];

    let status = (error) ? error : 'valid';
    data['STATUS'] = status;

    getLogger().info("\t XCALL v0 : id=" + (data['CALL_ID'] ? String(data['CALL_ID']).substring(0,16) + '...' : '?') +
                ' : ' + this.config['COIN'] + ':' + data['CONTRACT_INDEX'] +
                ' → ' + data['TARGET_CHAIN'] + ':' + data['TARGET_CONTRACT_INDEX'] +
                ' . ' + data['METHOD'] +
                ' : gas=' + data['GAS_LIMIT'] + ' hops=' + data['CROSS_HOPS'] +
                ' : ' + data['STATUS']);

    await this.indexerDb.createCrossChainCallRequest(data);
    await this.mapper.createMappings(data);
}

module.exports = { parseRequest };
