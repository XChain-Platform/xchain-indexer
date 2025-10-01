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

        // List of tables that store data using block_index
        this.blockTables = [
            'blocks',
            'transactions'
        ];

        // List of tables that store data using action_index
        this.dataTables = [
            'actions',
            'addresses',
            'airdrops',
            'batches',
            'callbacks',
            'credits',
            'debits',
            'destroys',
            'dispensers',
            'dispenser_refills',
            'dispenses',
            'dividends',
            'escrows',
            'fees',
            'issues',
            'lists',
            'list_edits',
            'list_items',
            'list_items_invalid',
            'mappings_actions',
            'mappings_files',
            'mints',
            'orders',
            'order_cancels',
            'order_edits',
            'order_matches',
            'order_statuses',
            'sends',
            'sleeps',
            'swaps',
            'swap_cancels',
            'swap_edits',
            'swap_matches',
            'swap_statuses',
            'sweeps',
            'tokens'
        ];

    }

    // Handle rolling back data to a specific block
    async rollback(block_index){
        // Start tracking time of rollback
        var rollbackTimer = this.util.startTimer();

        // Notify user of start of rollback
        console.log('Starting rollback to block ' + block_index + '...');

        // Reset the address/tickers/transactions lists
        this.util.resetLists();

        // Placeholder for the first action_index
        let firstActionIndex = false;

        // Get the first action_index after the given block
        let query = `SELECT 
                        a.action_index
                    FROM
                        actions a
                        INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                    WHERE
                        t.block_index > ?
                    ORDER BY
                        a.action_index ASC
                    LIMIT 1`;
        let args = [block_index];
        let rows = await this.indexerDb.doQuery(query, args);
        if(rows.length > 0)
            firstActionIndex = Number(rows[0].action_index);

        // Handle looking up data for any action_indexes in the rollback
        if(firstActionIndex){

            // Loop through the data tables
            for(let table of this.dataTables){

                // Build out the correct SQL to pull address and ticker data from the various tables
                query = false;
                args  = [firstActionIndex];

                // Credits / Debits / Escrows
                if(['credits','debits','escrows'].includes(table)){
                    query = `SELECT 
                                t1.tick,
                                a1.address
                            FROM 
                                ` + table + ` m
                                INNER JOIN index_tickers   t1 ON (t1.id=m.tick_id)
                                INNER JOIN index_addresses a1 ON (a1.id=m.address_id)
                            WHERE 
                                m.action_index >= ?`;
                }

                // AIRDROP / DESTROY
                if(['airdrops','destroys'].includes(table)){
                    query = `SELECT 
                                t1.tick,
                                a1.address
                            FROM 
                                ` + table + ` m
                                INNER JOIN index_tickers   t1 ON (t1.id=m.tick_id)
                                INNER JOIN index_addresses a1 ON (a1.id=m.source_id)
                            WHERE 
                                m.action_index >= ?`;
                }

                // MINT / SEND / FEE
                if(['mints','sends','fees'].includes(table)){
                    query = `SELECT 
                                t1.tick,
                                a1.address,
                                a2.address as address2
                            FROM 
                                ` + table + ` m
                                INNER JOIN index_tickers   t1 ON (t1.id=m.tick_id)
                                INNER JOIN index_addresses a1 ON (a1.id=m.source_id)
                                LEFT  JOIN index_addresses a2 ON (a2.id=m.destination_id)
                            WHERE 
                                m.action_index >= ?`;
                }

                // ISSUE
                if(table=='issues'){
                    query = `SELECT 
                                t1.tick,
                                a1.address,
                                a2.address as address2,
                                a3.address as address3
                            FROM 
                                ` + table + ` m
                                INNER JOIN index_tickers   t1 ON (t1.id=m.tick_id)
                                INNER JOIN index_addresses a1 ON (a1.id=m.source_id)
                                LEFT  JOIN index_addresses a2 ON (a2.id=m.transfer_id)
                                LEFT  JOIN index_addresses a3 ON (a3.id=m.transfer_supply_id)
                            WHERE 
                                m.action_index >= ?`;
                }

                // SWAPS
                if(table=='swaps'){
                    query = `SELECT 
                                t1.tick,
                                a1.address
                            FROM 
                                ` + table + ` m
                                INNER JOIN index_tickers   t1 ON (t1.id=m.give_tick_id)
                                INNER JOIN index_addresses a1 ON (a1.id=m.source_id)
                            WHERE 
                                m.action_index >= ?`;
                }

                // Run the query and populate the addresses and tickers arrays
                if(query){
                    let rows = await this.indexerDb.doQuery(query, args);
                    for(let row of rows){
                        this.util.addAddressTicker(row.address, row.tick);
                        if(!this.util.isNull(row.address2))
                            this.util.addAddressTicker(row.address2, row.tick);
                        if(!this.util.isNull(row.address3))
                            this.util.addAddressTicker(row.address3, row.tick);
                    }
                }

                // Delete data from tables using action_index
                query = `DELETE FROM ` + table + ` WHERE action_index >= ?`;
                args  = [firstActionIndex];
                let result = await this.indexerDb.doQuery(query, args);

            } 
        }

        // Delete data from tables using block_index
        for(let table of this.blockTables){
            query = `DELETE FROM ` + table + ` WHERE block_index > ?`;
            args  = [block_index];
            let result = await this.indexerDb.doQuery(query, args);
        }

        // Get lists of addresses, tickers, and transactions
        let addresses = this.util.getAddressesList();
        let tickers   = this.util.getTickersList();

        // DEBUG : Full balances and token updates
        // await this.indexerDb.updateBalances(true, true);
        // await this.indexerDb.updateTokens(true, true);

        // Update address balances to get back to sane balances based on credits/debits
        await this.indexerDb.updateBalances(Object.keys(addresses), true);

        // Update token information
        await this.indexerDb.updateTokens(tickers, true);

        // Do a sanity check to verify that token supplies match data in credits/debits/balances tables 
        await this.indexerDb.sanityCheck(block_index);

        // Log the rollback time
        this.util.logTimer(rollbackTimer, 'Rollback Done');
    }
}

module.exports = Rollback;
