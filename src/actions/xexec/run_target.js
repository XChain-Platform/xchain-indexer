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
 * XChain Platform Action - XEXEC : target run
 *
 * Runs the target contract method inside its own savepoint and turns the
 * outcome into the relayed result tuple. Called with the XEXEC handler as
 * `this` (see ../xexec.js).
 *
 ********************************************************************/

'use strict';

const { rethrowIfInfraFault } = require('../../consensus/fault_guard.js');
const { getLogger } = require('../../observability/index.js');

// The return-payload cap ../xexec.js documents (payload_too_large, empty payload), read
// from the same vendored source rather than a second literal.
const XCALL_MAX_RETURN_BYTES = require('../../protocol/constants.js').XCALL_MAX_RETURN_BYTES;

// Run the target method inside its own savepoint and turn the outcome into the
// relayed result tuple. Every exit leaves the savepoint resolved (released on
// success, rolled back on a failed or throwing run), which is what lets the
// caller record a failure result outside it.
async function runTargetExecution(c, actionParams, executionData, executeActionIndex){
    let resultStatus = 'error';
    let returnPayloadB64 = '';
    let gasUsed = 0;

    let savepoint = await this.indexerDb.createSavepoint('xexec_' + executeActionIndex);
    try {
        await this.actions.actionExecute.parse(actionParams, executionData, null);
        let status = String(executionData['STATUS'] || 'error');
        gasUsed = Number(executionData['VM_GAS_BILLED']) || 0;

        if(status === 'valid'){
            resultStatus = 'ok';
            let rv = executionData['VM_RETURN_VALUE'];
            if(rv != null){
                let bytes = Buffer.from(String(rv), 'utf8');
                if(bytes.length > XCALL_MAX_RETURN_BYTES){
                    // Deterministic truncation rule: oversize returns become a
                    // distinct failure status with an EMPTY payload (never a
                    // truncated one, since partial JSON would be a foot-gun). The
                    // state changes stand (the contract ran fine); only the
                    // return payload is suppressed.
                    resultStatus = 'payload_too_large';
                } else {
                    returnPayloadB64 = bytes.toString('base64');
                }
            }
            await this.indexerDb.releaseSavepoint(savepoint);
        } else {
            // The run failed: roll back any partial effects; the failure is the result.
            await this.indexerDb.rollbackToSavepoint(savepoint);
            resultStatus = this.mapFailureStatus(status, executionData['VM_ERROR_MESSAGE']);
        }
    } catch(e){
        await this.indexerDb.rollbackToSavepoint(savepoint);
        // An infrastructure fault (VM host fault, transient DB error) is not a
        // cross-chain call result: halt so the block rolls back and retries rather
        // than relaying a validator-local 'error' verdict (persisted below, outside
        // the savepoint) that permanently fences the money-bearing call from retry.
        // Deterministic VM failures never reach here; they are handled at the sibling
        // branch above via mapFailureStatus.
        rethrowIfInfraFault(e);
        resultStatus = 'error';
        getLogger().warn("\t XEXEC : call=" + String(c.call_id).substring(0,16) + '... : execution threw: ' + (e && e.message));
    }
    return { resultStatus, returnPayloadB64, gasUsed };
}

module.exports = { runTargetExecution };
