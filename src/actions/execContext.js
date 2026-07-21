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
 * Shared builder for system-injected EXECUTE contexts .
 *
 * Four injector sites synthesize an EXECUTE that runs a contract callback
 * (attest.js response + expiry callbacks, vote.js poll-finalize callback,
 * xcall.js result callback). Each used to hand-roll the identity tuple, and
 * two of them omitted TX_HASH: a contract that emitted ATTEST/XCALL from
 * inside such a callback got a request_id from the VM (which tolerates a
 * missing txHash), was charged gas, and then had the emission hard-rejected
 * by the indexer's TX_HASH check, stranding the contract on an id that never
 * resolves. This module is the single place the tuple is built, so a fifth
 * site cannot regress the class; execute.js additionally hard-asserts (post
 * flag-day) that every injected context carries a TX_HASH.
 *
 * Synthetic TX_HASH derivation is consensus: sha256 of the colon-delimited
 * preimage `TAG:NETWORK:CHAIN:UNIQUE_ID`, byte-identical to the original
 * inline xcall.js 'XCALLCB' synthesis it generalizes. The hash namespaces
 * everything the callback itself emits (ATTEST request_ids, XCALL call_ids,
 * emit.execute subtrees) collision-free per trigger.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

// protocol_changes.js gate: below the activation the two historically-broken
// sites keep omitting TX_HASH (legacy behavior, so a from-genesis mainnet
// replay stays byte-identical); at/above it every injected context carries a
// real or synthesized TX_HASH and execute.js hard-asserts the invariant.
const SYNTH_EXEC_TX_HASH = 'SYNTH_EXEC_TX_HASH';

// Per-site synthesis tags. One tag per injector, so ids derived inside a
// callback can never collide across trigger kinds even for equal unique ids.
// 'XCALLCB' predates this module and MUST stay byte-identical (live consensus).
const SYNTH_TAGS = {
    ATTEST_EXPIRE_CALLBACK: 'ATTESTEXPCB',
    VOTE_CALLBACK:          'VOTECB',
    XCALL_CALLBACK:         'XCALLCB',
};

/**
 * Deterministic synthetic TX_HASH for an injected execution with no real
 * on-chain transaction behind it.
 *
 * @param {string} tag      one of SYNTH_TAGS (site namespace)
 * @param {string} network  config NETWORK (mainnet/testnet/regtest)
 * @param {string} chain    config CHAIN (BTC/LTC/DOGE)
 * @param {string} uniqueId per-trigger unique id (request_id, call_id, poll action_index)
 * @returns {string} 64-hex sha256
 */
function synthesizeTxHash(tag, network, chain, uniqueId){
    return crypto.createHash('sha256')
        .update(String(tag) + ':' + String(network) + ':' + String(chain) + ':' + String(uniqueId))
        .digest('hex');
}

/**
 * Build the emissionData/executionData context for a system-injected callback
 * EXECUTE. Every injector site MUST build its context here.
 *
 * @param {object} opts
 * @param {string} opts.chain          config CHAIN
 * @param {string} [opts.network]      config NETWORK (required when synthesizing)
 * @param {number|string} opts.contractIndex  target contract action_index (SOURCE/FEE_PAYER = contract address)
 * @param {number} opts.actionIndex    pre-created action index for the injected EXECUTE
 * @param {number} opts.blockIndex     injecting block
 * @param {number} [opts.blockTime]    injecting block time
 * @param {number} opts.emitter        EMITTER action_index (the triggering action)
 * @param {string} [opts.txHash]       real TX_HASH when the trigger rode an on-chain tx
 * @param {string} [opts.synthTag]     SYNTH_TAGS entry for synthesis when no real hash exists
 * @param {string|number} [opts.synthId] per-trigger unique id for synthesis
 * @param {boolean} [opts.includeTxHash=true] false reproduces the pre-flag-day
 *        legacy context (no TX_HASH key); callers gate this on SYNTH_EXEC_TX_HASH
 * @param {object} [opts.extra]        site-specific fields merged verbatim
 *        (TX_INDEX/TX_VOUT, CALL_DEPTH, VM_GAS_LIMIT, CROSS_HOPS, ...)
 * @returns {object} the context object to pass to actionExecute.parse
 */
function buildInjectedExecContext(opts){
    const o = opts || {};
    for(const key of ['chain', 'contractIndex', 'actionIndex', 'blockIndex', 'emitter']){
        if(o[key] === undefined || o[key] === null)
            throw new Error('buildInjectedExecContext: missing required field ' + key);
    }

    const includeTxHash = (o.includeTxHash === undefined) ? true : Boolean(o.includeTxHash);
    let txHash = null;
    if(includeTxHash){
        if(o.txHash){
            txHash = o.txHash;
        } else if(o.synthTag && o.network && o.synthId !== undefined && o.synthId !== null && o.synthId !== ''){
            txHash = synthesizeTxHash(o.synthTag, o.network, o.chain, o.synthId);
        } else {
            // Fail loudly at the injector, not three layers down when the
            // callback's own emission is hard-rejected for a missing TX_HASH.
            throw new Error('buildInjectedExecContext: TX_HASH required but neither txHash nor (synthTag+network+synthId) provided');
        }
    }

    const source = 'C:' + o.chain + ':' + o.contractIndex;
    const context = {
        ACTION_INDEX: o.actionIndex,
        SOURCE:       source,
        FEE_PAYER:    source,
        BLOCK_INDEX:  o.blockIndex,
        BLOCK_TIME:   o.blockTime,
        FORMAT:       0,
        IS_EMISSION:  true,
        EMITTER:      o.emitter,
        ...(o.extra || {}),
    };
    if(txHash) context.TX_HASH = txHash;
    return context;
}

module.exports = { buildInjectedExecContext, synthesizeTxHash, SYNTH_EXEC_TX_HASH, SYNTH_TAGS };
