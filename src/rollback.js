/* XChain Indexer Rollback Class */

class Rollback {

    // Handle constructing a class instance
    constructor(indexer){
        // Parse in indexer configuration
        this.config    = indexer.config;

        // Setup alias to the indexer database connection
        this.decoderDb = indexer.decoderDb;
        this.indexerDb = indexer.indexerDb;

        // Setup alias to the utility class
        this.util      = indexer.util;

        // Setup alias to the indexer protocol changes instance
        this.protocolChanges = indexer.protocolChanges;

        // Define list of database tables to do rollback on
        this.dataTables = [
            'addresses',
            'airdrops',
            'batches',
            'blocks',
            'callbacks',
            'credits',
            'debits',
            'destroys',
            'dividends',
            'dispensers',
            'dispenses',
            'fees',
            'issues',
            'lists',
            'mints',
            'sends',
            'sweeps',
            'tokens',
            'transactions'
        ];
    }

    async rollback(block_index){
        // Start tracking time of rollback
        var rollbackTimer = this.util.startTimer();

        // Notify user of start of rollback
        console.log('Starting rollback to block ' + block_index + '...');

        // Reset the address/tickers/transactions lists
        this.util.resetLists();

        // Loop through all database tables
        for(let table of this.dataTables){

            // Build out the correct SQL to pull data from the various tables
            let query = false;

            // Credits / Debits
            if(['credits','debits'].includes(table)){
                query = `SELECT 
                            a.address, 
                            t2.tick
                        FROM 
                            ` + table + ` t1, 
                            index_tickers t2,
                            index_addresses a
                        WHERE 
                            t2.id=t1.tick_id AND 
                            a.id=t1.address_id AND
                            t1.block_index > ?`;
            }

            // AIRDROP / DESTROY
            if(['airdrops','destroys'].includes(table)){
                query = `SELECT 
                            a.address, 
                            t2.tick
                        FROM 
                            ` + table + ` t1, 
                            index_tickers t2,
                            index_addresses a
                        WHERE 
                            t2.id=t1.tick_id AND 
                            a.id=t1.source_id AND
                            t1.block_index > ?`;
            }

            // MINT / SEND / FEE
            if(['mints','sends','fees'].includes(table)){
                query = `SELECT 
                            t2.tick,
                            a.address,
                            a2.address as address2
                        FROM 
                            ` + table + ` t1
                            LEFT JOIN index_addresses a2 on (t1.destination_id=a2.id),
                            index_tickers t2,
                            index_addresses a
                        WHERE 
                            t2.id=t1.tick_id AND 
                            a.id=t1.source_id AND
                            t1.block_index > ?`;
            }

            // ISSUE
            if(table=='issues'){
                query = `SELECT 
                            t2.tick,
                            a.address,
                            a2.address as address2,
                            a3.address as address3
                        FROM 
                            ` + table + ` t1
                            LEFT JOIN index_addresses a2 on (t1.transfer_id=a2.id)
                            LEFT JOIN index_addresses a3 on (t1.transfer_supply_id=a3.id),
                            index_tickers t2,
                            index_addresses a
                        WHERE 
                            t2.id=t1.tick_id AND 
                            a.id=t1.source_id AND
                            t1.block_index > ?`;
            }

            // Get list of transactions associated with the rollback blocks
            if(table=='transactions'){
                query = `SELECT 
                            tx_hash_id 
                        FROM 
                            transactions 
                        WHERE 
                            block_index > ?`;
            }

            // Run the query and populate the addresses, tickers, and transactions arrays
            if(query){
                let rows = await this.indexerDb.doQuery(query, block_index);
                for(let row of rows){
                    if(table=='transactions'){
                        this.util.addTransaction(row.tx_hash_id);
                    } else {
                        this.util.addAddressTicker(row.address, row.tick);
                        if(!this.util.isNull(row.address2))
                            this.util.addAddressTicker(row.address2, row.tick);
                        if(!this.util.isNull(row.address3))
                            this.util.addAddressTicker(row.address3, row.tick);
                    }
                }
            }

            // Delete data from rollback blocks
            query = `DELETE FROM ` + table + ` WHERE block_index > ?`;
            let result = await this.indexerDb.doQuery(query, block_index);
        } 

        // Get lists of addresses, tickers, and transactions
        let addresses    = this.util.getAddressesList();
        let tickers      = this.util.getTickersList();
        let transactions = this.util.getTransactionsList();

        // DEBUG : Full balances update
        // await this.indexerDb.updateBalances(true, true);

        // Update address balances to get back to sane balances based on credits/debits
        await this.indexerDb.updateBalances(Object.keys(addresses), true);

        // Update token information
        await this.indexerDb.updateTokens(tickers, true);

        // Delete items from list_{items,edits} tables
        await this.indexerDb.deleteLists(transactions, true);

        // Log the rollback time
        this.util.logTimer(rollbackTimer, 'Rollback Done');
    }
}

module.exports = Rollback;
