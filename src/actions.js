/* XChain Indexer Actions Class */

/* XChain Indexer Actions */
const address   = require('./actions/address.js');
// const airdrop   = require('./actions/airdrop.js');
const batch     = require('./actions/batch.js');
// const bet       = require('./actions/bet.js');
// const callback  = require('./actions/callback.js');
// const destroy   = require('./actions/destroy.js');
// const dispenser = require('./actions/dispenser.js');
// const dividend  = require('./actions/dividend.js');
const issue     = require('./actions/issue.js');
const list      = require('./actions/list.js');
const mint      = require('./actions/mint.js');
// const rug       = require('./actions/rug.js');
// const sleep     = require('./actions/sleep.js');
const send      = require('./actions/send.js');
// const sweep     = require('./actions/sweep.js');

class Actions {

    // Handle constructing a class instance
    constructor(indexer){
        // Parse in indexer configuration
        this.config    = indexer.config;

        // Setup alias to the utility class instance
        this.util      = indexer.util;

        // Setup alias to the indexer database connection
        this.decoderDb = indexer.decoderDb;
        this.indexerDb = indexer.indexerDb;

        // Setup alias to the indexer protocol changes instance
        this.protocolChanges = indexer.protocolChanges;

        // Create action instances and pass database connections
        this.actionAddress      = new address(this);
        // this.actionAirdrop   = new airdrop(this);
        this.actionBatch     = new batch(this);
        // this.actionBet       = new bet(this;
        // this.actionCallback  = new callback(this);
        // this.actionDestroy   = new destroy(this);
        // this.actionDispenser = new dispenser(this);
        // this.actionDividend  = new dividend(this);
        this.actionIssue     = new issue(this);
        this.actionList      = new list(this);
        this.actionMint      = new mint(this);
        // this.actionRug       = new rug(this);
        // this.actionSleep     = new sleep(this);
        this.actionSend      = new send(this);
        // this.actionSweep     = new sweep(this);

        // Define ACTION aliases
        this.actionAliases = {};
        this.actionAliases['TRANSFER'] = 'SEND';    // Legacy BRC20 format
        this.actionAliases['DEPLOY']   = 'ISSUE';   // Legacy BRC20 format
        this.actionAliases['ADDR']     = 'ADDRESS'; // Short alias

    }

    // Generalized function to handle processing a transaction
    // @param tx             object     Transaction object
    // @param tx.source      string     Source address
    // @param tx.data        string     Action `data`
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

        // Support legacy ACTION format with no VERSION (default to VERSION 0)
        if(['ISSUE','MINT','SEND'].includes(action) && this.util.isLegacyActionFormat(params))
            params.splice(0,0,0);

        // Define basic ACTION transaction data object
        let data = {};
        data['ACTION']      = action;      // Action (ISSUE, MINT, SEND, etc)
        data['BLOCK_INDEX'] = block_index; // Block index 
        data['SOURCE']      = source;      // Source address
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
        data['TX_INDEX'] = await this.indexerDb.createTxIndex(data);

        // Process the specific ACTION commands
        await this.processAction(action, params, data, error);
    }

    // Generalized function to handle parsing and processing a specific ACTION
    // NOTE: If the action is UNKNOWN, fail silently (prevent crashing indexer on unsupported actions)
    async processAction(action, params, data, error){
        if(action=='ADDRESS')   await this.actionAddress.parse(params, data, error);
        // if(action=='AIRDROP')   await this.actionAirdrop.parse(params, data, error);
        if(action=='BATCH')     await this.actionBatch.parse(params, data, error);
        // if(action=='BET')       await this.actionBet.parse(params, data, error);
        // if(action=='CALLBACK')  await this.actionCallback.parse(params, data, error);
        // if(action=='DESTROY')   await this.actionDestroy.parse(params, data, error);
        // if(action=='DISPENSER') await this.actionDispenser.parse(params, data, error);
        // if(action=='DIVIDEND')  await this.actionDividend.parse(params, data, error);
        if(action=='ISSUE')     await this.actionIssue.parse(params, data, error);
        if(action=='LIST')      await this.actionList.parse(params, data, error);
        if(action=='MINT')      await this.actionMint.parse(params, data, error);
        // if(action=='RUG')       await this.actionRug.parse(params, data, error);
        // if(action=='SLEEP')     await this.actionSleep.parse(params, data, error);
        if(action=='SEND')      await this.actionSend.parse(params, data, error);
        // if(action=='SWEEP')     await this.actionSweep.parse(params, data, error);
    }

}

module.exports = Actions;
