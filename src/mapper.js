/* XChain Indexer Mapper Class */

class Mapper {

    // Handle constructing a class instance
    constructor(indexer){
        // Setup short aliases
        this.config    = indexer.config;
        this.decoderDb = indexer.decoderDb;
        this.indexerDb = indexer.indexerDb;
        this.util      = indexer.util;
    }

    // Generalized function to handle creating action_index mapping records
    async createMappings(data){
        // Setup alias to action
        let action       = data['ACTION'],
            action_index = data['ACTION_INDEX'];

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
            if(!mapped.address.includes(address)){
                mapped.address.push(address);
                await this.indexerDb.createActionMapping(action_index, 'address', address);
            }

            // Create action_index->tick mappings
            for(let tick of list[address]){
                if(!mapped.tick.includes(tick)){
                    mapped.tick.push(tick);
                    await this.indexerDb.createActionMapping(action_index, 'tick', tick);
                }
            }

        }

        // Handle creating link mappings
        if(action=='LINK'){
            // TODO : write code to allow linking files to tokens (only create mapping if link is done by current token owner)
        }

    }

}

module.exports = Mapper;
