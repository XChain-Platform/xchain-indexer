/* XChain Indexer Class */

const Database = require('./db.js');

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

    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    markTime(timeName){
        this.debugTime[timeName] = Date.now()
    }
    
    logTime(timeName){
        let endTime = Date.now()
        let msTime  = (endTime - this.debugTime[timeName])
        console.log("Time('"+timeName+"'): "+(msTime)+"ms")
    }
    
    millisecondsToTimeString(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
            seconds      = Math.floor((ms / 1000) % 60),
            minutes      = Math.floor((ms / (1000 * 60)) % 60),
            hours        = Math.floor((ms / (1000 * 60 * 60)) % 24),
            days         = Math.floor((ms / (1000 * 60 * 60 * 24)) % 365);
  
        hours   = (hours < 10) ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;
  
        return days+"d"+ hours + "h" + minutes + "m" + seconds + "." + milliseconds+"s";
    }
    
    isSynced(){
        return this.synced;
    }

    stop(){
        this.stopFlag = true
    }

    // Handle throwing an error and logging to console
    throwError(error){
        console.log(error);
        throw new Error(error);
    }

    // Handle starting up the XChain indexer
    async start(){
        // Establish database connections
        this.decoderDb = new Database(this.decoderDbHost, this.decoderDbPort, this.decoderDbName, this.decoderDbUser, this.decoderDbPass);
        this.indexerDb = new Database(this.indexerDbHost, this.indexerDbPort, this.indexerDbName, this.indexerDbUser, this.indexerDbPass);
        
        // Verify the Decoder database exists
        await this.decoderDb.createDatabase();
        let decoderDbVerified = this.decoderDb.verifyDatabase();
        if(!decoderDbVerified){
            this.throwError("Database " + this.decoderDbName + " doesn't exist!");
        } else {
            // Add optional code here to verify decoder database tables exist (Blocks / Transactions)
        }

        // Verify the Indexer database exists
        await this.indexerDb.createDatabase();
        let indexerDbVerified = this.indexerDb.verifyDatabase();
        if(!indexerDbVerified){
            this.throwError("Database " + this.indexerDbName + " doesn't exist!");
        } else {
            let indexerTablesVerified = this.indexerDb.verifyTables();
            if(!indexerTablesVerified){
                await this.indexerDb.createTables();
                indexerTablesVerified = this.indexerDb.verifyTables();
                if(!indexerTablesVerified){
                    this.throwError("Database " + this.indexerDbName + " tables don't exist!");
                }
            }
        }

        // Make sure the Indexer database exists
        // let dbVerified = await this.db.verifyDatabaseExists()
        // if (!dbVerified){
        //   console.log("Database doesn't exist!!!!")
        //   throw new Error("Database "+this.dbName+" doesn't exist")
        // }
      
        // console.log("Connected to database!")
        // console.log("Parsing...")
        
        // let lastProcessedBlockIndex = await this.db.getLastBlock()
        // let lastProcessedTxIndex = -1
        
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
            // Get last block parsed from database 
            // if (!lastBlockchainInfo || (lastProcessedBlockIndex >= this.blockchainInfoLastBlock)){
            //   try {
            //     lastBlockchainInfo = await this.connector.getBlockchainInfo()
                
            //     this.blockchainInfoLastBlock = lastBlockchainInfo["blocks"]
            //   } catch (e){
            //     console.log(e)
            //     console.log("Error trying to get network info from the node. Trying again...")
            //     await this.sleep(3000)
            //     continue
            //   }
              
            //   if (lastProcessedBlockIndex > this.blockchainInfoLastBlock){
            //     console.log("The last processed block height ("+lastProcessedBlockIndex+") is greater than the last block from the node ("+this.blockchainInfoLastBlock+")")
            //     await sleep(5000)
            //     continue
            //   }
            // }

            console.log('sleeping for 5 seconds');
            await this.sleep(5000);
        }      

    }

}

module.exports = XChainIndexer;
