/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Indexer - Indexer Class
 * 
 * This file handles starting the indexer and parsing blocks and actions
 *
 ********************************************************************/

// Load required libraries
const config   = require('./config.js');
const changes  = require('./protocol_changes.js');
const database = require('./db.js');
const actions  = require('./actions.js');
const util     = require('./utility.js');
const rollback = require('./rollback.js');
const mapper   = require('./mapper.js');

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

        // Create instance of the mapper class
        this.mapper = new mapper(this);

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
        let firstDecoderBlock     = null;
        let lastIndexerBlock      = null; 
        let lastDecoderBlock      = null;
        let lastDecoderReorgBlock = null;
        let lastIndexerReorgBlock = null;

        while (true){
            // Bail out if stop is requested
            if(this.stopFlag)
                break;

            // Get last processed block from Indexer and Decoder databases
            lastDecoderBlock  = await this.decoderDb.getBlockIndex('decoder', 'last');
            lastIndexerBlock  = await this.indexerDb.getBlockIndex('indexer', 'last');

            // If indexer has no parsed blocks, set firstDecoderBlock from Decoder database
            if(!lastIndexerBlock)
                firstDecoderBlock = await this.decoderDb.getBlockIndex('decoder', 'first');

            // Get last reorg block from Indexer and Decoder databases
            lastDecoderReorgBlock = await this.decoderDb.getBlockIndex('decoder', 'reorg');
            lastIndexerReorgBlock = await this.indexerDb.getBlockIndex('indexer', 'reorg');

            // Handle block reorgs
            if(lastDecoderReorgBlock && (!lastIndexerReorgBlock || lastDecoderReorgBlock < lastIndexerReorgBlock)){
                console.log("Detected block reorganization at block #",lastDecoderReorgBlock);
                await this.indexerDb.createReorg(lastDecoderReorgBlock);
                await this.rollback.rollback(lastDecoderReorgBlock);
            }

            // Log block parsing start
            var startBlock = (lastIndexerBlock) ? (lastIndexerBlock+1) : firstDecoderBlock;

            // Print out status message about where parsing is resuming
            if(startBlock < lastDecoderBlock)
                console.log('Resuming block parsing at block ' + startBlock + '...');

            // Loop through blocks until indexer has parsed lastDecoderBlock
            while( (!lastIndexerBlock || lastIndexerBlock < lastDecoderBlock )){

                // Set flag to indicate not fully synced
                this.synced = false;

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

                // Get a list of any transactions in this block from the decoder database
                let blockTransactions = await this.decoderDb.getDecoderBlockData(lastIndexerBlock);

                // Loop through any block transactions and process them
                for(const tx of blockTransactions)
                    await this.actions.processTransaction(tx);

                // Lookup the block time for a given block
                let blockTime = await this.decoderDb.getBlockTime(lastIndexerBlock);

                // Check for any expired items (orders, swaps, dispensers)
                await this.util.processExpirations(this.actions, this.indexerDb, lastIndexerBlock, blockTime);

                // Check for any cancelled items (dispensers)
                await this.util.processCancellations(this.actions, this.indexerDb, lastIndexerBlock, blockTime);

                // Create record in `blocks` table with hashes of the credits/debits/escrows (ledger) and /actions tables
                let [ledger, actions] = await this.indexerDb.createBlock(lastIndexerBlock, blockTime);

                // Create / Update DEX market information
                await this.util.processMarketUpdates(this.indexerDb, lastIndexerBlock, blockTime);

                // Do a sanity check to verify that token supplies match data in credits/debits/escrows/balances tables 
                await this.indexerDb.sanityCheck(lastIndexerBlock);

                // Log the total parse time for this block
                let parseTime = this.util.getTimer(debugTimer);
                console.log('Block Parsed' + "\t: " + lastIndexerBlock + ' [ledger:' + ledger + ' actions:' + actions + '] (' + parseTime + ')');

                // DEBUG : Exit processing at a select block
                // if(lastIndexerBlock >=  862672){
                //     await this.rollback.rollback(862663);
                //     this.util.throwError('Exiting on target block');
                // }

            }

            // Set flag to indicate fully synced and listening for block
            if(!this.synced){
                this.synced = true;
                console.log('Listening for blocks...');
            }

            // Sleep for BLOCK_CHECK_INTERVAL before checking for new transaction data
            await this.util.sleep(this.config['BLOCK_CHECK_INTERVAL']);
        }      
    }

}

module.exports = XChainIndexer;
