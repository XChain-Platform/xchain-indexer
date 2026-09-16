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
 * XChain Platform Action - XBRIDGE (user-broadcast lock/burn, system-injected settle)
 *
 * The module shape, the method names, the parameter sets and the exact verdict strings
 * are the SEAM every bridge component builds against. The wire side (v0, v1, v3, v4) is built
 * here; the mirror-injected settle legs (v2, v5) live in ../bridge_settle.js.
 *
 * TWO WRITERS THIS HANDLER CALLS, which live in the database layer rather than in
 * this handler (src/db/xbridges/index.js and src/db/tokens/index.js), because neither spec nor the
 * seam contract places a table writer or a tokens column setter in an action file:
 *
 *   1. `xbridges` action table plus `Database.createXbridge(data)`. Every user-broadcast
 *      action on the platform records its own row (sends, destroys, cross_chain_calls);
 *      the hub's CrossChainBridgeEngine polls the indexer's `getpendingbridgetransfers`
 *      for confirmed locks and burns, and that read has nothing to read
 *      without this table. The row needs: action_index, format (the version byte),
 *      tick_id, source_id, dest_chain, dest_address_id (v0/v3) or origin_address_id
 *      (v1/v4), amount, decimals, min_depth, memo, status_id, block_index.
 *   2. `Database.setTokenBridged(tick, blockIndex)` for the token spec's `tokens.bridged`
 *      bit, set by the first applied v3 lock. `createToken` derives every
 *      tokens column from the issues rows and this one is not derivable from an ISSUE,
 *      so it needs its own setter.
 *
 * One action name, one handler with a version switch, one manifest entry, one decoder
 * name, one doc page. The version decides who may broadcast it and on which chain -
 * the shape ATTEST (v0 request, v1 response, v2 expiry) and XCALL already use.
 *
 * FORMATS:
 *   v0 - lock,   user-broadcast, BTC only:        VERSION|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO
 *   v1 - burn,   user-broadcast, non-BTC only:    VERSION|BTC_ADDRESS|AMOUNT|MEMO
 *   v2 - settle, mirror-injected, never broadcast (from a finalized bridge_transfers row)
 *   v3 - lock,   user-broadcast, origin chain:    VERSION|TICK|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO
 *   v4 - burn,   user-broadcast, bridged rows:    VERSION|TICK|ORIGIN_ADDRESS|AMOUNT|MEMO
 *   v5 - settle, mirror-injected, never broadcast (the v2 legs carrying a tick)
 *
 * WHERE THE WORK SPLITS. This file owns the WIRE side: parse, guards, verdicts, and the
 * ledger effect of a lock and a burn. The mirror-injected settle legs (v2 and v5) are
 * applied from ../bridge_settle.js, which is a separate file for the same reason
 * cross_settle.js is separate from the handlers whose escrow it releases: a settle leg is
 * driven by an end-of-block pass over mirrored rows, not by a transaction on this chain.
 *
 * ACTIVATION. v0/v1/v2 gate on ../xchain_bridge_activation.js, v3/v4/v5 on
 * ../token_bridge_activation.js, both keyed on the block_index of the chain being parsed.
 * Below the gate a broadcast is 'invalid: XBRIDGE before activation' (the per-feature
 * shape anchor.js uses) and no settle leg is ever injected, so pre-activation block hashes
 * are unchanged on every chain.
 *
 * Two closures do NOT gate on either activation and hold on every non-BTC chain from the
 * commit that lands them: ISSUE of the GAS tick off BTC, and DESTROY of
 * the GAS tick off BTC. They live in issue.js and destroy.js, not here.
 *
 * The coin bridge (v0 to v2) and the token bridge (v3 to v5) share one docs page;
 * see xchain-documentation/protocol/actions/xbridge.md.
 *
 * WHERE THE PARTS LIVE. This file is the entry and the dispatch; the wire-only guards
 * are in ./validate.js, the two ledger effects in ./lock_burn.js, the row record and
 * the valid-path settlement in ./settle.js, and the verdict strings in ./verdicts.js.
 * The protocol fee stays here, because the fee walk in xchain-sdk enrols an action by
 * finding createFeesObject in the handler's own entry file.
 *
 ********************************************************************/

'use strict';

const validate = require('./validate.js');
const lockBurn = require('./lock_burn.js');
const settle   = require('./settle.js');
const v        = require('./verdicts.js');

const VERDICTS = v.VERDICTS;

class XBridge {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Wire formats, by version byte. v2 and v5 carry no user format: they are injected
        // from a finalized bridge_transfers row and are refused outright when broadcast.
        this.formats = {};
        this.formats[0] = 'VERSION|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO';
        this.formats[1] = 'VERSION|BTC_ADDRESS|AMOUNT|MEMO';
        this.formats[3] = 'VERSION|TICK|DEST_COIN|DEST_ADDRESS|AMOUNT|MEMO';
        this.formats[4] = 'VERSION|TICK|ORIGIN_ADDRESS|AMOUNT|MEMO';
    }

    /**
     * The default handler entry. actions/index.js dispatches every parsed XBRIDGE here, exactly
     * as it dispatches SEND to send.js and ANCHOR to anchor.js:
     *
     *     if(action=='XBRIDGE')  await this.actionXbridge.parse(params, data, error);
     *
     * Dispatches on data['FORMAT']: 0 and 3 to applyLock, 1 and 4 to applyBurn, 2 and 5 to
     * the system-injected refusal. Writes exactly one verdict to data['STATUS'] and, on a
     * valid action, the ledger effect through this.indexerDb, then this.mapper.
     *
     * DB READ ORDER IS CONSENSUS. getTokenInfo() interns its argument in index_tickers
     * (createTicker), and index ids feed the ledger hash, so a read that happens on one
     * node and not another forks the id counter. Every read below therefore sits behind
     * a guard that depends only on wire bytes and node-uniform config: the pure-string
     * tick guards run FIRST and a refused shape never reaches a read, on every node.
     *
     * @param {Array<string>}       params - the raw `|`-split wire fields, VERSION first
     * @param {Object}              data   - the action row under construction. Reads FORMAT,
     *                                       SOURCE, BLOCK_INDEX, BLOCK_TIME, ACTION_INDEX,
     *                                       IS_GENESIS; writes STATUS and the parsed fields
     * @param {string|null|undefined} error - a verdict an earlier gate already reached; when
     *                                       set, the handler records the row and adds no
     *                                       effect (the send.js convention)
     * @returns {Promise<void>}
     */
    async parse(params, data, error){

        let format = data['FORMAT'];

        // Parse the positional wire fields for the four user formats. v2 and v5 have no
        // user format, so nothing is mapped for them; they are refused (or handed to the
        // settle pass) below on the version byte alone.
        if(this.formats[format] !== undefined)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Raw wire clone for the action row, taken BEFORE setNumberFormats so the record
        // keeps the amount text exactly as it was broadcast (the dividend.js precedent).
        let xbridge = Object.assign({}, data);

        if(!error)
            data = this.util.setNumberFormats(data);

        let ctx = this.buildContext(data);

        // Shared gates: known version, activation, broadcast-of-an-injected-version, chain.
        if(!error){
            let gate = validate.validateFormat(data, ctx);
            if(!gate.valid)
                error = gate.verdict;
        }

        // A system-injected settle leg that passed the gates is NOT this handler's to
        // apply: ../bridge_settle.js drives v2 and v5 from the mirrored bridge_transfers
        // row at the pinned end-of-block pass position. Returning without
        // writing a verdict leaves that row entirely to the settle pass, which is the
        // only writer of it.
        if(!error && validate.INJECTED_VERSIONS.indexOf(format) !== -1)
            return;

        // Resolve the tick this action moves. v0 and v1 are the GAS tick by construction
        // (XCHAIN is the only asset the base spec bridges); v3 and v4 carry it on the wire.
        if(format === 0 || format === 1)
            ctx.tick = this.config['GAS'];
        if(format === 3 || format === 4)
            ctx.tick = data['TICK'];

        // Pure-string tick guards (row kind, GAS, dot, length). No database read, so the
        // refused shapes above never intern a junk ticker id.
        if(!error){
            let shape = validate.validateTickShape.call(this, format, ctx);
            if(!shape.valid)
                error = shape.verdict;
            ctx.origin = shape.origin;
        }

        let charged = await this.applyAndCharge(data, ctx, format, error);

        await settle.recordAndSettle.call(this, data, xbridge, ctx, charged.fees, format, charged.error);
    }

    /**
     * The read-bearing half of parse(): the database reads, the version-specific
     * validation with its ledger plan, and the protocol fee. Each step runs only while
     * no verdict has been reached, in this order, so the read order stays the one
     * parse() documents as consensus.
     *
     * @param {Object}                data   - the action row, after setNumberFormats
     * @param {Object}                ctx    - handler context; tick and origin resolved
     * @param {number}                format - the wire VERSION, 0, 1, 3 or 4
     * @param {string|null|undefined} error  - the verdict the wire-only guards reached
     * @returns {Promise<{fees: (Object|null), error: (string|null|undefined)}>} the fee
     *          object (null when no fee was charged) and the verdict after these steps
     */
    async applyAndCharge(data, ctx, format, error){

        // Reads, only on a path that has passed every wire-only guard.
        let preferences = null;
        if(!error){
            ctx.tokenInfo     = await this.indexerDb.getTokenInfo(ctx.tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            ctx.sourceBalance = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            preferences       = await this.indexerDb.getAddressPreferences(data['SOURCE'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }

        // Version-specific validation and the ledger plan.
        if(!error){
            let result = (format === 0 || format === 3)
                ? await lockBurn.applyLock.call(this, data, ctx)
                : await lockBurn.applyBurn.call(this, data, ctx);
            if(!result.valid)
                error = result.verdict;
        }

        // Protocol fee, charged only on a path every guard has passed.
        let fees = null;
        if(!error){
            let charged = await this.chargeProtocolFee(data, ctx, preferences);
            fees  = charged.fees;
            error = charged.error;
        }

        return { fees: fees, error: error };
    }

    /**
     * The handler context every method below shares. `coin` is this chain's coin: it
     * decides BTC_ONLY versus V1_NOT_ON_BTC and, with `network`, keys the XCHAIN
     * activation map ('<COIN>:<network>'); the token map is network-keyed.
     * `credits` / `debits` are the ledger plan applyLock / applyBurn fill in, so the
     * two apply methods can stay pure verdict functions from the caller's side.
     *
     * @param {Object} data - the action row, after setNumberFormats
     * @returns {Object} the context parse() threads through every guard and effect
     */
    buildContext(data){
        return {
            coin:          this.config['COIN'],
            network:       this.config['NETWORK'],
            blockIndex:    data['BLOCK_INDEX'],
            blockTime:     data['BLOCK_TIME'],
            isGenesis:     data['IS_GENESIS'] === true,
            tick:          null,
            origin:        null,
            tokenInfo:     null,
            sourceBalance: null,
            escrow:        null,
            credits:       [],
            debits:        []
        };
    }

    /**
     * Protocol fee: the flat XBRIDGE_BASE gas entry for every user-broadcast version
     * (coin and token formats alike). Charged AFTER the amount was debited from the
     * in-memory balance by applyLock, so on BTC - where the fee is paid out of the same
     * XCHAIN balance a v0 lock moves - AMOUNT and the fee must fit together and a
     * source cannot spend one balance twice.
     *
     * Stays in this file because the xchain-sdk fee walk enrols an action as
     * fee-charging by finding createFeesObject in src/actions/<name>/index.js.
     *
     * @param {Object}      data        - the action row; reads TX_OUTPUTS
     * @param {Object}      ctx         - handler context; reads sourceBalance
     * @param {Object|null} preferences - the source's address preferences, read above
     * @returns {Promise<{fees: Object, error: (string|null)}>} the fee object, and the
     *          refusal when the source cannot pay it
     */
    async chargeProtocolFee(data, ctx, preferences){

        let error = null;
        let fees  = await this.util.createFeesObject(this.indexerDb, data, preferences);
        fees['GAS_COST']    = this.util.resolveGasScheduleCost('XBRIDGE_BASE');
        fees['AMOUNT']      = this.util.feeForAction(this.util.bcmul(fees['GAS_COST'], this.config['GAS_PRICE'], 8), data);
        fees['FEE_VERSION'] = 2;

        if(this.util.bcgt(fees['AMOUNT'], 0)){
            let paymentMode = this.util.detectFeePaymentMode(data, this.decoderDb, data['TX_OUTPUTS']);
            if(paymentMode === 'native'){
                let validation = await this.util.validateNativeCoinFee(data, fees, this.indexerDb, data['TX_OUTPUTS']);
                if(!validation.valid){
                    error = 'invalid: ' + (validation.error || 'native coin fee validation failed');
                } else {
                    fees['PAYMENT_MODE']       = 1;
                    fees['NATIVE_COIN_AMOUNT'] = validation.nativeCoinAmount;
                    fees['NATIVE_COIN']        = validation.nativeCoin;
                    fees['ORACLE_ROUND']       = validation.oracleRound;
                }
            } else if(paymentMode === 'rejected'){
                error = v.FEE_NATIVE_REQUIRED;
            } else if(!this.util.hasBalance(ctx.sourceBalance, fees['TICK_ID'], fees['AMOUNT'])){
                error = v.FEE_INSUFFICIENT;
            }
        }

        return { fees: fees, error: error };
    }
}

XBridge.VERDICTS = VERDICTS;

module.exports = XBridge;
