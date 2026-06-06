/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform Action - UNKNOWN
 * 
 * This is a generalized action class for any unknown ACTION commands
 * 
 ********************************************************************/

class Unknown {

    // Handle constructing a class instance
    constructor(action){
        // Setup short aliases
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
    }

    // Handle parsing the UNKNOWN transactions
    async parse(params, data, error){

        // Determine final status
        let status = (error) ? error : 'invvalid';
        data['STATUS'] = status;

        // Print status message 
        console.log("\t UNKNOWN : " + data['STATUS']);

        // Store the SOURCE in addresses list
        this.util.addAddressTicker(data['SOURCE']);

        // Create action mappings
        await this.mapper.createMappings(data);

    }
}

module.exports = Unknown;