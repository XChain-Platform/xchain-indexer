/* XChain Indexer Actions */

const util    = require('./util.js');

class Actions {

    // Handle constructing a class instance
    constructor(indexerDb){
        // Setup alias to the indexer database connection
        this.indexerDb = indexerDb;
    }

    // Generalized function to handle processing a transaction
    // @param tx             object     Transaction object
    // @param tx.source      string     Source address
    // @param tx.text        string     Action `text`
    // @param tx.tx_hash     string     Transaction hash
    // @param tx.block_index integer    Block index of tx
    async processTransaction(tx){
        let error = false;
        console.log('tx=',tx);
    }

}

module.exports = Actions;
