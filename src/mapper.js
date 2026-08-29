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

        let list = this.util.getAddressesList();

        let mapped = {
            address: [],
            tick   : []
        };

        // Collect every address/tick to map first, then write each group in one batched
        // INSERT instead of a serial per-address/per-tick round-trip - recipient-scaling
        // actions (DIVIDEND/AIRDROP/CALLBACK) can carry thousands of addresses here.
        // Addresses are the keys of a plain object, so they arrive unique and need no dedup
        // scan; ticks do repeat across addresses, so dedup those through a Set, which probes
        // in O(1) and preserves the first-seen order the batched INSERT already wrote.
        let ticks = new Set();

        for(let address in list){

            if(!this.util.isNull(address))
                mapped.address.push(address);

            for(let tick of list[address]){
                if(!this.util.isNull(tick))
                    ticks.add(tick);
            }

        }

        mapped.tick = [...ticks];

        await this.indexerDb.createActionMappings(action_index, 'address', mapped.address);
        await this.indexerDb.createActionMappings(action_index, 'tick', mapped.tick);

        // TODO: Add support for verifying links across multiple COIN networks in xchain-hub
        if(action=='LINK' && status=='valid'){
            let action1 = (data['COIN1']==this.config['COIN']) ? await this.indexerDb.getActionData(data['COIN1_ACTION_INDEX']) : false;
            let action2 = (data['COIN2']==this.config['COIN']) ? await this.indexerDb.getActionData(data['COIN2_ACTION_INDEX']) : false;
            if(action1 && action2){
                if((action1.action=='FILE' && action2.action=='ISSUE')||(action2.action=='FILE' && action1.action=='ISSUE')){
                    let tick  = (action1.action=='ISSUE') ? action1.tick : action2.tick;
                    let index = (action1.action=='FILE') ? action1.action_index : action2.action_index;
                    let token = await this.indexerDb.getTokenInfo(tick);
                    // Only link the FILE if the LINK's SOURCE is the token's current owner.
                    if(token && data['SOURCE']==token['OWNER'])
                        await this.indexerDb.createFileMapping(index, 'tick', tick);
                }
            }
        }

    }

}

module.exports = Mapper;
