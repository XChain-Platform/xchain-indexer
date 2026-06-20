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
 * XChain Indexer - Mapper Class
 * 
 * This file handles creating mappings between action_indexes and data
 *
 ********************************************************************/

class Mapper {

    constructor(indexer){
        this.config    = indexer.config;
        this.decoderDb = indexer.decoderDb;
        this.indexerDb = indexer.indexerDb;
        this.util      = indexer.util;
    }

    // Generalized function to handle creating action_index mapping records
    async createMappings(data){
        let action       = data['ACTION'],
            action_index = data['ACTION_INDEX'],
            status       = data['STATUS'];

        // Get a list of address->tickers mappings
        let list = this.util.getAddressesList();

        // List to store items that have been successfully mapped
        let mapped = {
            address: [],
            tick   : []
        };

        // Loop through address->tickers mappings list
        for(let address in list){

            // Create action_index->address mappings
            if(!this.util.isNull(address) && !mapped.address.includes(address)){
                mapped.address.push(address);
                await this.indexerDb.createActionMapping(action_index, 'address', address);
            }

            // Create action_index->tick mappings
            for(let tick of list[address]){
                if(!this.util.isNull(tick) && !mapped.tick.includes(tick)){
                    mapped.tick.push(tick);
                    await this.indexerDb.createActionMapping(action_index, 'tick', tick);
                }
            }

        }

        // Handle creating link mappings 
        // TODO : Add support for verifying links across multiple COIN networks in xchain-hub
        if(action=='LINK' && status=='valid'){
            // Get information on the actions if it is on the local COIN network
            let action1 = (data['COIN1']==this.config['COIN']) ? await this.indexerDb.getActionData(data['COIN1_ACTION_INDEX']) : false;
            let action2 = (data['COIN2']==this.config['COIN']) ? await this.indexerDb.getActionData(data['COIN2_ACTION_INDEX']) : false;
            if(action1 && action2){
                // Process any FILE->ISSUE links
                if((action1.action=='FILE' && action2.action=='ISSUE')||(action2.action=='FILE' && action1.action=='ISSUE')){
                    // Get ACTION_INDEX of FILE we are linking as well as TICK and current token information
                    let tick  = (action1.action=='ISSUE') ? action1.tick : action2.tick;
                    let index = (action1.action=='FILE') ? action1.action_index : action2.action_index;
                    let token = await this.indexerDb.getTokenInfo(tick);
                    // Create TICK<->FILE mapping if LINK action was created by current token owner address
                    if(token && data['SOURCE']==token['OWNER'])
                        await this.indexerDb.createFileMapping(index, 'tick', tick);
                }
            }
        }

    }

}

module.exports = Mapper;
