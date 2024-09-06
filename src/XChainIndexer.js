/* XChain Indexer Class */

const Database = require('./db.js');
const util     = require('./util.js');

class XChainIndexer {
    constructor(decoderDbHost, decoderDbPort, decoderDbName, decoderDbUser, decoderDbPass, indexerDbHost, indexerDbPort, indexerDbName, indexerDbUser, indexerDbPass){
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
        this.debugTime = {};
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
        // Establish database connections
        this.decoderDb = new Database(this.decoderDbHost, this.decoderDbPort, this.decoderDbName, this.decoderDbUser, this.decoderDbPass);
        this.indexerDb = new Database(this.indexerDbHost, this.indexerDbPort, this.indexerDbName, this.indexerDbUser, this.indexerDbPass);
        
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

        // Get first block from decoder
        let firstDecoderBlock = await this.decoderDb.getBlockIndex('decoder','first');

        // Define placeholders for block parsing status
        let lastIndexerBlock  = null; 
        let lastDecoderBlock  = null;
        let lastRollbackBlock = null;

        // Get first decoder block index

        
        // if (lastProcessedBlockIndex < this.startBlockIndex - 1){
        //   lastProcessedBlockIndex = this.startBlockIndex - 1
        // }
        
        // let lastBlockchainInfo = null
        // this.blockchainInfoLastBlock = -1
        //   let blocksQuantity = 0
        
        // let startTimeStamp = Date.now()
        
        // let blocksCount = 0
        // let transactionsCount = 0
        // let validTransactionsCount = 0
        // let outputCount = 0      

        while (true){
            // Bail out if stop is requested
            if(this.stopFlag)
                break;

            // Get last processed and rollback block from Indexer database
            lastDecoderBlock         = await this.decoderDb.getBlockIndex('decoder', 'last');
            // lastDecoderRollbackBlock = await this.decoderDb.getBlockIndex('decoder', 'rollback');

            // Get last processed block from Decoder database
            lastIndexerBlock         = await this.indexerDb.getBlockIndex('indexer', 'last');
            // lastIndexerRollbackBlock = await this.indexerDb.getBlockIndex('indexer', 'rollback');

            console.log('firstDecoderBlock=',firstDecoderBlock);
            console.log('lastDecoderBlock=',lastDecoderBlock);
            console.log('lastIndexerBlock=',lastIndexerBlock);
            // console.log('lastRollbackBlock=',lastRollbacBlock);

            // Get last block parsed from database 
            if (!lastIndexerBlock || (lastDecoderBlock > lastIndexerBlock)){
              try {
                // lastBlockchainInfo = await this.decoderDb.getBlockData();
                
            //     this.blockchainInfoLastBlock = lastBlockchainInfo["blocks"]
              } catch (e){
                console.log(e);
                console.log("Error trying to get block info from the decoder. Trying again...");
                await util.sleep(3000);
                continue;
              }
              
            //   if (lastProcessedBlockIndex > this.blockchainInfoLastBlock){
            //     console.log("The last processed block height ("+lastProcessedBlockIndex+") is greater than the last block from the node ("+this.blockchainInfoLastBlock+")")
            //     await sleep(5000)
            //     continue
            //   }
            }

            console.log('sleeping for 5 seconds');
            await util.sleep(5000);
        }      

    }

}

module.exports = XChainIndexer;
