/* XChain Indexer Actions */

const changes = require('./protocol_changes.js');
const util    = require('./util.js');

class Actions {

    // Handle constructing a class instance
    constructor(decoderDb, indexerDb){
        // Setup alias to the indexer database connection
        this.decoderDb = decoderDb;
        this.indexerDb = indexerDb;

        // Create instance of the protocol changes class
        this.protocolChanges = new changes(this.decoderDb, this.indexerDb);

        // Define ACTION aliases
        this.actionAliases = {};
        this.actionAliases['TRANSFER'] = 'SEND';    // Legacy BRC20 format
        this.actionAliases['DEPLOY']   = 'ISSUE';   // Legacy BRC20 format
        this.actionAliases['ADDR']     = 'ADDRESS'; // Short alias
    }

    // Generalized function to handle processing a transaction
    // @param tx             object     Transaction object
    // @param tx.source      string     Source address
    // @param tx.data        string     Action `text`
    // @param tx.tx_hash     string     Transaction hash
    // @param tx.block_index integer    Block index of tx
    async processTransaction(tx){
        let error       = false;
        let params      = String(tx.data).split('|');
        let source      = tx.source;
        let tx_hash     = tx.tx_hash;
        let tx_data     = tx.data;
        let block_index = tx.block_index;

        // Create database records and get ids for tx_hash and source address
        let source_id  = await this.indexerDb.createAddress(source);
        let tx_hash_id = await this.indexerDb.createTransaction(tx_hash);

        // Trim whitespace from any PARAMS
        params.forEach(function(value, idx){
            params[idx] = String(value).trim();
        });

        // Extract ACTION from PARAMS
        let action = String(params.shift()).toUpperCase();

        // Set correct ACTION for any aliases
        for(var alias in this.actionAliases){
            if(action==alias)
                action = this.actionAliases[alias];
        }

        // Define basic ACTION transaction data object
        let data = {};
        data['ACTION']      = action;      // Action (ISSUE, MINT, SEND, etc)
        data['BLOCK_INDEX'] = block_index; // Block index 
        data['SOURCE']      = source;      // Source/Broadcasting address
        data['TX_HASH']     = tx_hash;     // Transaction Hash
        data['TX_DATA']     = tx_data;     // Raw tx data string

        // Validate Action is known
        if(!this.protocolChanges.isDefined(action)){
            error = 'invalid: Unknown ACTION';
            data['ACTION'] = action = 'UNKNOWN';
        }

        // Verify ACTION is activated
        if(!error && !this.protocolChanges.isEnabled(action, tx.block_index))
            error = 'invalid: ACTION is not yet activated';

        // Create a record of this transaction in the transactions table
        // createTxIndex(data);

        // Get tx_index of record using tx_hash
        // data['TX_INDEX'] = getTxIndex(data['TX_HASH']);

        // Process the specific BTNS ACTION commands
        await this.processAction(action, params, data, error);
    }

    // Generalized function to handle processing a specific ACTION
    async processAction(action, params, data, error){
        // coming soon...
    }

}

module.exports = Actions;
