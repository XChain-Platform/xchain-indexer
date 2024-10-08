/* XChain Indexer Class */

const database = require('./db.js');
const actions  = require('./actions.js');
const util     = require('./util.js');

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

        // Establish database connections
        this.decoderDb = new database(this.decoderDbHost, this.decoderDbPort, this.decoderDbName, this.decoderDbUser, this.decoderDbPass);
        this.indexerDb = new database(this.indexerDbHost, this.indexerDbPort, this.indexerDbName, this.indexerDbUser, this.indexerDbPass);

        // Create instance of the actions class and pass database connection instances to it
        this.actions = new actions(this.decoderDb, this.indexerDb);
        
        // Verify the Decoder database exists
        let decoderDbStatus   = await this.decoderDb.createDatabase();
        let decoderDbVerified = await this.decoderDb.verifyDatabase();
        if(!decoderDbVerified){
            util.throwError("Database " + this.decoderDbName + " doesn't exist!");
        } else {
            // Add optional code here to verify decoder database tables exist (Blocks / Transactions)
        }

        // Verify the Indexer database exists
        let indexerDbStatus   = await this.indexerDb.createDatabase();
        let indexerDbVerified = await this.indexerDb.verifyDatabase();
        if(!indexerDbVerified){
            util.throwError("Database " + this.indexerDbName + " doesn't exist!");
        } else {
            // Verify the Indexer tables exists
            let indexerTablesVerified = await this.indexerDb.verifyTables();
            if(!indexerTablesVerified)
                util.throwError("Database " + this.decoderDbName + " tables don't exist!");
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
            console.log('Resuming block parsing at block ' + startBlock + '...');

            var cnt = 0;

            // Loop through blocks until indexer has parsed lastDecoderBlock
            while( (!lastIndexerBlock || lastIndexerBlock < lastDecoderBlock )){

                // Start tracking time to parse block
                var debugTimer = util.startTimer();

                // If indexer has no parsed blocks, set block to first Decoder block -1
                if(!lastIndexerBlock)
                    lastIndexerBlock = firstDecoderBlock - 1;

                // Increase lastIndexerBlock to next block
                lastIndexerBlock++;

                // Get a list of any transactions in this block from the decoder database
                let blockTransactions = await this.decoderDb.getBlockData(lastIndexerBlock);

                // Loop through any block transactions and process them
                for(const tx of blockTransactions)
                    await this.actions.processTransaction(tx);

                // Create record in `blocks` table with hashes of the credits/debits/transactions tables
                await this.indexerDb.createBlock(lastIndexerBlock);

                // Do a sanity check to verify that token supplys match data in credits/debits/balances tables 
                // await util.sanityCheck(lastIndexerBlock);
                // await util.sleep(3500);

                // Log the debug time
                util.logTimer(debugTimer, 'Block Parsed');

                // DEBUG: counter to enable stopping parsing after a set number of blocks
                // cnt++;
                // if(cnt>=1)
                //     break;
            }

            console.log('sleeping for 5 seconds');
            // Sleep for 5 seconds before checking for new transaction data
            await util.sleep(5000);
        }      
    }

}

module.exports = XChainIndexer;
