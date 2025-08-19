/* XChain Indexer Class */

const config   = require('./config.js');
const changes  = require('./protocol_changes.js');
const database = require('./db.js');
const actions  = require('./actions.js');
const util     = require('./util.js');
const rollback = require('./rollback.js');

class XChainIndexer {

    // Handle constructing a class instance
    constructor(decoderDbHost, decoderDbPort, decoderDbName, decoderDbUser, decoderDbPass, indexerDbHost, indexerDbPort, indexerDbName, indexerDbUser, indexerDbPass){
        // XChain Indexer Version
        this.version = process.env.npm_package_version;
        this.name    = process.env.npm_package_name;

        // Decoder database config
        this.decoderDbHost = decoderDbHost;
        this.decoderDbPort = decoderDbPort;
        this.decoderDbName = decoderDbName;
        this.decoderDbUser = decoderDbUser;
        this.decoderDbPass = decoderDbPass;

        // Indexer database config
        this.indexerDbHost = indexerDbHost;
        this.indexerDbPort = indexerDbPort;
        this.indexerDbName = indexerDbName;
        this.indexerDbUser = indexerDbUser;
        this.indexerDbPass = indexerDbPass;

        // Placeholders for database connections
        this.decoderDb = null;
        this.indexerDb = null;

        // Misc placeholders
        this.synced    = false;
        this.stopFlag  = false
        this.blockchainInfoLastBlock = -1
    }

    // Handle indicating if indexer is synced
    isSynced(){
        return this.synced;
    }

    // Handle setting flag to stop indexer
    stop(){
        this.stopFlag = true;
    }

    // Handle starting up the XChain indexer
    async start(){
        console.log('Starting up ' + this.name + ' v' + this.version + '...');

        // Get indexer configuration
        this.config = config.getConfig();

        // Create instance of the utility class
        this.util = new util();

        // Establish database connections
        this.decoderDb = new database(this.decoderDbHost, this.decoderDbPort, this.decoderDbName, this.decoderDbUser, this.decoderDbPass, this);
        this.indexerDb = new database(this.indexerDbHost, this.indexerDbPort, this.indexerDbName, this.indexerDbUser, this.indexerDbPass, this);

        // Create instance of the protocol changes class
        this.protocolChanges = new changes(this);

        // Create instance of the actions class and pass database connection instances to it
        this.actions = new actions(this);
        
        // Create instance of the rollback class and pass database connection instances to it
        this.rollback = new rollback(this);

        // Verify the Decoder database exists
        let decoderDbStatus   = await this.decoderDb.createDatabase();
        let decoderDbVerified = await this.decoderDb.verifyDatabase();
        if(!decoderDbVerified){
            this.util.throwError("Database " + this.decoderDbName + " doesn't exist!");
        } else {
            // Add optional code here to verify decoder database tables exist (Blocks / Transactions)
        }

        // Verify the Indexer database exists
        let indexerDbStatus   = await this.indexerDb.createDatabase();
        let indexerDbVerified = await this.indexerDb.verifyDatabase();
        if(!indexerDbVerified){
            this.util.throwError("Database " + this.indexerDbName + " doesn't exist!");
        } else {
            // Verify the Indexer tables exists
            let indexerTablesVerified = await this.indexerDb.verifyTables();
            if(!indexerTablesVerified)
                this.util.throwError("Database " + this.decoderDbName + " tables don't exist!");
        }

        // Define placeholders for block parsing status
        let firstDecoderBlock        = null;
        let lastIndexerBlock         = null; 
        let lastDecoderBlock         = null;
        let lastDecoderRollbackBlock = null;
        let lastIndexerRollbackBlock = null;

        while (true){
            // Bail out if stop is requested
            if(this.stopFlag)
                break;

            // Get last processed block from Indexer and Decoder databases
            lastDecoderBlock  = await this.decoderDb.getBlockIndex('decoder', 'last');
            lastIndexerBlock  = await this.indexerDb.getBlockIndex('indexer', 'last');

            // TODO: Write rollback detection code
            // Get last rollback block from Indexer and Decoder databases
            // lastDecoderRollbackBlock = await this.indexerDb.getBlockIndex('decoder', 'rollback');
            // lastIndexerRollbackBlock = await this.indexerDb.getBlockIndex('indexer', 'rollback');

            // If indexer has no parsed blocks, set firstDecoderBlock from Decoder database
            if(!lastIndexerBlock)
                firstDecoderBlock = await this.decoderDb.getBlockIndex('decoder', 'first');

            // Log block parsing start
            var startBlock = (lastIndexerBlock) ? (lastIndexerBlock+1) : firstDecoderBlock;

            // DEBUG
            // startBlock = lastIndexerBlock = 862602;

            // Print out status message about where parsing is resuming
            if(startBlock < lastDecoderBlock)
                console.log('Resuming block parsing at block ' + startBlock + '...');

            var cnt = 0;
            // lastIndexerBlock = 862605;

            // Loop through blocks until indexer has parsed lastDecoderBlock
            while( (!lastIndexerBlock || lastIndexerBlock < lastDecoderBlock )){

                // If we have no blocks from the decoder stop parsing loop
                if(this.util.isNull(lastDecoderBlock))
                    break;

                // Start tracking time to parse block
                var debugTimer = this.util.startTimer();

                // If indexer has no parsed blocks, set block to first Decoder block -1
                if(this.util.isNull(lastIndexerBlock))
                    lastIndexerBlock = firstDecoderBlock - 1;

                // Increase lastIndexerBlock to next block
                lastIndexerBlock++;

                // DEBUG
                // lastIndexerBlock = startBlock;

                // DEBUG : Rollback to a specific block
                // let rollbackBlock = 862000;
                let rollbackBlock = 862630;
                // if(lastIndexerBlock >= rollbackBlock){
                //     await this.rollback.rollback(rollbackBlock);
                //     this.util.throwError('Rolled back to ' + rollbackBlock);
                // }

                // Get a list of any transactions in this block from the decoder database
                let blockTransactions = await this.decoderDb.getDecoderBlockData(lastIndexerBlock);

                // Loop through any block transactions and process them
                for(const tx of blockTransactions)
                    await this.actions.processTransaction(tx);

                // TODO : Look for swaps/orders/dispensers that are past EXPIRATION

                // Lookup the block time for a given block
                let blockTime = await this.decoderDb.getBlockTime(lastIndexerBlock);

                // Create record in `blocks` table with hashes of the credits/debits/actions tables
                let [credits, debits, actions] = await this.indexerDb.createBlock(lastIndexerBlock, blockTime);

                // Do a sanity check to verify that token supplies match data in credits/debits/balances tables 
                await this.indexerDb.sanityCheck(lastIndexerBlock);

                // Log the total parse time for this block
                let parseTime = this.util.getTimer(debugTimer);
                console.log('Block Parsed' + "\t: " + lastIndexerBlock + ' [credits:' + credits + ' debits:' + debits + ' actions:' + actions + '] (' + parseTime + ')');

                // DEBUG: counter to enable stopping parsing after a set number of blocks
                cnt++;

                // DEBUG : Exit processing at a select block
                if(lastIndexerBlock >= 862636){
                    // await this.rollback.rollback(rollbackBlock);
                    this.util.throwError('Exiting on target block');
                }

                // DEBUG: Delay processing after X blocks
                // if(cnt>=1)
                //     break;

                // DEBUG: Test some rollbacks
                // if(cnt>=3){
                //     await this.rollback.rollback(lastIndexerBlock-1);
                //     break;
                // }

            }

            console.log('sleeping for 5 seconds');
            // Sleep for 5 seconds before checking for new transaction data
            await this.util.sleep(5000);
        }      
    }

}

module.exports = XChainIndexer;
