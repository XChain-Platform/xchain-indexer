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
 *  XChain Platform Action - MINT
 * 
 * This action mints `TICK` supply.
 * 
 * PARAMS:
 * - VERSION     - Format Version
 * - TICK        - Ticker name or Ticker ID
 * - AMOUNT      - Amount of tokens to mint
 * - DESTINATION - Address to transfer tokens to
 * 
 * FORMATS:
 * - 0 = Full
 * 
 ********************************************************************/

// WHERE THE PARTS LIVE. This file is the entry and the dispatch. The wire parse, the
// token state and the verdict ladder are in ./validate.js, the controller guard run in
// ./controller_guard.js, and the mints row with the valid-path ledger effect in
// ./settle.js. Every part runs with `this` bound to the handler, in the original order.
const validate        = require('./validate.js');
const controllerGuard = require('./controller_guard.js');
const settle          = require('./settle.js');

class Mint {

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
        this.formats[0] = 'VERSION|TICK|AMOUNT|DESTINATION|MEMO';
    }

    // Handle parsing the MINT transaction
    async parse(params, data, error){
        /*****************************************************************
         * DEBUGGING - Force params
         ****************************************************************/
        // Example payloads by FORMAT version:
        // let str    = "0|JDOG|1|";
        // params = String(str).split('|');
        // data['FORMAT'] = this.util.getFormatVersion(params[0]);

        // Wire parse: the FORMAT gate, PARAMS, number formats and the ^<id> DESTINATION
        ({ data, error } = await validate.parseWire.call(this, params, data, error));

        // The token state this mint is judged against, then the verdict ladder in order
        let ctx = await validate.loadTokenState.call(this, data, error);
        await validate.validateTokenRules.call(this, ctx);
        await validate.validateSupplyCaps.call(this, ctx);
        await validate.validateAuthorityAndWindow.call(this, ctx);

        // Controller-bound token guard, after all MINT validation and before settlement
        await controllerGuard.runControllerGuard.call(this, ctx);

        // Record the mint, and mint any actual supply only when it is valid
        let status = await settle.recordMint.call(this, ctx);
        if(status=='valid')
            await settle.settleValidMint.call(this, ctx);

        // Create action mappings
        await this.mapper.createMappings(data);

    }
}

module.exports = Mint;