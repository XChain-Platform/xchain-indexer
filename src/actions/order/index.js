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
 * XChain Platform Action - ORDER
 *
 * This action creates a order to sell an item on the Decentralized Exchange (DEX).
 *
 * PARAMS:
 * VERSION             - Format Version
 * GIVE_COIN           - `COIN` name (BTC, LTC, DOGE, etc)
 * GIVE_TICK           - Ticker name or Ticker ID
 * GIVE_AMOUNT         - Quantity of `GIVE_TICK` to escrow in the order (empty when GIVE_OWNERSHIP=1)
 * GIVE_OWNERSHIP      - 1 = escrow GIVE_TICK ownership instead of a balance amount (default 0)
 * GET_COIN            - `COIN` name (BTC, LTC, DOGE, etc)
 * GET_TICK            - Ticker name or Ticker ID
 * GET_AMOUNT          - Quantity of `GET_TICK` requested in return (empty when GET_OWNERSHIP=1)
 * GET_OWNERSHIP       - 1 = require matcher to currently own GET_TICK and transfer it (default 0)
 * GET_ADDRESS         - Address to receive `GET_TICK` on `GET_COIN` network
 * EXPIRATION          - Timestamp of when order should expire, in Unix time
 * ALLOW_LIST          - `ACTION_INDEX` of a `LIST` of addresses allowed to match order
 * BLOCK_LIST          - `ACTION_INDEX` of a `LIST` of addresses NOT allowed to match order
 * MEMO                - An optional memo to include
 * ORDER_ACTION_INDEX  - `ACTION_INDEX` of existing `ORDER`
 *
 * FORMATS:
 * - 0 = Create Order
 * - 1 = Cancel Order
 * - 2 = Edit Order
 *
 ********************************************************************/

// The handler's parts, in the order parse() calls them. Each takes this handler explicitly
// and reads and updates the parse state it is handed, so the class keeps exactly the
// constructor and parse it has always exported.
const { readParams, detectSides, loadRecords } = require('./context.js');
const { validateTickAndCoin, validateFormats, validateOwnership, validateGeneral,
        validateLists, reserveGiveAmount } = require('./validate.js');
const { priceOrder, validateFeePayment } = require('./fees.js');
const { runListingGuard } = require('./controller_guard.js');
const { recordOrder, settleLedger } = require('./settle.js');

class Order {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';
        this.formats[1] = 'VERSION|ORDER_ACTION_INDEX|MEMO';
        this.formats[2] = 'VERSION|ORDER_ACTION_INDEX|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO';

        // Define array of supported list types (1=Tick, 2=Address)
        this.listTypes = [2];
    }

    // Handle parsing the ORDER transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // Example payloads by FORMAT version:
        // let str    = "0|BTC|RAREPEPE|1|BTC|PEPECASH|10000000.00000000|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|||Selling my RAREPEPE cuz mom in hospital";
        // let str    = "1|1234|Closing order, no buyers, much disappoint";
        // let str    = "2|1234|4321|||Updating order to only sell to club member addresses";
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // VERSION, wire params and the GET_ADDRESS reference, then the order's sides and records
        let st = await readParams(this, params, data, error);
        await detectSides(this, st);
        await loadRecords(this, st);

        // TICK & COIN Validations
        validateTickAndCoin(this, st);

        // FORMAT Validations
        validateFormats(this, st);

        // Token Ownership Validations (format 0 only)
        await validateOwnership(this, st);

        // General Validations
        await validateGeneral(this, st);
        await validateLists(this, st);
        reserveGiveAmount(this, st);

        // Fee amount, its payment, and the GIVE token's listing guard
        await priceOrder(this, st);
        await validateFeePayment(this, st);
        await runListingGuard(this, st);

        // Status, the action's rows, and the ledger of a valid action
        await recordOrder(this, st);
        await settleLedger(this, st);

        // Create action mappings
        await this.mapper.createMappings(st.data);

        // Check to see if we have any matches for this order. Cross-chain orders are NOT
        // matched locally; the counterparty lives in another chain's indexer DB, invisible
        // to the local ORDER_MATCH query. The xchain-hub federation matches them and delivers
        // a validator-signed fill via the hub mirror, which the indexer settles from escrow
        // (see the cross-chain settlement pass). GIVE stays escrowed until filled/cancelled/expired.
        if(st.status=='valid' && !st.isCrossChain)
            await this.actions.processAction('ORDER_MATCH', null, st.data, null);
    }
}

module.exports = Order;
