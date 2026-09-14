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
 * XChain Platform Action - EXECUTE : emitted-action parameter mapping
 *
 * The emission params object a contract produced, rendered as the positional
 * wire params each handler parses, plus the action-name to handler-instance
 * map the router dispatches on.
 *
 * buildActionParams() below deliberately touches no instance state: the arity
 * guard (test/unit/emission_params.test.js) calls it off the prototype with a
 * null receiver, which is what lets it compare every emittable action's params
 * against that handler's formats[0] without constructing the whole loader.
 *
 * The four family functions return undefined for an action they do not own, so
 * the entry below can try each in turn and throw once, on nobody's behalf, for
 * an action no family maps.
 *
 ********************************************************************/

'use strict';

// Token lifecycle and the poll actions: what a contract emits to move, create
// or retire supply it controls.
function tokenEmissionParams(action, params){
    switch(action){
        case 'VOTE':
            // Contracts may emit v0 (create poll) and v1 (cast ballot) only; the
            // emit API (gateway-emit.js) is the choke point that forbids v2/v3.
            if(Number(params.version) === 1)
                // FORMAT: VERSION|POLL_REF|BALLOT|MEMO
                return [1, params.pollRef, params.ballot, params.memo || ''];
            // FORMAT: VERSION|TICK|END_BLOCK|OPTIONS|MAX_SELECTIONS|TALLY_MODE|WEIGHT_MODE|QUORUM|MIN_VOTERS|MIN_VOTE_BALANCE|DECIDE_THRESHOLD|QUESTION|DEPOSIT|CALLBACK_CONTRACT|CALLBACK_METHOD|CALLBACK_PARAMS|CALLBACK_ON|GAS_ESCROW
            return [0, params.tick, params.endBlock, params.options, params.maxSelections || '',
                    params.tallyMode || '', params.weightMode || '', params.quorum || '', params.minVoters || '',
                    params.minVoteBalance || '', params.decideThreshold || '', params.question || '', params.deposit || '',
                    params.callbackContract || '', params.callbackMethod || '', params.callbackParams || '',
                    params.callbackOn || '', params.gasEscrow || ''];
        case 'SEND':
            // FORMAT: VERSION|TICK|AMOUNT|DESTINATION|MEMO
            return [0, params.tick, params.quantity, params.destination, params.memo || ''];
        case 'DESTROY':
            // FORMAT: VERSION|TICK|AMOUNT|MEMO
            return [0, params.tick, params.quantity, params.memo || ''];
        case 'ISSUE':
            // FORMAT: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
            return [0, params.tick, params.maxSupply || '', params.maxMint || '', params.decimals || '',
                    params.description || '', params.mintSupply || '', params.transfer || '', params.transferSupply || '',
                    params.lockMaxSupply || '', params.lockMaxMint || '', params.lockDescription || '',
                    params.lockSleep || '', params.lockCallback || '', params.callbackBlock || '',
                    params.callbackTick || '', params.callbackAmount || '', params.allowList || '',
                    params.blockList || '', params.mintAddressMax || '', params.mintStartBlock || '',
                    params.mintStopBlock || '', params.lockMint || '', params.lockMintSupply || '', params.memo || ''];
        case 'MINT':
            // FORMAT: VERSION|TICK|AMOUNT|DESTINATION|MEMO
            return [0, params.tick, params.quantity, params.destination || '', params.memo || ''];
        default:
            return undefined;
    }
}

// Market actions: the two-legged trades and the distributions priced off a
// token's holders.
function marketEmissionParams(action, params){
    switch(action){
        case 'ORDER':
            // FORMAT: VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
            // GIVE_OWNERSHIP/GET_OWNERSHIP (token-ownership trading) default to 0 when empty.
            return [0, params.giveCoin || '', params.giveTick || '', params.giveAmount, params.giveOwnership || '',
                    params.getCoin || '', params.getTick || '', params.getAmount, params.getOwnership || '',
                    params.getAddress || '', params.expiration || '',
                    params.allowList || '', params.blockList || '', params.memo || ''];
        case 'DISPENSER':
            // FORMAT: VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
            // GIVE_OWNERSHIP defaults to 0; ORACLE_ADDRESS (PRICE v1 oracle) is optional.
            return [0, params.giveCoin || '', params.giveTick || '', params.giveAmount, params.giveOwnership || '', params.giveEscrow,
                    params.getCoin || '', params.getTick || '', params.getAmount,
                    params.getAddress || '', params.fiatCode || '', params.fiatAmount || '', params.oracleAddress || '',
                    params.expiration || '', params.allowList || '', params.blockList || '', params.memo || ''];
        case 'DIVIDEND':
            // FORMAT: VERSION|TICK|DIVIDEND_TICK|AMOUNT|MEMO
            return [0, params.tick, params.dividendTick, params.quantity, params.memo || ''];
        case 'AIRDROP':
            // FORMAT: VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO
            return [0, params.tick, params.quantity, params.listActionIndex, params.memo || ''];
        default:
            return undefined;
    }
}

// Content, payment and housekeeping actions: everything a contract emits that
// publishes or moves something other than its own token supply.
function contentEmissionParams(action, params){
    switch(action){
        case 'CALLBACK':
            // FORMAT: VERSION|TICK|MEMO
            return [0, params.tick, params.memo || ''];
        case 'FILE':
            // FORMAT: VERSION|NAME|TYPE|TITLE|MEMO|GATE_TICKER|ENCRYPTION_METHOD|KEY_HASH|GATE_MIN_AMOUNT|COMPRESSION
            // Trailing gated-file fields default to empty (public file); a contract may set
            // them to emit a token-gated FILE. GATE_MIN_AMOUNT is the ninth field:
            // emitted FILEs must carry it too, or a contract-emitted gated FILE would be
            // silently unconditional while the wire format says otherwise. The arity guard
            // in test/unit/emission-params-arity.test.js is what caught this.
            //
            // A later change added COMPRESSION as the tenth field, and it is PINNED EMPTY here,
            // not passed through from params. COMPRESSION describes rawData payload bytes,
            // and an emitted action has no rawData: the VM emission path carries an action
            // string only. Letting a contract assert COMPRESSION=1 over a payload that does
            // not exist would publish a permanently lying field (readers would degrade to
            // stored-form forever) for no reachable benefit. Empty also keeps the emitted
            // wire string byte-identical to what pre-Part-B contracts produce, since
            // trailing empties are stripped.
            return [0, params.name || '', params.type || '', params.title || '', params.memo || '',
                    params.gateTicker || '', params.encryptionMethod || '', params.keyHash || '',
                    params.gateMinAmount || '', ''];
        case 'LIST':
            // FORMAT: VERSION|TYPE|MEMO|ITEM
            // MEMO precedes the variadic ITEM tail (a trailing memo could not be
            // told apart from one more item), so it holds a slot even when empty.
            return [0, params.type || '', params.memo || '', params.item || ''];
        case 'COINPAY':
            // FORMAT: VERSION|ORDER_MATCH_ACTION_INDEX
            return [0, params.orderMatchActionIndex];
        case 'SWEEP':
            // FORMAT: VERSION|DESTINATION|BALANCES|OWNERSHIPS|ORDERS|SWAPS|DISPENSERS|MEMO
            return [0, params.destination, params.balances || '', params.ownerships || '', params.orders || '', params.swaps || '', params.dispensers || '', params.memo || ''];
        case 'LINK':
            // FORMAT: VERSION|COIN1|COIN1_ACTION_INDEX|COIN2|COIN2_ACTION_INDEX|MEMO
            return [0, params.coin1, params.coin1ActionIndex, params.coin2, params.coin2ActionIndex, params.memo || ''];
        case 'BROADCAST':
            // FORMAT: VERSION|MESSAGE|VALUE
            return [0, params.message || '', params.value || ''];
        case 'MESSAGE':
            // FORMAT: VERSION|COIN|DESTINATION|ENCRYPTION_METHOD|ENCRYPTION_KEY
            // COIN (destination network) is optional; empty = unscoped. Without it the
            // DESTINATION would land in the COIN slot and the message would be malformed.
            return [0, params.coin || '', params.destination, params.encryptionMethod || '', params.encryptionKey || ''];
        default:
            return undefined;
    }
}

// The asynchronous frameworks plus the re-entrant EXECUTE: emissions whose
// params carry an id the VM and the host both hash.
function frameworkEmissionParams(action, params){
    switch(action){
        case 'ATTEST':
            // FORMAT v0 (request, VM-emitted): VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS|FEE_TICK|FEE_AMOUNT
            // FEE_TICK/FEE_AMOUNT are optional trailing fields; empty when the
            // contract requested no fee (the attest handler treats '' as null).
            return [0, params.requestId, params.providerId, params.requestPayload, params.callbackMethod,
                    params.callbackParams || '[]', params.redundancy, params.deadlineBlocks,
                    params.feeTick || '', params.feeAmount || ''];
        case 'EXECUTE':
            // FORMAT: VERSION|CONTRACT_ACTION_INDEX|METHOD|PARAMS...
            // (gasLimit travels via emissionData.VM_GAS_LIMIT, not the positional
            // params; the v0 EXECUTE format has no GAS_LIMIT slot.)
            return [0, params.contractIndex, params.method,
                    ...(Array.isArray(params.params) ? params.params : [])];
        case 'XCALL':
            // FORMAT v0 (request, VM-emitted): VERSION|CALL_ID|TARGET_CHAIN|TARGET_CONTRACT_INDEX|METHOD|PARAMS_JSON|GAS_LIMIT|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|DEADLINE_BLOCKS|CROSS_HOPS
            // crossHops is the HOST-derived value set above (never the VM's claim).
            return [0, params.callId, params.targetChain, params.contractIndex, params.method,
                    JSON.stringify(Array.isArray(params.params) ? params.params.map(String) : []),
                    params.gasLimit, params.callbackMethod,
                    JSON.stringify(Array.isArray(params.callbackParams) ? params.callbackParams.map(String) : []),
                    params.deadlineBlocks, params.crossHops];
        default:
            return undefined;
    }
}

// Map action names to handler instances
function getActionHandler(action){
    let handlers = {
        'SEND':       this.actions.actionSend,
        'DESTROY':    this.actions.actionDestroy,
        'ISSUE':      this.actions.actionIssue,
        'MINT':       this.actions.actionMint,
        'ORDER':      this.actions.actionOrder,
        'DISPENSER':  this.actions.actionDispenser,
        'DIVIDEND':   this.actions.actionDividend,
        'AIRDROP':    this.actions.actionAirdrop,
        'CALLBACK':   this.actions.actionCallback,
        'FILE':       this.actions.actionFile,
        'LIST':       this.actions.actionList,
        'COINPAY':    this.actions.actionCoinpay,
        'SWEEP':      this.actions.actionSweep,
        'LINK':       this.actions.actionLink,
        'BROADCAST':  this.actions.actionBroadcast,
        'MESSAGE':    this.actions.actionMessage,
        'ATTEST':     this.actions.actionAttest,
        'VOTE':       this.actions.actionVote,
        // Cross-contract call: the callee EXECUTE routes through this same
        // handler class (re-entrant; parse() keeps no instance state).
        'EXECUTE':    this.actions.actionExecute,
        // Cross-CHAIN call request (the relay rides the hub mirror from here).
        'XCALL':      this.actions.actionXcall
    };
    return handlers[action] || null;
}

module.exports = { tokenEmissionParams, marketEmissionParams, contentEmissionParams, frameworkEmissionParams, getActionHandler };
