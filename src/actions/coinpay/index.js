const { getLogger } = require('../../observability/index.js');
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
 * XChain Platform Action - COINPAY
 *
 * This action processes native coin payments that fulfill COINPay
 * obligations created by ORDER_MATCH for native coin DEX pairs.
 *
 * A COINPAY transaction includes both the action data (OP_RETURN)
 * and a native coin output paying the seller. The indexer processes
 * each output separately; only the output matching the obligation's
 * payee address and amount triggers settlement.
 *
 * Inside a BATCH there is no per-output processing (a BATCH row is not a
 * per-output settlement row, so output_fanout.js collapses it to one row),
 * so a batched sub-command resolves its own payment output from TX_OUTPUTS
 * instead. See the note at the resolution below.
 *
 * Format: COINPAY|0|ORDER_MATCH_ACTION_INDEX
 *
 ********************************************************************/

// The handler's phases, grouped by concern and installed onto Coinpay.prototype below:
// validate.js (the pending obligation), payment_pool.js (which payment it draws on and
// what is left) and settle.js (the record, the roles, the token release, the orders)
const validatePart    = require('./validate.js');
const paymentPoolPart = require('./payment_pool.js');
const settlePart      = require('./settle.js');

class Coinpay {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Define list of known FORMATS
        this.formats = {};
        this.formats[0] = 'VERSION|ORDER_MATCH_ACTION_INDEX';
    }

    // The transaction output that pays `address`, or null.
    //
    // FIRST match, deliberately: the same matcher utility.js validateNativeCoinFee and
    // validateOracleFee use, so a payer sizing one output per payee and the validator
    // reading it back cannot disagree about WHICH output is meant. tx_outputs arrives
    // sorted by vout (db.js getDecoderBlockData), so "first" is the lowest-vout output
    // paying that address and is identical on every node.
    //
    // Consequence worth naming: an address paid by TWO outputs offers only the first as a
    // pool, so a batch settling two obligations to one seller must pay that seller both
    // obligations' worth in a single output. That is the shape the pool arithmetic below
    // already assumes ("surplus above the owed amount stays in the pool for a sibling
    // obligation to the same address") and is why the pool invariant still binds per address.
    findPaymentOutput(txOutputs, address){
        if(!txOutputs || !Array.isArray(txOutputs) || this.util.isNull(address))
            return null;
        for(let output of txOutputs){
            if(output && (output.address === address || output.scriptPubKey_address === address))
                return output;
        }
        return null;
    }

    // Handle parsing the COINPAY transaction
    async parse(params, data, error){

        // Validate that format is known
        let format = data['FORMAT'];
        if(!error && (format===null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        // Parse PARAMS using given VERSION format and update transaction data object
        if(!error)
            data = this.util.setActionParams(data, params, this.formats, format);

        // Convert NUMBER fields from string value to number value
        if(!error)
            data = this.util.setNumberFormats(data);

        // The pending obligation this output pays; any other output has already been
        // skipped as a no-op (coinpay/validate.js)
        let obligationInfo = await this.loadPendingObligation(data, error);
        if(!obligationInfo)
            return;

        // The payment this obligation draws on and what is left of it; a payment that
        // cannot cover the owed amount has already been skipped (coinpay/payment_pool.js)
        let pool = await this.resolvePaymentPool(data, obligationInfo);
        if(!pool)
            return;

        // Validate obligation has not expired
        if(!error && data['BLOCK_TIME'] >= obligationInfo['EXPIRATION'])
            error = 'invalid: COINPAY obligation expired';

        // Determine final status
        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Draw the owed amount out of the batch pool for a settlement that stands
        // (coinpay/payment_pool.js)
        this.drawFromPool(pool, obligationInfo, status);

        // Print status message
        getLogger().info("\t COINPAY : " + this.config['COIN'] + ':' + data['ORDER_MATCH_ACTION_INDEX'] + ' : ' + data['STATUS']);

        // Record the output this obligation settled against (coinpay/settle.js)
        await this.recordCoinpay(data, obligationInfo, pool, status);

        // If invalid, record and exit
        if(status != 'valid'){
            await this.mapper.createMappings(data);
            return;
        }

        // Valid COINPAY: settle the trade.
        await this.settleTrade(data, obligationInfo);
    }

    // Settle a valid COINPAY: release the sold token to the buyer, mark the obligation
    // fulfilled, clear its match and finalize both orders. The two status writes stay
    // here because the settlement suite reads this file's source for them.
    async settleTrade(data, obligationInfo){

        // Both orders, split into token seller and coin offerer (coinpay/settle.js); null
        // when either is gone or the native roles are ambiguous, and nothing settles
        let roles = await this.resolveTradeRoles(data, obligationInfo);
        if(!roles)
            return;
        let { sellerOrder, coinOrder } = roles;

        // The buyer (coin payer) receives tokens at their order's GET_ADDRESS
        let buyerGetAddress = coinOrder['GET_ADDRESS'];

        // Add addresses to the addresses list
        this.util.addAddressTicker(sellerOrder['SOURCE'], sellerOrder['GIVE_TICK']);
        this.util.addAddressTicker(buyerGetAddress, sellerOrder['GIVE_TICK']);

        // Array of credits, debits, and escrows
        let credits = [],
            debits  = [],
            escrows = [];

        // Release the sold token (or its ownership record) to the buyer (coinpay/settle.js)
        await this.releaseSoldToken(data, obligationInfo, sellerOrder, buyerGetAddress, credits, escrows);

        // Update coinpay obligation status to 'fulfilled'
        await this.indexerDb.createCoinpayStatus(data['ACTION_INDEX'], obligationInfo['ACTION_INDEX'], 'fulfilled');

        // Clear the MATCH. Its status lives on its own order_matches row; order_statuses
        // is keyed by an ORDER index and every reader joins it that way, so a match
        // index written there matches nothing.
        await this.indexerDb.updateOrderMatchStatus(obligationInfo['ACTION_INDEX'], 'valid');

        // Complete finished orders and finalize a cancelling or expiring seller (coinpay/settle.js)
        await this.finalizeOrders(data, sellerOrder, coinOrder, credits, escrows);

        // Process any transaction ledger changes (credits / debits / escrows)
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);

        // Get a list of tickers & addresses
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());

        // Update address balances and token supply
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        // Create action mappings
        await this.mapper.createMappings(data);
    }
}

// Install the phase methods from coinpay/ NON-ENUMERABLE, the shape the class body they came
// from produced: parse() reaches them as this.<method>, suites can stub them through
// Coinpay.prototype, and for-in over a handler stays empty. Same install as db/index.js uses
// for its query mixins.
for(const part of [validatePart, paymentPoolPart, settlePart]){
    const descriptors = Object.getOwnPropertyDescriptors(part);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Coinpay.prototype, descriptors);
}

module.exports = Coinpay;
