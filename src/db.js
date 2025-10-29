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
 * XChain Indexer - Database Class
 * 
 * This file handles connecting to databases and running SQL queries
 *
 ********************************************************************/

// Load required libraries
const mariadb = require('mariadb');
const fs      = require('fs');

class Database {

    // Handle constructing a class instance
    constructor(host, port, dbName, user, pass, indexer) {
        // Parse in indexer configuration
        this.config = indexer.config

        // Create instance of the utility class
        this.util   = indexer.util;

        // Database connection information
        this.host   = host;
        this.port   = port;
        this.dbName = dbName;
        this.user   = user;
        this.pass   = pass;

        // Database connection parameters
        this.connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port
        };

        // Database pool connection parameters
        this.connectionPoolParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port,
            // Connection options
            connectionLimit:  5,
            //connectTimeout: 0,
            insertIdAsNumber: true
        };

        // Setup pool of connections
        this.pool = mariadb.createPool(this.connectionPoolParams);
        this.transactionConnection = null;
    }

    /* 
     * Database creation and verification functions 
     */

    // Verify a database exists and return true or false
    async verifyDatabase(){
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port
        };
        while(true){
            try {
                let db     = await mariadb.createConnection(connectionParams);
                let result = await db.query("SELECT * FROM information_schema.schemata WHERE schema_name = ?",[this.dbName]);
                await db.end();
                if(result.length > 0)
                    return true;
                return false;
            } catch (e){
                console.log('e=',e);
                console.log("There was an error trying to check if the " + this.dbName + " database exists. Trying again in a few seconds...");
                await this.util.sleep(5000); // Wait 5 seconds
            }
        }
    }

    // Handle creating a database
    async createDatabase(){
        // First time connecting, do not specify database name or we throw error
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            port:     this.port
        };
        let databaseCreated = false;
        console.log("Creating " + this.dbName + " database!");
        while(!databaseCreated){
            try {
                let db     = await mariadb.createConnection(connectionParams);
                let result = await db.query("CREATE DATABASE IF NOT EXISTS " + this.dbName);
                await db.end();
                databaseCreated = true;
            } catch(e){
                // console.log('e=',e);
                console.log("SQL Error: ", e.sqlMessage);
                console.log("There was an error trying to connect to the " + this.dbName + " database. Trying again in a few seconds...");
                await this.util.sleep(5000); // Waiting 5 seconds
            }
        }
        return true;
    }
    
    // Handle verifying all database tables exist 
    async verifyTables(){
        let path  = '/XChainIndexer/src/sql';
        let files = fs.readdirSync(path);
        let file  = null;
        let db    = await this.getConnection();
        // Loop through SQL files
        for (file of files){
            var isSql = file.indexOf('.sql');
            if(isSql){
                let table   = file.substring(0, file.indexOf('.sql'));
                console.log('Verifying ' + table + ' table exists...');
                try {
                    let result = await db.query("SELECT * FROM information_schema.tables WHERE table_schema = ? AND table_name = ?",[this.dbName, table]);
                    if(result.length > 0){
                        continue;
                    } else {
                        await this.createTable(file);
                    }
                } catch(e){
                    // console.log('e=',e);
                    this.util.throwError('Error while trying to verify ' + table + ' table exists!');
                    return false;
                }
            }
        }
        await this.releaseConnection();
        return true;
    }

    // Handle creating database tables
    async createTable(file){
        let path    = '/XChainIndexer/src/sql';
        let data    = fs.readFileSync(path + '/' + file, "utf8");
        let table   = file.substring(0, file.indexOf('.sql'));
        let db      = await this.getConnection();
        let queries = data.split(';');
        let query   = null;
        console.log('Creating ' + table + ' table and indexes...');
        // Loop through SQL queries
        for(query of queries){
            query = query.trim();
            // Ignore empty queries
            if(query=='')
                continue;
            try {
                let result = await db.query(query);
                if(result.length > 0)
                    continue;
            } catch(e){
                // console.log('e=',e);
                this.util.throwError('Error while trying to create ' + table + ' table!');
            }
        }
        // Dont release connection after each table is created, connection released in verifyTables() after ALL tables created and verified
        // await this.releaseConnection();
    }

    /* 
     * Common database connection functions (connect / rollback / commit / doQuery)
     */

    // Handle getting a database Connection    
    async getConnection(){
        if(this.transactionConnection)
            return this.transactionConnection;
        var connection = null;
        while(connection == null){        
            try {
                connection = await this.pool.getConnection();
                // console.log("Connected to database!");
            } catch (e){
                console.log("Can't connect to mariadb. Trying again...");
                connection = null;
                await this.util.sleep(1000);
            }
        }
        this.transactionConnection = connection;
        return connection;
    }

    // Handle releasing a connection and freeing it up for additional queries
    async releaseConnection(){
        if(this.transactionConnection != null){
            // console.log("releasing database connection");
            await this.transactionConnection.release();
            this.transactionConnection = null;
        }  
    }

    // Handle beginning a SQL transaction
    async beginTransaction(){
        if(this.transactionConnection != null)
            await this.releaseConnection();
        this.transactionConnection = await this.getConnection();
        try {
            await this.transactionConnection.beginTransaction();
        } catch(e){
            this.util.throwError('beginTransaction error=' + e);
        }
    }

    // Handle rolling back a SQL transaction and releasing the connection
    async rollbackTransaction(){
        if(this.transactionConnection != null){
            console.log("rolling back");
            await this.transactionConnection.rollback();
            await this.transactionConnection.release();
            this.transactionConnection = null;
        }  
    }
    
    // Handle commiting a SQL transaction and releasing the connection
    async commitTransaction(){
        if(this.transactionConnection != null){
            try {
                await this.transactionConnection.commit();
                this.transactionConnection.release();
                this.transactionConnection = null;
                return true;
            } catch (e){
                console.log("There was an error trying to commit a transaction");
                this.transactionConnection = null; //the transaction is not valid anymore
            }
        }
        return false;
    }

    // Handle running a query and returning the results
    async doQuery(query, args){
        let result = false;
        if(!this.util.isNull(query)){
            let db     = await this.getConnection();
            let exists = false;
            try {
                result = await db.query(query, args);
            } catch (error){
                this.util.logError('Error running database query :', error);
            }
            await this.releaseConnection();
        }
        return result;
    }

    /* 
     * General database functions
     */

    // Handle Truncating certain data values to fit in database columns 
    truncateDataValues(data){
        let action = (!this.util.isNull(data['ACTION'])) ? data['ACTION'] : 'UNKNOWN';
        // Truncate all memos to 250 characters
        if(!this.util.isNull(data['MEMO']))
            data['MEMO'] = String(data['MEMO']).substring(0,250);
        // Standardize LIST values to numeric value or NULL
        if(['ISSUE','ORDERS','SWAP'].includes(action)){
            for(let list of this.config['LIST_FIELDS'] ){
                if(!this.util.isNull(data[list]) && !this.util.isNumeric(data[list]))
                    data[list] = null;
            }
        }
        // Handle ACTION specific customization
        if(action=='BROADCAST'){
            if(!this.util.isNull(data['MESSSAGE']))  data['MESSAGE'] = String(data['MESSAGE']).substring(0,250);
            if(!this.util.isNull(data['VALUE']))     data['VALUE']   = String(data['VALUE']).substring(0,25);
            if(!this.util.isNull(data['FEE']))       data['FEE']     = String(data['FEE']).substring(0,11);
        } else if(action=='FILE'){
            if(!this.util.isNull(data['NAME']))      data['NAME']    = String(data['NAME']).substring(0,250);
            if(!this.util.isNull(data['TITLE']))     data['TITLE']   = String(data['TITLE']).substring(0,250);
        } else if(action=='ISSUE'){
            // Truncate DESCRIPTION to MAX_TOKEN_DESCRIPTION
            if(!this.util.isNull(data['DESCRIPTION']))  
                data['DESCRIPTION'] = String(data['DESCRIPTION']).substring(0,this.config['MAX_TOKEN_DESCRIPTION']);
        } else if(action=='MESSAGE'){
            // Truncate ENCRYPTION_METHOD to be just 1 character
            if(!this.util.isNull(data['ENCRYPTION_METHOD']))  
                data['ENCRYPTION_METHOD'] = String(data['ENCRYPTION_METHOD']).substring(0,1);
        } else if(action=='SLEEP'){
            // Truncate RESUME_BLOCK to be up to 25 characters
            if(!this.util.isNull(data['RESUME_BLOCK'])) 
                data['RESUME_BLOCK'] = String(data['RESUME_BLOCK']).substring(0,25);
        }
        return data;
    }

    // Handle getting block index for a given component and request type
    async getBlockIndex(component, type){
        // Bail out on any invalid request type
        var componentTypes = ['decoder', 'indexer'];
        if(!componentTypes.includes(component)){
            this.util.logError('Invalid component');
            return false;
        }
        // Bail out on any invalid request type
        var validTypes = ['first', 'last', 'rollback'];
        if(!validTypes.includes(type)){
            this.util.logError('Invalid type');
            return false;
        }
        let db    = await this.getConnection();
        // Define SQL query function to run based on type
        let func  = (type=='first') ? 'MIN' : 'MAX';
        let query = 'SELECT ' + func + '(block_index) AS block_index FROM blocks';
        // Determine SQL query
        if(component=='decoder' && type=='rollback'){
            // Rollback query here
        }
        if(component=='indexer' && type=='rollback'){
            // Rollback query here
        }
        try {
            const rows = await db.query(query);
            if(rows.length > 0){
                return Number(rows[0]["block_index"]);
            } else {
                return -1   
            }
        } catch (error){
            this.util.logError('Error getting block height:', error);
            return false;
        }
        await this.releaseConnection();
    }

    // Handle getting block transaction data for a given block from the Decoder
    async getDecoderBlockData(block_index){
        let db = await this.getConnection();
        // XChain-decoder SQL
        let query = `SELECT
                        t1.data,
                        t2.hash as tx_hash,
                        a1.address as source,
                        t1.block_index,
                        b1.block_time
                    FROM
                        transactions t1
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_addresses    a1 ON (a1.id=t1.source_id)
                    WHERE 
                        t1.block_index=? 
                    ORDER BY 
                        t1.tx_index ASC`;
        try {
            const rows = await db.query(query, [block_index]);
            await db.end();
            return rows;
        } catch (error) {
            this.util.logError('Error getting decoder block data:', error);
            return false;
        }
        await this.releaseConnection();
    }

    // Handle getting block time for a given block
    async getBlockTime(block_index){
        let db = await this.getConnection();
        let query  = `SELECT block_time from blocks where block_index=?`; 
        try {
            const rows = await db.query(query, [block_index]);
            await db.end();
            if(rows.length > 0){
                return rows[0]['block_time'];
            } else {
                return null;
            }            
        } catch (error) {
            this.util.logError('Error getting block time:', error);
            return false;
        }
        await this.releaseConnection();
    }

    // Get block hashes using credits/debits/actions table data and previous hash
    async getBlockHashes(block_index){
        let db      = await this.getConnection();
        let query   = null;
        // Placeholders for actions data
        let actions = [];
        // Placeholer for ledger data (credits + debits + escrows)
        let ledger  = {
            credits:  [],
            debits:   [],
            escrows:  []
        };
        let info    = [];
        let hashes  = [];
        // Get data from credits table
        query = `SELECT
                    c.action_index,
                    c.address_id,
                    c.tick_id,
                    c.amount
                FROM
                    credits c
                    INNER JOIN actions      a ON (a.action_index=c.action_index)
                    INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                WHERE
                    t.block_index=?
                ORDER BY 
                    c.action_index ASC`;
        try {
            ledger.credits = await db.query(query, [block_index]);
        } catch (error){
            this.util.logError('Error getting data from the credits table:', error);
        }
        // Get data from debits table
        query = `SELECT
                    d.action_index,
                    d.address_id,
                    d.tick_id,
                    d.amount
                FROM
                    debits d
                    INNER JOIN actions      a ON (a.action_index=d.action_index)
                    INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                WHERE
                    t.block_index=?
                ORDER BY 
                    d.action_index ASC`;
        try {
            ledger.debits = await db.query(query, [block_index]);
        } catch (error){
            this.util.logError('Error getting data from the debits table:', error);
        }
        // Get data from escrows table
        query = `SELECT
                    e.action_index,
                    e.address_id,
                    e.tick_id,
                    e.amount
                FROM
                    escrows e
                    INNER JOIN actions      a ON (a.action_index=e.action_index)
                    INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                WHERE
                    t.block_index=?
                ORDER BY 
                    e.action_index ASC`;
        try {
            ledger.escrows = await db.query(query, [block_index]);
        } catch (error){
            this.util.logError('Error getting data from the escrows table:', error);
        }
        // Get data from actions table
        query = `SELECT
                    a.action_index,
                    a.tx_index,
                    a.action_id
                FROM
                    actions a
                    INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                WHERE
                    t.block_index=?
                ORDER BY 
                    a.action_index ASC`;
        try {
            actions = await db.query(query, [block_index]);
        } catch (error){
            this.util.logError('Error getting data from the actions table:', error);
        }
        // Subtract one block from current block
        let prev_block_index = block_index -1;
        // Get hashes from the previous block to include in this blocks hash
        query = `SELECT
                t1.hash as ledger,
                t2.hash as actions
            FROM
                blocks b
                LEFT JOIN index_transactions t1 ON (t1.id=b.ledger_hash_id)
                LEFT JOIN index_transactions t2 ON (t2.id=b.actions_hash_id)
            WHERE
                b.block_index=?`;
        try {
            let rows = await db.query(query, [prev_block_index]);
            if(rows.length >0){
                hashes['ledger']  = rows[0].ledger;
                hashes['actions'] = rows[0].actions;
            }
        } catch (error) {
            this.util.logError('Error getting data on the previous block hashes:', error);
        }
        // Define list of data to hash
        let tables = ['ledger','actions'];
        // Loop through the tables, add previous hash to data, then create new block hash
        tables.forEach(table => {
            var data = null;
            if(table=='ledger')  data = ledger;
            if(table=='actions') data = actions;
            // Include the block_index and previous block hash in the hash calculation for this block hash
            data['block_index']   = block_index;
            data['previous_hash'] = hashes[table];
            info[table] = [];
            info[table]['hash'] = this.util.getDataHash(data);
        });
        await this.releaseConnection();
        return info;
    }

    // Lookup a record in the `index_transactions` table and return record id
    async getTransactionId(hash){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_transactions WHERE `hash`=? LIMIT 1"
        try {
            let rows = await db.query(query, [hash]);
            if(rows.length > 0)
                id = Number(rows[0].id);
        } catch (error) {
            this.util.logError('Error looking up hash record id in index_transactions table:', error);
        }
        await this.releaseConnection();
        return id;
    }

    // Create records in the 'index_transactions' table and return record id
    async createTransaction(hash){
        // Ignore empty hash and return NULL
        if(this.util.isNull(hash))
            return null;
        // Truncate to 250 characters
        hash = String(hash).substring(0,250);
        var id = await this.getTransactionId(hash);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            let query = "INSERT INTO index_transactions (`hash`) values (?)"
            try {
                let result = await db.query(query, [hash]);
                if(result.insertId)
                    id = Number(result.insertId);
            } catch (error) {
                this.util.logError('Error trying to create hash record in index_transactions table:', error);
            }
            await this.releaseConnection();
        }
        return id;
    }

    // Lookup a record in the `index_addresses` table and return record id
    async getAddressId(address){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_addresses WHERE `address`=? LIMIT 1"
        try {
            let rows = await db.query(query, [address]);
            if(rows.length > 0)
                id = Number(rows[0].id);
        } catch (error) {
            this.util.logError('Error looking up address record id in index_addresses table:', error);
        }
        await this.releaseConnection();
        return id;
    }

    // Create records in the 'index_addresses' table and return record id
    async createAddress(address){
        // Ignore empty address and return NULL
        if(this.util.isNull(address))
            return null;
        // Truncate to 120 characters
        address = String(address).substring(0,120);
        var id = await this.getAddressId(address);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            let query = "INSERT INTO index_addresses (`address`) values (?)"
            try {
                let result = await db.query(query, [address]);
                if(result.insertId)
                    id = Number(result.insertId);
            } catch (error) {
                this.util.logError('Error trying to create address record in index_addresses table:', error);
            }
            await this.releaseConnection();
        }
        return id;
    }

    // Lookup a record in the `blocks` table and return record id
    async getBlockId(block_index){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM blocks WHERE block_index=? LIMIT 1"
        try {
            let rows = await db.query(query, [block_index]);
            if(rows.length > 0)
                id = Number(rows[0].id);
        } catch (error) {
            this.util.logError('Error looking up block record id in blocks table:', error);
        }
        await this.releaseConnection();
        return id;
    }

    // Handle creating/updating a block in the `blocks` table
    async createBlock(block_index, block_time){
        // Ignore empty hashes and return hardcoded record id
        if(block_index==null||block_index==='')
            return false;
        let block_id = await this.getBlockId(block_index);
        let hashes   = await this.getBlockHashes(block_index);
        // Create transaction hashes in the `index_transactions` table and get the hash id
        let ledger_hash_id  = await this.createTransaction(hashes.ledger.hash);
        let actions_hash_id = await this.createTransaction(hashes.actions.hash);
        // Create data
        let db    = await this.getConnection();
        let query = "INSERT INTO blocks (block_time, ledger_hash_id, actions_hash_id, block_index) values (?, ?, ?, ?)";
        if(block_id!=null){
            query = `UPDATE
                        blocks
                    SET
                        block_time=?,
                        ledger_hash_id=?,
                        actions_hash_id=?
                    WHERE 
                        block_index=?`;
        }
        try {
            let result = await db.query(query, [block_time, ledger_hash_id, actions_hash_id, block_index]);
        } catch (error) {
            this.util.logError('Error trying to create record in blocks table:', error);
        }
        await this.releaseConnection();
        // Display status message
        let ledger  = String(hashes.ledger.hash).substring(0,5);
        let actions = String(hashes.actions.hash).substring(0,5);
        return [ledger, actions];
    }

    // Lookup a record in the `index_actions` table and return record id
    async getActionId(action){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_actions WHERE action=? LIMIT 1";
        try {
            let rows = await db.query(query, [action]);
            if(rows.length > 0)
                id = Number(rows[0].id);
        } catch (error) {
            this.util.logError('Error looking up action record id in index_actions table:', error);
        }
        await this.releaseConnection();
        return id;
    }

    // Create records in the 'index_actions' table and return record id
    async createAction(action){
        var id = await this.getActionId(action);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            let query = "INSERT INTO index_actions (action) values (?)";
            try {
                let result = await db.query(query, [action]);
                if(result.insertId)
                    id = Number(result.insertId);
            } catch (error) {
                this.util.logError('Error trying to create action record in index_actions table:', error);
            }
            await this.releaseConnection();
        }
        return id;
    }

    // Handles returning the highest tx_index from transactions table
    async getNextTxIndex(){
        let idx   = 0;
        let db    = await this.getConnection();
        let query = "SELECT tx_index FROM transactions ORDER BY tx_index DESC LIMIT 1";
        try {
            let rows = await db.query(query);
            if(rows.length > 0)
                idx = Number(rows[0].tx_index);
        } catch (error) {
            this.util.logError('Error looking up tx_index record in transactions table:', error);
        }
        // Increase current tx_index by 1 to get the next tx_index
        idx++;
        await this.releaseConnection();
        return idx;
    }

    // Lookup a record in the `transactions` table and return record id
    async getTxIndex(hash){
        let tx_index = null;
        let hash_id  = await this.createTransaction(hash);
        let db       = await this.getConnection();
        let query = "SELECT tx_index FROM transactions WHERE tx_hash_id=? LIMIT 1";
        try {
            let rows = await db.query(query, [hash_id]);
            if(rows.length > 0)
                tx_index = Number(rows[0].tx_index);
        } catch (error) {
            this.util.logError('Error looking up tx_index in transactions table:', error);
        }
        await this.releaseConnection();
        return tx_index;
    }

    // Create records in the 'transactions' table and return record id
    async createTxIndex(data){
        let tx_index = await this.getTxIndex(data.TX_HASH);
        // Handle creating record
        if(tx_index==null){
            tx_index        = await this.getNextTxIndex();
            let block_index = data.BLOCK_INDEX;
            let source_id   = await this.createAddress(data.SOURCE);
            let tx_hash_id  = await this.createTransaction(data.TX_HASH);
            let db          = await this.getConnection();
            let query       = "INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id) values (?, ?, ?, ?)";
            try {
                let result = await db.query(query, [tx_index, block_index, tx_hash_id, source_id]);
            } catch (error) {
                this.util.logError('Error while trying to create record in transactions table:', error);
            }
            await this.releaseConnection();
        }
        return tx_index;
    }

    // Handles returning the highest action_index from `actions` table
    async getNextActionIndex(){
        let idx   = 0;
        let db    = await this.getConnection();
        let query = "SELECT action_index FROM actions ORDER BY action_index DESC LIMIT 1";
        try {
            let rows = await db.query(query);
            if(rows.length > 0)
                idx = Number(rows[0].action_index);
        } catch (error) {
            this.util.logError('Error looking up action_index in actions table:', error);
        }
        // Increase current action__index by 1 to get the next action_index
        idx++;
        await this.releaseConnection();
        return idx;
    }

    // Lookup action_index records in the `actions` table and return them
    async getActionIndex(data){
        let action_index  = null;
        let block_index   = data.BLOCK_INDEX;
        let tx_index      = data.TX_INDEX;
        let action_format = data.FORMAT;
        let action_id     = await this.createAction(data.ACTION);
        let db            = await this.getConnection();
        let query = `SELECT
                        a.action_index
                    FROM
                        actions a
                        INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                    WHERE
                        t.block_index=? AND 
                        a.tx_index=? AND 
                        a.action_id=? AND
                        a.action_format=?`;
        let args = [block_index, tx_index, action_id, action_format];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                action_index = Number(rows[0].action_index);
        } catch (error) {
            this.util.logError('Error looking up action_index in actions table:', error);
        }
        await this.releaseConnection();
        return action_index;
    }

    // Create records in the 'actions' table and return record id
    async createActionIndex(data){
        let action_index = await this.getActionIndex(data);
        // Handle creating record
        if(action_index==null){
            action_index      = await this.getNextActionIndex();
            let tx_index      = data.TX_INDEX;
            let action_format = data.FORMAT;
            let action_id     = await this.createAction(data.ACTION);
            let db            = await this.getConnection();
            let query         = "INSERT INTO actions (action_index, tx_index, action_id, action_format) values (?, ?, ?, ?)";
            let args          = [action_index, tx_index, action_id, action_format];
            try {
                let result = await db.query(query, args);
            } catch (error) {
                this.util.logError('Error while trying to create record in actions table:', error);
            }
            await this.releaseConnection();
        }
        return action_index;
    }

    // Update records in the 'actions' table and return record id
    async updateActionIndex(action_index, action){
        if(action_index){
            let action_id = await this.createAction(action);
            let db        = await this.getConnection();
            let query     = "UPDATE actions SET action_id=? WHERE action_index=?";
            let args      = [action_id, action_index];
            try {
                let result = await db.query(query, args);
            } catch (error) {
                this.util.logError('Error while trying to update record in actions table:', error);
            }
            await this.releaseConnection();
        }
    }


    // Lookup a record in the `index_tickers` table and return record tick
    async getTicker(tick_id){
        let tick  = null;
        let db    = await this.getConnection();
        let query = "SELECT tick FROM index_tickers WHERE id=? LIMIT 1";
        try {
            let rows = await db.query(query, [tick_id]);
            if(rows.length > 0)
                tick = rows[0].tick;
        } catch (error){
            this.util.logError('Error looking up ticker using tick_id in index_tickers table:', error);
        }
        await this.releaseConnection();
        return tick;
    }

    // Lookup a record in the `index_tickers` table and return record id
    async getTickerId(tick){
        let id  = null;
        let str = String(tick);
        let pid = str.substring(1,str.length-1); // Possible TICK ID
        // Determine if TICK is actually a TICK ID
        if(str.substring(0,1)=='^' && this.util.isNumeric(pid))
            id = pid;
        // TODO : Handle passing full parent->child asset name and decode to correct TICK ID
        //        example: BACON.is.delicious (period is parent/child indicator character)
        // Try to lookup id using tick passed
        if(!id){
            let db    = await this.getConnection();
            // let query = "SELECT id FROM index_tickers WHERE tick COLLATE utf8mb4_bin LIKE ? LIMIT 1";
            let query = "SELECT id FROM index_tickers WHERE tick=? LIMIT 1";
            try {
                let rows = await db.query(query, [tick]);
                if(rows.length > 0)
                    id = Number(rows[0].id);
            } catch (error) {
                this.util.logError('Error looking up ticker record id in index_tickers table:', error);
            }
            await this.releaseConnection();
        }
        return id;
    }

    // Create records in the 'index_tickers' table and return record id
    async createTicker(tick){
        // Ignore empty tick and return NULL
        if(this.util.isNull(tick))
            return null;
        // Get the tick id using tick
        let id = await this.getTickerId(tick);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            let query = "INSERT INTO index_tickers (tick) values (?)";
            let args  = [tick];
            try {
                let result = await db.query(query, args);
                if(result.insertId)
                    id = Number(result.insertId);
            } catch (error) {
                this.util.logError('Error trying to create ticker record in index_tickers table:', error);
            }
            await this.releaseConnection();
        }
        return id;
    }

    // Handle getting token information using issues table
    // @param {tick}            string  Ticker name or Ticker ID
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    async getTokenInfo(tick, block_index, action_index){
        let data = false,
            sql  = '',
            args = [];
        // Only query database if we actually have a tick or tick_id passed
        if(!this.util.isNull(tick)){
            // Get the tick_id for the given ticker
            let tick_id = await this.createTicker(tick);
            // Add tick_id to SQL query arguments
            args.push(tick_id);
            // If a block_index was given, only lookup tokens created before or in given block_index
            if(!this.util.isNull(block_index) && this.util.isNumeric(block_index)){
                sql += " AND t1.block_index <= ?";
                args.push(parseInt(block_index));
            }
            // If a action_index was given, only lookup tokens created before given action_index
            if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
                sql += " AND a1.action_index < ?";
                args.push(parseInt(action_index));
            }
            // Build out SQL query based on search params
            let query = `SELECT 
                            i.max_supply,
                            i.max_mint,
                            i.decimals,
                            i.description,
                            i.lock_max_supply,
                            i.lock_mint_supply,
                            i.lock_mint,
                            i.lock_max_mint,
                            i.lock_description,
                            i.lock_sleep,
                            i.lock_callback,
                            i.callback_block,
                            i.callback_amount,
                            i.mint_address_max,
                            i.mint_start_block,
                            i.mint_stop_block,
                            i.allow_list,
                            i.block_list,
                            i.action_index,
                            t1.block_index,
                            t2.tick,
                            t3.tick as callback_tick,            
                            a2.address as owner,
                            a3.address as transfer
                        FROM 
                            issues i
                            INNER JOIN actions            a1 ON (a1.action_index=i.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN index_tickers      t2 ON (t2.id=i.tick_id)
                            INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=i.status_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=i.transfer_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=i.callback_tick_id)
                        WHERE
                            s1.status='valid' AND
                            i.tick_id=?` + sql + `
                        ORDER BY 
                            i.action_index ASC`;
            try {
                let db   = await this.getConnection();
                let rows = await db.query(query, args);
                if(rows.length > 0){
                    // Define data object
                    if(!data)
                        data = {};
                    // Loop through ISSUE transactions for the given ticker
                    for(let row of rows){
                        // Define object of values for this ISSUE tx
                        let arr  = {};
                        arr['ACTION_INDEX']      = row.action_index;
                        arr['TICK']              = row.tick;
                        arr['TICK_ID']           = tick_id;
                        arr['OWNER']             = (row.transfer) ? row.transfer : row.owner;
                        arr['MAX_SUPPLY']        = row.max_supply;
                        arr['MAX_MINT']          = row.max_mint;
                        // Force decimal precision to a integer value
                        arr['DECIMALS']          = (!this.util.isNull(row.decimals)) ? parseInt(row.decimals) : 0;
                        arr['DESCRIPTION']       = row.description;
                        arr['LOCK_MAX_SUPPLY']   = row.lock_max_supply;
                        arr['LOCK_MINT_SUPPLY']  = row.lock_mint_supply;
                        arr['LOCK_MINT']         = row.lock_mint;
                        arr['LOCK_MAX_MINT']     = row.lock_max_mint;
                        arr['LOCK_DESCRIPTION']  = row.lock_description;
                        arr['LOCK_SLEEP']        = row.lock_sleep;
                        arr['LOCK_CALLBACK']     = row.lock_callback;
                        arr['CALLBACK_TICK']     = row.callback_tick;
                        arr['CALLBACK_BLOCK']    = row.callback_block;
                        arr['CALLBACK_AMOUNT']   = row.callback_amount;
                        arr['ALLOW_LIST']        = row.allow_list;
                        arr['BLOCK_LIST']        = row.block_list;
                        arr['MINT_ADDRESS_MAX']  = row.mint_address_max;
                        arr['MINT_START_BLOCK']  = row.mint_start_block;
                        arr['MINT_STOP_BLOCK']   = row.mint_stop_block;
                        // build out token state
                        // TODO: will need to massage the data a bit more to build out accurate token state... this is quick and dirty
                        for(let key in arr){
                            let value = arr[key];
                            // Only set the ACTION_INDEX on the first valid issuance
                            if(key=='ACTION_INDEX' && this.util.isNull(data[key]))
                                data[key] = value;
                            // Disallow unsetting of LOCK flags
                            if(String(key).substr(0,5)=='LOCK_')
                                if(data[key]==1)
                                    continue;
                            // Prevent changing decimal precision 
                            if(key=='DECIMALS' && data[key] > value)
                                continue;
                            // Skip setting value if value is null or empty (use last explicit value)
                            if(this.util.isNull(value) || value==='')
                                continue;
                            // Update data object with value from this ISSUE tx
                            data[key] = value;
                        }
                    }
                }
            } catch (error) {
                this.util.logError('Error looking up token info : ', error);
            }
            await this.releaseConnection();
        }
        // Get token supply at the given action_index
        if(data)
            data['SUPPLY'] = await this.getTokenSupply(tick, block_index, action_index); 
        return data;
    }

    // Handle getting decimal precision for a given tick_id
    async getTokenDecimalPrecision(tick_id){
        let decimals = 0;
        // Lookup decimal precision using the issues table 
        // DO NOT lookup precision using getTokenInfo() (avoid recursive queries)
        let db      = await this.getConnection();
        let query = `SELECT
                        i.decimals
                    FROM
                        issues i,
                        index_statuses s
                    WHERE
                        i.status_id=s.id AND
                        i.tick_id=? AND
                        s.status='valid'`;
        try {
            let rows = await db.query(query, [tick_id]);
            if(rows.length > 0){
                // Loop through ISSUE transactions for the given ticker
                for(let row of rows){
                    if(!this.util.isNull(row.decimals) && row.decimals > decimals)
                        decimals = row.decimals;
                }
            }
        } catch (error) {
            this.util.logError('Error looking up decimal precision from the issues table:', error);
        }
        await this.releaseConnection();
        return decimals;
    }

    // Get token supply from credits/debits table (credits - debits + escrows = supply)
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    async getTokenSupply(tick, block_index, action_index){
        let credits = 0;
        let debits  = 0;
        let escrows = 0;
        let supply  = 0;
        let db      = await this.getConnection(),
            sql     = '',
            query   = '',
            args    = [],
            tick_id = await this.createTicker(tick);
        // Get info on decimal precision
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        // Add tick_id to SQL query arguments
        args.push(tick_id);
        // If a block_index was given, only lookup tokens created before or in given block_index
        if(!this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            sql += " AND t.block_index <= ?";
            args.push(parseInt(block_index));
        }
        // If a action_index was given, only lookup tokens created before given action_index
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            sql += " AND m.action_index < ?";
            args.push(parseInt(action_index));
        }
        // Get Credits 
        query = `SELECT 
                    CAST(SUM(m.amount) AS DECIMAL(60,` + decimals + `)) as credits 
                FROM 
                    credits m
                    INNER JOIN actions      a ON (a.action_index=m.action_index)
                    INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                WHERE 
                    m.tick_id=?` + sql;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0 && !this.util.isNull(rows[0].credits))
                credits = rows[0].credits;
        } catch (error) {
            this.util.logError('Error while trying to get list of credits:', error);
        }
        // Get Debits 
        query = `SELECT 
                    CAST(SUM(m.amount) AS DECIMAL(60,` + decimals + `)) as debits 
                FROM 
                    debits m
                    INNER JOIN actions      a ON (a.action_index=m.action_index)
                    INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                WHERE 
                    m.tick_id=?` + sql;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0 && !this.util.isNull(rows[0].debits))
                debits = rows[0].debits;
        } catch (error) {
            this.util.logError('Error while trying to get list of debits:', error);
        }
        // Get Escrows 
        query = `SELECT 
                    CAST(SUM(m.amount) AS DECIMAL(60,` + decimals + `)) as escrows 
                FROM 
                    escrows m
                    INNER JOIN actions      a ON (a.action_index=m.action_index)
                    INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                WHERE 
                    m.tick_id=?` + sql;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0 && !this.util.isNull(rows[0].escrows))
                escrows = rows[0].escrows;
        } catch (error) {
            this.util.logError('Error while trying to get list of escrows:', error);
        }
        await this.releaseConnection();
        // Determine total supply ((credits - debits) + escrows)
        supply = this.util.bcadd(this.util.bcsub(credits, debits, decimals), escrows, decimals);
        return supply;
    }

    // Get token supply for a given ticker from tokens table
    async getTokenSupplyToken(tick){
        let supply   = 0;
        let tick_id  = await this.createTicker(tick);
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        let db       = await this.getConnection();
        let query = `SELECT supply FROM tokens WHERE tick_id=? LIMIT 1`;
        try {
            let rows = await db.query(query, [tick_id]);
            if(rows.length > 0 && !this.util.isNull(rows[0].supply))
                supply = rows[0].supply;
        } catch (error) {
            this.util.logError('Error looking up token supply from tokens table:', error);
        }
        await this.releaseConnection();
        return supply;
    }

    // Get token supply for a given ticker from balances table
    async getTokenSupplyBalance(tick){
        let supply   = 0;
        let tick_id  = await this.createTicker(tick);
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        let db       = await this.getConnection();
        let query = `SELECT CAST(SUM(amount) AS DECIMAL(60, ` + decimals + `)) as supply FROM balances WHERE tick_id=? LIMIT 1`;
        try {
            let rows = await db.query(query, [tick_id]);
            if(rows.length > 0 && !this.util.isNull(rows[0].supply))
                supply = rows[0].supply;
        } catch (error) {
            this.util.logError('Error looking up token supply from balances table:', error);
        }
        await this.releaseConnection();
        return supply;
    }

    // Get escrowed token supply for a given ticker from escrows table
    async getTokenSupplyEscrow(tick){
        let supply   = 0;
        let tick_id  = await this.createTicker(tick);
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        let db       = await this.getConnection();
        let query = `SELECT CAST(SUM(amount) AS DECIMAL(60, ` + decimals + `)) as supply FROM escrows WHERE tick_id=? LIMIT 1`;
        try {
            let rows = await db.query(query, [tick_id]);
            if(rows.length > 0 && !this.util.isNull(rows[0].supply))
                supply = rows[0].supply;
        } catch (error) {
            this.util.logError('Error looking up token supply from escrows table:', error);
        }
        await this.releaseConnection();
        return supply;
    }


    // Handle getting a list of TICK holders and amounts
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    // TODO: Add support for 'escrowed' tokens (dispensers, orders, bets)
    // TODO: Can optimize this function to allow getting list of holders from balances table instead of credits/debits
    async getHolders(tick, block_index, action_index){
        let holders = {};
        let db      = await this.getConnection(),
            sql     = '',
            query   = '',
            args    = [],
            tick_id = null;
        // Get the tick_id for the given ticker
        if(!this.util.isNull(tick) && this.util.isNull(tick_id))
            tick_id = await this.createTicker(tick);
        // Get info on decimal precision
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        // Add tick_id to SQL query arguments
        args.push(tick_id);
        // If a block_index was given, only lookup tokens created before or in given block_index
        if(!this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            sql += " AND t1.block_index <= ?";
            args.push(parseInt(block_index));
        }
        // If a action_index was given, only lookup tokens created before given action_index
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            sql += " AND m.action_index < ?";
            args.push(parseInt(action_index));
        }
        // Get Credits 
        query = `SELECT 
                    CAST(SUM(m.amount) AS DECIMAL(60,` + decimals + `)) as credits,
                    a2.address
                FROM 
                    credits m
                    INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                    INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN index_addresses a2 ON (a2.id=m.address_id)
                WHERE 
                    m.tick_id=?` + sql + `
                GROUP BY a2.address`;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0){
                rows.forEach(function(row){
                    holders[row.address] = row.credits;
                });
            }
        } catch (error) {
            this.util.logError('Error while trying to get list of holders from credits table:', error);
        }
        // Get Debits 
        query = `SELECT 
                    CAST(SUM(m.amount) AS DECIMAL(60,` + decimals + `)) as debits,
                    a2.address
                FROM 
                    debits m
                    INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                    INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN index_addresses a2 ON (a2.id=m.address_id)
                WHERE 
                    m.tick_id=?` + sql + `
                GROUP BY a2.address`;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0){
                for(let row of rows){
                    let balance = this.util.bcsub(holders[row.address], row.debits, decimals);
                    if(balance > 0)
                        holders[row.address] = balance;
                    else
                       delete holders[row.address];
                }
            }
        } catch (error) {
            this.util.logError('Error while trying to get list of holders from debits table:', error);
        }
        await this.releaseConnection();
        // Sort holders list from biggest to smallest
        holders = Object.fromEntries(Object.entries(holders).sort(([, a], [, b]) => b - a));
        return holders;
    }

    // Determine if an ticker is distributed to users (held by more than owner)
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    async isDistributed(tick, block_index, action_index){
        let info    = await this.getTokenInfo(tick, null, block_index, action_index);
        let holders = (info) ? await this.getHolders(tick, block_index, action_index) : [];
        // More than one holder
        if(Object.keys(holders).length>1)
            return true;
        // Holder that is not OWNER
        for(let address in holders)
            if(address!=info['OWNER'])
                return true;
        return false;
    }

    // Validate if a list is a valid type
    // @param {action_index}  integer  ACTION_INDEX to a list
    // @param {type}          string   List Type (1=TICK, 2=ADDRESS)
    async isValidList(action_index, type){
        let list_type = this.getListType(action_index);
        if(list_type==type)
            return true;
        return false;
    }

    // Return a list type given a tx_hash
    async getListType(action_index){
        let type  = false;
        let db    = await this.getConnection();
        let query = "SELECT type FROM lists WHERE action_index=? LIMIT 1";
        let args  = [action_index];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                type = parseInt(rows[0].type);
        } catch (error) {
            this.util.logError('Error looking up list type in lists table:', error);
        }
        await this.releaseConnection();
        return type;
    }

    // Return a list given a tx_hash
    async getList(action_index){
        let type = await this.getListType(action_index);
        let list = [];
        if(type){
            let db    = await this.getConnection();
            let query = '';
            let args  = [action_index];
            if(type==1){
                query = `SELECT 
                            t.tick as item 
                        FROM 
                            list_items l
                            INNER JOIN index_tickers t ON (l.item_id=t.id)
                        WHERE
                            l.action_index=?`;
            }
            if(type==2){
                query = `SELECT 
                            a.address as item 
                        FROM
                            list_items l
                            INNER JOIN index_addresses a ON (l.item_id=a.id)
                        WHERE 
                            l.action_index=?`;
            }
            try {
                let rows = await db.query(query, args);
                if(rows.length > 0)
                    for(let row of rows)
                        list.push(row['item']);
            } catch (error) {
                this.util.logError('Error looking up list data in lists table:', error);
            }
            await this.releaseConnection();
        }
        return list;
    }

    // Create record in `lists` table
    async createList(data){
        // Normalize data
        data                  = this.truncateDataValues(data);
        let action_index      = data['ACTION_INDEX'];
        let status_id         = await this.createStatus(data['STATUS']);
        let list_type         = data['TYPE'];
        let list_edit         = data['EDIT'];
        let list_action_index = data['LIST_ACTION_INDEX'];
        // Check if record already exists for this token
        let db     = await this.getConnection();
        let query  = "SELECT action_index FROM lists WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in lists table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                            lists
                        SET
                            type=?,
                            edit=?,
                            list_action_index=?,
                            status_id=?
                        WHERE 
                            action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO lists (type, edit, list_action_index, status_id, action_index) values (?, ?, ?, ?, ?)`;
        }
        args = [list_type, list_edit, list_action_index, status_id, action_index];
        // Create or Update the record in the lists table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in lists table:', error);
        }
        await this.releaseConnection();
    }

    // Lookup a record in the `index_statuses` table and return record id
    async getStatusId(status){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_statuses WHERE status=? LIMIT 1";
        try {
            let rows = await db.query(query, [status]);
            if(rows.length > 0)
                id = Number(rows[0].id);
        } catch (error) {
            this.util.logError('Error looking up status record id in index_statuses table:', error);
        }
        await this.releaseConnection();
        return id;
    }

    // Create records in the 'index_statuses' table and return record id
    async createStatus(status){
        // Ignore empty status and return NULL
        if(this.util.isNull(status))
            return null;
        var id = await this.getStatusId(status);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            let query = "INSERT INTO index_statuses (status) values (?)";
            try {
                let result = await db.query(query, [status]);
                if(result.insertId)
                    id = Number(result.insertId);
            } catch (error) {
                this.util.logError('Error trying to create status record in index_statuses table:', error);
            }
            await this.releaseConnection();
        }
        return id;
    }

    // Create/Update record in `issues` table
    async createIssue(data){
        // Normalize data
        data = this.truncateDataValues(data);
        // Standardize LOCK values to explicitly unlocked (0) or locked (1)
        for(let lock of this.config['LOCK_FIELDS']){
            if([0,1].indexOf(data[lock]) == -1)
                delete data[lock];
        }
        // Standardize LIST values to numeric or NULL
        for(let list of this.config['LIST_FIELDS']){
            if(this.util.isNull(data[list]) || !this.util.isNumeric(data[list]))
                delete data[list];
        }
        // Unset DECIMALS if it is outside of the acceptable range
        if(!this.util.isNull(data['DECIMALS']) && (data['DECIMALS'] < this.config.MIN_TOKEN_DECIMALS || data['DECIMALS'] > this.config.MAX_TOKEN_DECIMALS))
            delete data['DECIMALS'];
        // Make data safe for use in SQL queries
        let action_index       = data['ACTION_INDEX'];
        let description        = data['DESCRIPTION'];
        let max_supply         = data['MAX_SUPPLY'];
        let max_mint           = data['MAX_MINT'];
        let mint_supply        = data['MINT_SUPPLY'];
        let mint_address_max   = data['MINT_ADDRESS_MAX'];
        let mint_start_block   = data['MINT_START_BLOCK'];
        let mint_stop_block    = data['MINT_STOP_BLOCK'];
        let decimals           = data['DECIMALS'];
        let status             = data['STATUS'];
        let lock_max_supply    = data['LOCK_MAX_SUPPLY'];
        let lock_mint          = data['LOCK_MINT'];
        let lock_mint_supply   = data['LOCK_MINT_SUPPLY'];
        let lock_max_mint      = data['LOCK_MAX_MINT'];
        let lock_description   = data['LOCK_DESCRIPTION'];
        let lock_sleep         = data['LOCK_SLEEP'];
        let lock_callback      = data['LOCK_CALLBACK'];
        let callback_block     = data['CALLBACK_BLOCK'];
        let callback_amount    = data['CALLBACK_AMOUNT'];
        let allow_list         = data['ALLOW_LIST'];
        let block_list         = data['BLOCK_LIST'];
        let callback_tick_id   = await this.createTicker(data['CALLBACK_TICK']);
        let tick_id            = await this.createTicker(data['TICK']);
        let transfer_id        = await this.createAddress(data['TRANSFER']);
        let transfer_supply_id = await this.createAddress(data['TRANSFER_SUPPLY']);
        let status_id          = await this.createStatus(data['STATUS']);
        // Check if record already exists for this ISSUE action
        let db    = await this.getConnection();
        let query = `SELECT action_index FROM issues WHERE action_index=?`;
        let args  = [action_index]
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error) {
            this.util.logError('Error looking up record in issues table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        issues
                    SET
                        tick_id=?,
                        max_supply=?,
                        max_mint=?,
                        decimals=?,
                        description=?,
                        mint_supply=?,
                        transfer_id=?,
                        transfer_supply_id=?,
                        lock_max_supply=?,
                        lock_mint=?,
                        lock_mint_supply=?,
                        lock_max_mint=?,
                        lock_description=?,
                        lock_sleep=?,
                        lock_callback=?,
                        callback_block=?,
                        callback_tick_id=?,
                        callback_amount=?,
                        allow_list=?,
                        block_list=?,
                        mint_address_max=?,
                        mint_start_block=?,
                        mint_stop_block=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO issues (
                        tick_id, 
                        max_supply, 
                        max_mint, 
                        decimals, 
                        description, 
                        mint_supply, 
                        transfer_id, 
                        transfer_supply_id, 
                        lock_max_supply, 
                        lock_mint, 
                        lock_mint_supply, 
                        lock_max_mint, 
                        lock_description, 
                        lock_sleep, 
                        lock_callback, 
                        callback_block, 
                        callback_tick_id, 
                        callback_amount, 
                        allow_list, 
                        block_list, 
                        mint_address_max, 
                        mint_start_block, 
                        mint_stop_block, 
                        status_id,
                        action_index
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args = [tick_id, max_supply, max_mint, decimals, description, mint_supply, transfer_id, transfer_supply_id, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint, lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, status_id, action_index ];
        // Create or Update the record in the issues table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in issues table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `tokens` table
    async createToken(data){
        // Normalize data
        let supply             = (!this.util.isNull(data['SUPPLY']) &&               this.util.isNumeric(data['SUPPLY'])) ? data['SUPPLY'] : 0;
        let max_supply         = (!this.util.isNull(data['MAX_SUPPLY']) &&           this.util.isNumeric(data['MAX_SUPPLY'])) ? data['MAX_SUPPLY'] : 0;
        let max_mint           = (!this.util.isNull(data['MAX_MINT']) &&             this.util.isNumeric(data['MAX_MINT'])) ? data['MAX_MINT'] : 0;
        let mint_supply        = (!this.util.isNull(data['MINT_SUPPLY']) &&          this.util.isNumeric(data['MINT_SUPPLY'])) ? data['MINT_SUPPLY'] : 0;
        let mint_address_max   = (!this.util.isNull(data['MINT_ADDRESS_MAX']) &&     this.util.isNumeric(data['MINT_ADDRESS_MAX'])) ? data['MINT_ADDRESS_MAX'] : 0;
        let mint_start_block   = (!this.util.isNull(data['MINT_START_BLOCK']) &&     this.util.isNumeric(data['MINT_START_BLOCK'])) ? data['MINT_START_BLOCK'] : 0;
        let mint_stop_block    = (!this.util.isNull(data['MINT_STOP_BLOCK']) &&      this.util.isNumeric(data['MINT_STOP_BLOCK'])) ? data['MINT_STOP_BLOCK'] : 0;
        let callback_amount    = (!this.util.isNull(data['CALLBACK_AMOUNT']) &&      this.util.isNumeric(data['CALLBACK_AMOUNT'])) ? data['CALLBACK_AMOUNT'] : 0;
        let allow_list         = (!this.util.isNull(data['ALLOW_LIST']) &&           this.util.isNumeric(data['ALLOW_LIST'])) ? parseInt(data['ALLOW_LIST']) : null;
        let block_list         = (!this.util.isNull(data['BLOCK_LIST']) &&           this.util.isNumeric(data['BLOCK_LIST'])) ? parseInt(data['BLOCK_LIST']) : null;
        let decimals           = (!this.util.isNull(data['DECIMALS']) &&             this.util.isNumeric(data['DECIMALS'])) ? parseInt(data['DECIMALS']) : 0;
        // Force any amount values to the correct decimal precision
        if(this.util.isNumeric(decimals) && decimals >= this.config.MIN_TOKEN_DECIMALS && decimals <= this.config.MAX_TOKEN_DECIMALS){
            max_supply         = this.util.bcmul(max_supply, 1, decimals);
            max_mint           = this.util.bcmul(max_mint, 1, decimals);
            mint_supply        = this.util.bcmul(mint_supply, 1, decimals);
            mint_address_max   = this.util.bcmul(mint_address_max, 1, decimals);
            // callback_amount    = this.util.bcmul(callback_amount, 1, decimals);
        }
        let description        = data['DESCRIPTION'];
        let action_index       = data['ACTION_INDEX'];
        // Force lock fields to integer values 
        let lock_max_supply    = (data['LOCK_MAX_SUPPLY']==1) ? 1 : 0;
        let lock_mint          = (data['LOCK_MINT']==1) ? 1 : 0;
        let lock_max_mint      = (data['LOCK_MAX_MINT']==1) ? 1 : 0;
        let lock_description   = (data['LOCK_DESCRIPTION']==1) ? 1 : 0;
        let lock_sleep         = (data['LOCK_SLEEP']==1) ? 1 : 0;
        let lock_callback      = (data['LOCK_CALLBACK']==1) ? 1 : 0;
        let callback_block     = (data['CALLBACK_BLOCK']>0) ? data['CALLBACK_BLOCK'] : 0;
        let callback_tick_id   = await this.createTicker(data['CALLBACK_TICK']);
        let tick_id            = await this.createTicker(data['TICK']);
        let owner_id           = await this.createAddress(data['OWNER']);
        // Check if record already exists for this token
        let db     = await this.getConnection();
        let query  = "SELECT id FROM tokens WHERE tick_id=? LIMIT 1";
        let exists = false;
        try {
            let rows = await db.query(query, [tick_id]);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in tokens table:', error);
        }
        let args = [];
        if(exists){
            // UPDATE record
            query = `UPDATE
                        tokens
                    SET
                        max_supply=?,
                        max_mint=?,
                        decimals=?,
                        description=?,
                        lock_max_supply=?,
                        lock_mint=?,
                        lock_max_mint=?,
                        lock_description=?,
                        lock_sleep=?,
                        lock_callback=?,
                        callback_block=?,
                        callback_tick_id=?,
                        callback_amount=?,
                        allow_list=?,
                        block_list=?,
                        mint_address_max=?,
                        mint_start_block=?,
                        mint_stop_block=?,
                        supply=?,
                        owner_id=?,
                        last_action_index=?
                    WHERE 
                        tick_id=?`;
            args = [max_supply, max_mint, decimals, description, lock_max_supply, lock_mint, lock_max_mint,lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, supply, owner_id, action_index, tick_id];
        } else {
            // INSERT record
            query = `INSERT INTO tokens (
                        max_supply, 
                        max_mint, 
                        decimals, 
                        description, 
                        lock_max_supply, 
                        lock_mint, 
                        lock_max_mint,
                        lock_description, 
                        lock_sleep, 
                        lock_callback, 
                        callback_block, 
                        callback_tick_id, 
                        callback_amount, 
                        allow_list, 
                        block_list, 
                        mint_address_max, 
                        mint_start_block, 
                        mint_stop_block, 
                        supply, 
                        owner_id, 
                        action_index,
                        last_action_index,
                        tick_id 
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [max_supply, max_mint, decimals, description, lock_max_supply, lock_mint, lock_max_mint,lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, supply, owner_id, action_index, action_index, tick_id];
        }
        // Create or Update the record in the tokens table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in tokens table:', error);
        }
        await this.releaseConnection();
    }

    // Create / Update ledger change records (credits / debits / escrows)
    async createLedgerChangeRecord(table, action_index, tick, amount, address){
        let tick_id    = await this.createTicker(tick);
        let address_id = await this.createAddress(address);
        // Check if record already exists for this token
        let db    = await this.getConnection();
        let query = `SELECT
                        action_index
                    FROM
                        ` + table + `
                    WHERE
                        action_index=? AND
                        address_id=? AND 
                        tick_id=?`;
        let exists = false;
        try {
            let rows = await db.query(query, [action_index, address_id, tick_id]);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in ' + table + ' table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        ` + table + `
                    SET
                        amount=?
                    WHERE 
                        action_index=? AND
                        address_id=? AND 
                        tick_id=?`;
        } else {
            // INSERT record
            query = `INSERT INTO ` + table + ` (amount, action_index, address_id, tick_id) values (?, ?, ?, ?)`;
        }
        let args = [amount, action_index, address_id, tick_id];
        // Create or Update the record in the table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in ' + table + ' table:', error);
        }
        await this.releaseConnection();        
    }

    // Create / Update record in `credits` table
    async createCredit(action_index, tick, amount, address){
        await this.createLedgerChangeRecord('credits', action_index, tick, amount, address);
    }

    // Create / Update record in `debits` table
    async createDebit(action_index, tick, amount, address){
        await this.createLedgerChangeRecord('debits', action_index, tick, amount, address);
    }

    // Create / Update record in `escrows` table
    async createEscrow(action_index, tick, amount, address){
        await this.createLedgerChangeRecord('escrows', action_index, tick, amount, address);
    }

    // Handle updating address balances (credits-debits=balance)
    // @param {address}  boolean Full update
    // @param {address}  string  Address string
    // @param {address}  array   Array of address strings
    // @param {rollback} boolean Rollback
    async updateBalances(address, rollback){
        let addrs = [];
        let type  = typeof address;
        // Handle arrays and objects
        if(type==='object'){
            for(let addr of address){
                if(!this.util.isNull(addr) && addr!='')
                    addrs.push(addr);
            }
        }
        if(type==='string')
            addrs.push(address);
        // Dump full list of addresses
        if(type==='boolean' && address===true){
            console.log('Updating all balances...');
            let db    = await this.getConnection();
            let query = "SELECT address FROM index_addresses";
            try {
                let rows = await db.query(query);
                if(rows.length > 0){
                    for(let row of rows)
                        addrs.push(row.address);
                }
            } catch (error){
                this.util.logError('Error looking up list of all addresses from index_addresses table:', error);
            }
            await this.releaseConnection();
        }
        // Loop through addresses and update balance list
        for(address of addrs)
            await this.updateAddressBalance(address, rollback);
    }

    // Create/Update/Delete records in the 'balances' table
    async updateAddressBalance(address, rollback){
        let type        = typeof address;
        let address_id  = null;
        let balance     = 0;
        let old_balance = 0;
        let query       = false;
        let db          = await this.getConnection();
        if(type==='number' && this.util.isNumeric(address))
            address_id = address;
        if(type==='string' && !this.util.isNumeric(address))
            address_id = await this.createAddress(address);
        // Get list of address balances based on credits/debits tables
        let balances = await this.getAddressBalances(address_id);
        // Get list of address balances based on balances table
        let old_balances = await this.getAddressTableBalances(address_id);
        // Handle updating any current balances based on credits/debits table records
        for(let tick_id in balances){
            balance = balances[tick_id];
            let action  = 'insert';
            query = "SELECT id FROM balances WHERE address_id=? AND tick_id=? LIMIT 1";
            try {
                let rows = await db.query(query, [address_id, tick_id]);
                if(rows.length > 0)
                    action = 'update';
            } catch (error){
                this.util.logError('Error looking up address from balances table:', error);
            }
            let args = [];
            if(balance==0)
                action = 'delete';
            if(action=='delete'){
                query = "DELETE FROM balances WHERE address_id=? AND tick_id=? ";
                args.push(address_id, tick_id);
            } else if(action=='update'){
                query = "UPDATE balances SET amount=? WHERE address_id=? AND tick_id=? ";
                args.push(balance, address_id, tick_id);
            } else if(action=='insert'){
                query = "INSERT INTO balances (tick_id, address_id, amount) values (?, ?, ?)";
                args.push(tick_id, address_id, balance);
            }
            try {
                // console.log('updateAddressBalance query=',query,args);
                let result = await db.query(query, args);
            } catch (error){
                this.util.logError('Error while trying to ' + action + ' balance record for address=' + address + ' tick_id=' + tick_id, error);
            }                
        }
        // If this is a rollback, then handle detecting records in balances table which should not exist and delete them
        // TODO: Test this code a bit better with various random rollbacks and verify all is working without any sanity check issues
        if(rollback){
            for(let tick_id in old_balances){
                old_balance = old_balances[tick_id];
                balance     = balances[tick_id];
                if(!this.util.isNull(old_balance) && (this.util.isNull(balance) || balance==0 )){
                    query = "DELETE FROM balances WHERE address_id=? AND tick_id=?";
                    try {
                        let rows = await db.query(query, [address_id, tick_id]);
                    } catch (error){
                        this.util.logError('Error deleting balance record address=' + address + ' tick_id=' + tick_id, error);
                    }                        
                }
            }
        }
        await this.releaseConnection();
    }

    // Get address balances using credits/debits table data
    async getAddressBalances(address, tick, block_index, action_index){
        let type       = typeof address;
        let address_id = null;
        if(type==='number' && this.util.isNumeric(address))
            address_id = address;
        if(type==='string' && !this.util.isNumeric(address))
            address_id = await this.createAddress(address);
        let credits  = await this.getAddressCreditDebit('credits', address_id, null, block_index, action_index);
        let debits   = await this.getAddressCreditDebit('debits',  address_id, null, block_index, action_index);
        let decimals = {}; // Object to store tick_id/decimals
        let balances = {}; // Object to store tick_id/balance
        for(let tick_id in credits)
            decimals[tick_id] = await this.getTokenDecimalPrecision(tick_id);
        // Build out balances (credits - debits)
        for(let tick_id in credits){
            let credit  = credits[tick_id];
            let debit   = (!this.util.isNull(debits[tick_id])) ? debits[tick_id] : 0;
            let decimal = decimals[tick_id];
            let balance = null;
            try {
                balance = this.util.bcsub(credit, debit, decimal);
            } catch(err){
                balance = this.util.bcadd(0, 0, decimal);
            }
            // Pass forward any numeric values (including 0 balance)
            if(this.util.isNumeric(balance))
                balances[tick_id] = balance;
        }
        return balances;
    }

    // Get address balances using balances table data
    async getAddressTableBalances(address){
        let type       = typeof address;
        let address_id = null;
        let balances   = {}; // Object to store tick/balance
        if(type==='number' && this.util.isNumeric(address))
            address_id = address;
        if(type==='string' && !this.util.isNumeric(address))
            address_id = await this.createAddress(address);
        let db    = await this.getConnection();
        let query = "SELECT tick_id, amount FROM balances WHERE address_id=?";
        try {
            let rows = await db.query(query, address_id);
            if(rows.length > 0)
                for(let row of rows)
                    balances[row.tick_id] = row.amount;
        } catch (error){
            this.util.logError('Error while trying to get list of all tokens:', error);
        }
        await this.releaseConnection();
        return balances;
    }

    // Handle getting credits or debits records for a given address
    async getAddressCreditDebit(table, address, action, block_index, action_index){
        let data       = [];
        let type       = typeof address;
        let address_id = null;
        if(type==='number' && this.util.isNumeric(address))
            address_id = address;
        if(type==='string' && !this.util.isNumeric(address))
            address_id = await this.createAddress(address);
        let sql  = '';
        let args = [address_id];
        // Query using either block_index OR action_index
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            sql += " AND m.action_index < ?";
            args.push(action_index);
        } else if(!this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            sql += " AND t1.block_index < ?";
            args.push(block_index);
        }
        // Support querying using action
        if(!this.util.isNull(action)){
            let action_id  = await this.createAction(action);
            sql += " AND a1.action_id=?";
            args.push(action_id);
        }
        if(['credits','debits'].indexOf(table) != -1){
            let db    = await this.getConnection();
            let query = `SELECT 
                    m.tick_id,
                    m.amount,
                    t2.decimals
                FROM
                    ` + table + ` m
                    INNER JOIN actions       a1 ON (a1.action_index=m.action_index)
                    INNER JOIN transactions  t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN tokens        t2 ON (t2.tick_id=m.tick_id)
                    INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                WHERE 
                    m.address_id=?` + sql;
            try {
                let rows = await db.query(query, args);
                if(rows.length > 0){
                    for(let row of rows){
                        if(!data[row.tick_id])
                            data[row.tick_id] = 0;
                        data[row.tick_id] = this.util.bcadd(data[row.tick_id], row.amount, row.decimals);
                    }
                }
            } catch (error){
                this.util.logError('Error looking up addresses ' + table + ' for ' + address + ':', error);
            }
            await this.releaseConnection();
        }
        return data;
    }

    // Handle updating token information (supply, price, etc)
    // @param {tickers} boolean Full update
    // @param {tickers} string  Ticker 
    // @param {tickers} array   Array of Tickers
    async updateTokens(tickers, rollback){
        let tokens = [];
        let type   = typeof tickers;
        if(type==='object'){
            for(let tick of tickers){
                if(!this.util.isNull(tick))
                    tokens.push(tick);
            }
        }
        if(type==='string')
            tokens.push(tickers);
        // Dump full list of tokens
        if(type==='boolean' && tickers===true){
            console.log('Updating all tokens...');
            let db    = await this.getConnection();
            let query = "SELECT t2.tick FROM tokens t1, index_tickers t2 WHERE t1.tick_id=t2.id";
            try {
                let rows = await db.query(query);
                if(rows.length > 0)
                    for(let row of rows)
                        tokens.push(row.tick);
            } catch (error){
                this.util.logError('Error while trying to get list of all tokens:', error);
            }
            await this.releaseConnection();
        }
        // Loop through tokens and update basic info
        for(let tick of tokens)
            await this.updateTokenInfo(tick);
    }

    // Handle getting token info (supply, price, etc) and updating the `tokens` table
    async updateTokenInfo(tick){
        let tick_id = await this.createTicker(tick);
        // Lookup current token information
        let data = await this.getTokenInfo(tick);
        // Update the record in `tokens` table
        if(data)
            await this.createToken(data);
    }

    // Get action_index of the first valid ISSUE action for a given ticker
    async getFirstIssueActionIndex(tick){
        let tick_id      = await this.createTicker(tick);
        let action_index = false;
        let db    = await this.getConnection();
        let query = `SELECT 
                        i.action_index 
                    FROM 
                        issues i,
                        INNER JOIN index_statuses s ON (s.id=i.status_id)
                    WHERE 
                        i.tick_id=? AND 
                        s.status='valid'
                    ORDER BY 
                        action_index ASC 
                    LIMIT 1`;
        let args = [tick_id];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                action_index = Number(rows[0].action_index);
        } catch (error) {
            this.util.logError('Error looking up action_index of first valid issue:', error);
        }
        await this.releaseConnection();
        return action_index;
    }

    // Validate if a ticker exists before before a given action_index
    async validTickerBeforeTxIndex(tick, action_index){
        let issue_index = await this.getFirstIssueActionIndex(tick);
        if(issue_index < action_index)
            return true;
        return false;
    }

    // Validate if ADDRESS is in SLEEP mode
    async isAddressSleeping(address, block_index){
        let sleep = false;
        if(!this.util.isNull(address) && this.util.isCryptoAddress(address) && !this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            let id    = await this.createAddress(address);
            let db    = await this.getConnection();
            let query = `SELECT 
                            s1.resume_block 
                        FROM 
                            sleeps s1
                            INNER JOIN actions        a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                        WHERE 
                            s1.type=? AND
                            t1.source_id=? AND
                            s2.status=?
                        ORDER BY 
                            s1.action_index DESC
                        LIMIT 1`;
            let args = [1, id, 'valid'];
            try {
                let rows = await db.query(query, args);
                if(rows.length > 0){
                    let resume_block = Number(rows[0].resume_block);
                    if(resume_block ==  -1 || resume_block > block_index)
                        sleep = true;
                }
            } catch (error) {
                this.util.logError('Error looking up resume_block record for address in sleeps table:', error);
            }
            await this.releaseConnection();
        }
        return sleep;
    }

    // Validate if TICK is in SLEEP mode
    async isTickSleeping(tick, block_index){
        let sleep = false;
        if(!this.util.isNull(tick) && !this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            let id    = await this.createTicker(tick);
            let db    = await this.getConnection();
            let query = `SELECT 
                            s1.resume_block 
                        FROM 
                            sleeps s1
                            INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                        WHERE 
                            s1.type=? AND
                            s1.tick_id=? AND
                            s2.status=?
                        ORDER BY 
                            s1.action_index DESC
                        LIMIT 1`;
            let args = [2, id, 'valid'];
            try {
                let rows = await db.query(query, args);
                if(rows.length > 0){
                    let resume_block = Number(rows[0].resume_block);
                    if(resume_block ==  -1 || resume_block > block_index)
                        sleep = true;
                }
            } catch (error) {
                this.util.logError('Error looking up resume_block record for tick in sleeps table:', error);
            }
            await this.releaseConnection();
        }
        return sleep;
    }

    // Check if an address is allowed to perform an action
    // Validations: 
    // - Ticker  is allowed to perform actions (sleep)
    // - Address is allowed to perform actions (sleep)
    // - Address is allowed to hold tick (allow/block lists)
    async isActionAllowed(address, tick, block_index){
        let allow = true;
        // Validate block_index is good
        if(allow && !this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            // Validate TICK is not in SLEEP mode
            if(allow && !this.util.isNull(tick) && await this.isTickSleeping(tick, block_index))
                allow = false;
            // Validate ADDRESS is not in a SLEEP mode
            if(allow && !this.util.isNull(address) && await this.isAddressSleeping(address, block_index))
                allow = false;
        }
        // Validate address against any tick allow/block lists
        if(allow && !this.util.isNull(address) && !this.util.isNull(tick)){
            let info = await this.getTokenInfo(tick);
            let list = null;
            // False if we have an ALLOW_LIST and address is NOT on it
            if(allow && !this.util.isNull(info['ALLOW_LIST']) && this.util.isNumeric(info['ALLOW_LIST'])){
                list = await this.getList(info['ALLOW_LIST']);
                if(!list.includes(address))
                    allow = false;
            }
            // False if we have an BLOCK_LIST and address IS on it
            if(allow && !this.util.isNull(info['BLOCK_LIST']) && this.util.isNumeric(info['BLOCK_LIST'])){
                list = await this.getList(info['BLOCK_LIST']);
                if(list.includes(address))
                    allow = false;
            }
        }
        return allow;
    }

    // Get total amount of credit or debit records for a given address, ticker, and action
    async getActionCreditDebitAmount(table, action, tick, address, action_index){
        let total   = 0;
        let tick_id = await this.createTicker(tick);
        let addr_id = await this.createAddress(address);
        let data    = await this.getAddressCreditDebit(table, addr_id, action, null, action_index);
        if(data[tick_id])
            total = data[tick_id];
        return total;
    }

    // Lookup a record in the `index_memos` table and return record id
    async getMemoId(memo){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_memos WHERE memo=? LIMIT 1";
        try {
            let rows = await db.query(query, [memo]);
            if(rows.length > 0)
                id = Number(rows[0].id);
        } catch (error) {
            this.util.logError('Error looking up ticker record id in index_memos table:', error);
        }
        await this.releaseConnection();
        return id;
    }

    // Create records in the 'index_memos' table and return record id
    async createMemo(memo){
        // Ignore empty memo and return NULL
        if(this.util.isNull(memo))
            return null;
        // Truncate memos to 250 characters
        memo = String(memo).substring(0,250);
        var id = await this.getMemoId(memo);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            let query = "INSERT INTO index_memos (memo) values (?)";
            try {
                let result = await db.query(query, [memo]);
                if(result.insertId)
                    id = Number(result.insertId);
            } catch (error) {
                this.util.logError('Error trying to create memo record in index_memos table:', error);
            }
            await this.releaseConnection();
        }
        return id;
    }

    // Create/Update record in `mints` table
    async createMint(data){
        // Normalize data
        data               = this.truncateDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        // Check if record already exists for this mint
        let db     = await this.getConnection();
        let query  = "SELECT action_index FROM mints WHERE action_index=? LIMIT 1";
        let exists = false;
        try {
            let rows = await db.query(query, [action_index]);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in mints table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        mints
                    SET
                        tick_id=?,
                        amount=?,
                        destination_id=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO mints (tick_id, amount, destination_id, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        let args = [tick_id, amount, destination_id, memo_id, status_id, action_index];
        // Create or Update the record in the mints table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in mints table:', error);
        }
        await this.releaseConnection();
    }

    // Create record in `list_edits` table
    async createListEdit(data, item, status){
        let action_index = data['ACTION_INDEX'];
        let status_id = await this.createStatus(status);
        let item_id   = null;
        if(data['TYPE']==1)
            item_id = await this.createTicker(item);
        if(data['TYPE']==2)
            item_id = await this.createAddress(item);
        // Check if record already exists for this list
        let db     = await this.getConnection();
        let query  = "SELECT item_id FROM list_edits WHERE action_index=? AND item_id=? AND status_id=? LIMIT 1";
        let args   = [action_index, item_id, status_id];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in list_edits table:', error);
        }
        // INSERT record
        if(!exists){
            query = "INSERT INTO list_edits (action_index, item_id, status_id) values (?, ?, ?)";
            try {
                let rows = await db.query(query, args);
            } catch (error){
                this.util.logError('Error trying to create record in list_edits table:', error);
            }
        }
        await this.releaseConnection();
    }

    // Create record in `list_items` table
    async createListItem(data, item){
        let action_index = data['ACTION_INDEX'];
        let item_id      = null;
        if(data['TYPE']==1)
            item_id = await this.createTicker(item);
        if(data['TYPE']==2)
            item_id = await this.createAddress(item);
        // Check if record already exists for this list
        let db     = await this.getConnection();
        let query  = "SELECT item_id FROM list_items WHERE action_index=? AND item_id=? LIMIT 1";
        let args   = [action_index, item_id];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in list_items table:', error);
        }
        // INSERT record
        if(!exists){
            query = "INSERT INTO list_items (action_index, item_id) values (?, ?)";
            try {
                let rows = await db.query(query, args);
            } catch (error){
                this.util.logError('Error trying to create record in list_items table:', error);
            }
        }
        await this.releaseConnection();
    }

    // Create record in `list_items_invalid` table
    async createListItemInvalid(data, item, status){
        let action_index = data['ACTION_INDEX'];
        let status_id    = await this.createStatus(status);
        let item_id      = null;
        if(data['TYPE']==1)
            item_id = await this.createTicker(item);
        if(data['TYPE']==2)
            item_id = await this.createAddress(item);
        // Check if record already exists for this list
        let db     = await this.getConnection();
        let query  = "SELECT item_id FROM list_items_invalid WHERE action_index=? AND item_id=? AND status_id=? LIMIT 1";
        let args   = [action_index, item_id, status_id];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in list_items_invalid table:', error);
        }
        // INSERT record
        if(!exists){
            query = "INSERT INTO list_items_invalid (action_index, item_id, status_id) values (?, ?, ?)";
            try {
                let rows = await db.query(query, args);
            } catch (error){
                this.util.logError('Error trying to create record in list_items_invalid table:', error);
            }
        }
        await this.releaseConnection();
    }


    // Validate that token supplys match credits/debits/balances information
    async sanityCheck(block_index){
        // Ignore any calls without a block index
        if(this.util.isNull(block_index))
            return;
        let tickers  = {};
        let decimals = {};
        let db       = await this.getConnection();
        // Get list of tickers and supply from credits/debits/escrows/tokens tables using block_index
        let query   = `SELECT
                        DISTINCT(x.tick_id),
                        t2.tick,
                        t1.decimals
                    FROM 
                        (
                            SELECT 
                                c.tick_id 
                            FROM 
                                credits c
                                INNER JOIN actions      a ON (c.action_index=a.action_index)
                                INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                            WHERE 
                                t.block_index=? 
                            UNION
                            SELECT 
                                d.tick_id 
                            FROM 
                                debits d
                                INNER JOIN actions      a ON (d.action_index=a.action_index)
                                INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                            WHERE 
                                t.block_index=? 
                            UNION
                            SELECT 
                                e.tick_id 
                            FROM 
                                escrows e
                                INNER JOIN actions      a ON (e.action_index=a.action_index)
                                INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                            WHERE 
                                t.block_index=? 
                        ) as x
                        INNER JOIN tokens        t1 ON (t1.tick_id=x.tick_id)
                        INNER JOIN index_tickers t2 ON (t2.id=x.tick_id)
                    ORDER BY 
                        t2.tick ASC`;
        try {
            let rows = await db.query(query, [block_index, block_index, block_index]);
            if(rows.length >0){
                for(let row of rows){
                    // Add ticker, decimal, and supply info to assoc arrays
                    tickers[row.tick]  = Number(row.tick_id);
                    decimals[row.tick] = row.decimals;
                };
            }
        } catch (error){
            this.util.logError('Error looking up credits/debits in block:', error);
        }
        // Loop through the tickers and validate token supply match credits/debits/balances info
        for(let tick in tickers){
            let tick_id = tickers[tick];
            let ledger  = this.util.bcnum(await this.getTokenSupply(tick));        // Supply from ledger (credits - debits + escrows)
            let token   = this.util.bcnum(await this.getTokenSupplyToken(tick));   // Supply from tokens
            let balance = this.util.bcnum(await this.getTokenSupplyBalance(tick)); // Supply from balances
            let escrow  = this.util.bcnum(await this.getTokenSupplyEscrow(tick));  // Supply from escrows
            let total   = this.util.bcadd(balance, escrow, decimals[tick]);        // Total (balances + escrows)
            // DEBUG : Dump information on the sanity check failure
            if(token!=ledger || token!=total){
                console.log("Tick,   tick_id =", tick, tick_id);
                console.log("token   supply =", token);
                console.log("ledger  supply =", ledger);  // Credits / Debits / Escrows
                console.log("balance supply =", balance); // balances table
                console.log("escrow  supply =", escrow);  // Escrows
                console.log("total   supply =", total);   // balance + escrow
            }
            if(token!=ledger)
                this.util.throwError("SanityError: ledger supply does not match token supply : " + tick + " (" + ledger + " != " + token + ")");
            if(token!=total)
                this.util.throwError("SanityError: total supply does not match token supply : " + tick + " (" + total + " != " + token + ")");
        }
        await this.releaseConnection();
    }

    // Create record in `addresses` table
    async createAddressOption(data){
        // Normalize data
        data               = this.truncateDataValues(data);
        let status_id      = await this.createStatus(data['STATUS']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let action_index   = data['ACTION_INDEX'];
        let fee_preference = data['FEE_PREFERENCE'];
        let require_memo   = data['REQUIRE_MEMO'];
        // Check if record already exists for this address
        let db     = await this.getConnection();
        let query  = "SELECT action_index FROM addresses WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in addresses table:', error);
        }
        if(exists){
            query = `UPDATE
                        addresses
                    SET
                        fee_preference=?,
                        require_memo=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            query = "INSERT INTO addresses (fee_preference, require_memo, memo_id, status_id, action_index) values (?, ?, ?, ?, ?)";
        }
        try {
            let rows = await db.query(query, [fee_preference, require_memo, memo_id, status_id, action_index]);
        } catch (error){
            this.util.logError('Error trying to create record in addresses table:', error);
        }
        await this.releaseConnection();
    }

    // Create record in `batches` table
    async createBatch(data){
        // Normalize data
        data             = this.truncateDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        // Check if record already exists for this address
        let db    = await this.getConnection();
        let query = "SELECT action_index FROM batches WHERE action_index=? LIMIT 1";
        let args  = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in batches table:', error);
        }
        if(exists){
            query = `UPDATE
                        batches
                    SET
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            query = "INSERT INTO batches (status_id, action_index) values (?, ?)";
        }
        args = [status_id, action_index];
        try {
            let rows = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in batches table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `sends` table
    async createSend(data){
        // Normalize data
        data               = this.truncateDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        // Check if record already exists for this send
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            sends
                        WHERE
                            tick_id=? AND
                            destination_id=? AND
                            amount=? AND
                            action_index=?`;
        let args = [tick_id, destination_id, amount, action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in sends table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        sends
                    SET
                        tick_id=?,
                        destination_id=?,
                        amount=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO sends (tick_id, destination_id, amount, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args = [tick_id, destination_id, amount, memo_id, status_id, action_index];
        // Create or Update the record in the sends table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in sends table:', error);
        }
        await this.releaseConnection();
    }

    // Get address preferences for a given address
    async getAddressPreferences(address, block_index, action_index){
        let id   = await this.createAddress(address);
        // Set default address preferences
        let data = {};
        data['FEE_PREFERENCE'] = 2; // 2=Donate FEES to development
        data['REQUIRE_MEMO']   = 0; // 0=Do NOT Require memo on SENDs to this address
        // Build out the SQL query and arguments
        let sql  = '';
        let args = [id, 'valid'];
        // Query using either block_index OR action_index
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            sql += " AND a1.action_index < ?";
            args.push(action_index);
        } else if(!this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            sql += " AND t1.block_index < ?";
            args.push(block_index);
        }
        // Lookup the address preferences
        let db    = await this.getConnection();
        let query = `SELECT 
                a1.fee_preference,
                a1.require_memo
            FROM
                addresses                 a1
                INNER JOIN actions        a2 ON (a1.action_index=a2.action_index)
                INNER JOIN transactions   t1 ON (t1.tx_index=a2.tx_index)
                INNER JOIN index_statuses s1 ON (s1.id=a1.status_id)
            WHERE 
                t1.source_id=? AND 
                s1.status=?` + sql + `
            ORDER BY 
                a1.action_index ASC`;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0){
                for(let row of rows){
                    data['FEE_PREFERENCE'] = row.fee_preference;
                    data['REQUIRE_MEMO']   = row.require_memo;
                }
            }
        } catch (error){
            this.util.logError('Error looking up address preferences in the addresses table:', error);
        }
        await this.releaseConnection();
        return data;
    }

    // Create/Update record in `airdrops` table
    async createAirdrop(data){
        // Normalize data
        data                  = this.truncateDataValues(data);
        let tick_id           = await this.createTicker(data['TICK']);
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let amount            = data['AMOUNT'];
        let list_action_index = (!this.util.isNumeric(data['LIST_ACTION_INDEX'])) ? null : data['LIST_ACTION_INDEX'];
        // Check if record already exists for this airdrop
        let db    = await this.getConnection();
        let query = `SELECT
                        action_index
                    FROM
                        airdrops
                    WHERE
                        tick_id=? AND
                        memo_id=? AND
                        list_action_index=? AND
                        amount=? AND
                        action_index=?`;
        let args  = [tick_id, memo_id, list_action_index, amount, action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in airdrops table:', error);
        }
        // Define list of arguments for sql insert/update
        args = [tick_id, list_action_index, amount, memo_id, status_id, action_index];
        if(exists){
            // UPDATE record
            query = `UPDATE
                        airdrops
                    SET
                        tick_id=?,
                        list_action_index=?,
                        amount=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO airdrops (tick_id, list_action_index, amount, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        // Create or Update the record in the airdrops table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in airdrops table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `fees` table
    async createFeeRecord(data){
        // Normalize data
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        let method         = data['METHOD'];
        // Check if record already exists for this airdrop
        let db     = await this.getConnection();
        let query = `SELECT
                        action_index
                    FROM
                        fees
                    WHERE
                        action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in fees table:', error);
        }
        // Define list of arguments for sql insert/update
        args = [tick_id, destination_id, amount, method, action_index];
        if(exists){
            // UPDATE record
            query = `UPDATE
                        fees
                    SET
                        tick_id=?,
                        destination_id=?,
                        amount=?,
                        method=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO fees (tick_id, destination_id, amount, method, action_index) values (?, ?, ?, ?, ?)`;
        }
        // Create or Update the record in the fees table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in fees table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `destroys` table
    async createDestroy(data){
        // Normalize data
        data               = this.truncateDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        // Check if record already exists for this destroy
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            destroys
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in destroys table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        destroys
                    SET
                        tick_id=?,
                        amount=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO destroys (tick_id, amount, memo_id, status_id, action_index) values (?, ?, ?, ?, ?)`;
        }
        args = [tick_id, amount, memo_id, status_id, action_index];
        // Create or Update the record in the destroys table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in destroys table:', error);
        }
        await this.releaseConnection();
    }

    // Get tokens owned by a given address
    async getAddressOwnerships(address){
        let id   = await this.createAddress(address);
        let data = {};
        // Lookup the address preferences
        let db    = await this.getConnection();
        let query = `SELECT 
                        t1.tick_id,
                        t2.tick
                    FROM
                        tokens t1
                        INNER JOIN index_tickers t2 ON (t2.id=t1.tick_id)
                    WHERE 
                        t1.owner_id=? 
                    ORDER BY 
                        t2.tick`;
        try {
            let rows = await db.query(query, [id]);
            if(rows.length > 0){
                for(let row of rows){
                    data[row.tick_id] = row.tick;
                }
            }
        } catch (error){
            this.util.logError('Error looking up tokens owned by address in the tokens table:', error);
        }
        await this.releaseConnection();
        return data;
    }

    // Create/Update record in `sweeps` table
    async createSweep(data){
        // Normalize data
        data               = this.truncateDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let balances       = data['BALANCES'];
        let ownerships     = data['OWNERSHIPS'];
        // Check if record already exists for this sweep
        let db    = await this.getConnection();
        let query = `SELECT
                        action_index
                    FROM
                        sweeps
                    WHERE
                        action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in sweeps table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        sweeps
                    SET
                        destination_id=?,
                        balances=?,
                        ownerships=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO sweeps (destination_id, balances, ownerships, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args = [destination_id, balances, ownerships, memo_id, status_id, action_index];
        // Create or Update the record in the sweeps table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in sweeps table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `dividends` table
    async createDividend(data){
        // Normalize data
        data                 = this.truncateDataValues(data);
        let tick_id          = await this.createTicker(data['TICK']);
        let dividend_tick_id = await this.createTicker(data['DIVIDEND_TICK']);
        let memo_id          = await this.createMemo(data['MEMO']);
        let status_id        = await this.createStatus(data['STATUS']);
        let action_index     = data['ACTION_INDEX'];
        let amount           = data['AMOUNT'];
        // Check if record already exists for this dividend
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            dividends
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in dividends table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dividends
                    SET
                        tick_id=?,
                        dividend_tick_id=?,
                        amount=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;

        } else {
            // INSERT record
            query = `INSERT INTO dividends (tick_id, dividend_tick_id, amount, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args = [tick_id, dividend_tick_id, amount, memo_id, status_id, action_index];
        // Create or Update the record in the dividends table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in dividends table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `callbacks` table
    async createCallback(data){
        // Normalize data
        data                 = this.truncateDataValues(data);
        let tick_id          = await this.createTicker(data['TICK']);
        let callback_tick_id = await this.createTicker(data['CALLBACK_TICK']);
        let memo_id          = await this.createMemo(data['MEMO']);
        let status_id        = await this.createStatus(data['STATUS']);
        let action_index     = data['ACTION_INDEX'];
        let callback_amount  = data['CALLBACK_AMOUNT'];
        // Check if record already exists for this callback
        let db     = await this.getConnection();
        let query = `SELECT
                        action_index
                    FROM
                        callbacks
                    WHERE
                        action_index=?`; 
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in callbacks table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        callbacks
                    SET
                        tick_id=?,
                        callback_tick_id=?,
                        callback_amount=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;

        } else {
            // INSERT record
            query = `INSERT INTO callbacks (tick_id, callback_tick_id, callback_amount, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args = [tick_id, callback_tick_id, callback_amount, memo_id, status_id,  action_index];
        // Create or Update the record in the callbacks table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in callbacks table:', error);
        }
        await this.releaseConnection();
    }

    // Lookup a record in the `index_mime_types` table and return record id
    async getMimeTypeId(type){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_mime_types WHERE `type`=? LIMIT 1";
        let args  = [type];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                id = Number(rows[0].id);
        } catch (error) {
            this.util.logError('Error looking up MIME type record id in index_mime_types table:', error);
        }
        await this.releaseConnection();
        return id;
    }

    // Create records in the 'index_mime_types' table and return record id
    async createMimeType(type){
        // Ignore empty mime type and return NULL
        if(this.util.isNull(type))
            return null;
        var id = await this.getMimeTypeId(type);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            let query = "INSERT INTO index_mime_types (`type`) values (?)";
            let args  = [type];
            try {
                let result = await db.query(query, args);
                if(result.insertId)
                    id = Number(result.insertId);
            } catch (error) {
                this.util.logError('Error trying to create MIME type record in index_mime_types table:', error);
            }
            await this.releaseConnection();
        }
        return id;
    }

    // Create/Update record in `files` table
    async createFile(data){
        // Normalize data
        data             = this.truncateDataValues(data);
        let type_id      = await this.createMimeType(data['TYPE']);
        let memo_id      = await this.createMemo(data['MEMO']);
        let status_id    = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        let name         = data['NAME'];
        let title        = data['TITLE'];
        // Check if record already exists for this file
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            files
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in files table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        files
                    SET
                        name=?,
                        title=?,
                        type_id=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO files (name, title, type_id, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args = [name, title, type_id, memo_id, status_id, action_index];
        // Create or Update the record in the files table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in files table:', error);
        }
        await this.releaseConnection();
    }

    // Lookup a record in the `index_coins` table and return record id
    async getCoinId(coin){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_coins WHERE `coin`=? LIMIT 1";
        let args  = [coin];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                id = Number(rows[0].id);
        } catch (error) {
            this.util.logError('Error looking up coin record id in index_coins table:', error);
        }
        await this.releaseConnection();
        return id;
    }

    // Create records in the 'index_coins' table and return record id
    async createCoin(coin){
        // Ignore empty coin and return NULL
        if(this.util.isNull(coin))
            return null;
       var id = await this.getCoinId(coin);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            let query = "INSERT INTO index_coins (`coin`) values (?)";
            let args  = [coin];
            try {
                let result = await db.query(query, args);
                if(result.insertId)
                    id = Number(result.insertId);
            } catch (error) {
                this.util.logError('Error trying to create coin record in index_coins table:', error);
            }
            await this.releaseConnection();
        }
        return id;
    }    

    // Lookup table associated with an action
    async getActionIndexTable(action_index){
        let table  = null;
        let db     = await this.getConnection();
        let query  = `SELECT 
                        LCASE(a2.action) as action
                    FROM 
                        actions a1
                        INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                    WHERE
                        a1.action_index=?
                    LIMIT 1`;
        let args   = [action_index];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0){
                let action = rows[0].action;
                if(['address','batch','dispense'].includes(action)){
                    table = action + 'es';
                } else {
                    table = action + 's';
                }
            }
        } catch (error) {
            this.util.logError('Error trying to lookup action table name from index_actions table:', error);
        }
        await this.releaseConnection();
        return table;
    }

    // Verify that a given action_index is associated with a `valid` transaction
    async isActionIndexValid(action_index){
        let valid = false;
        let table = await this.getActionIndexTable(action_index);
        if(!this.util.isNull(table)){
            let db    = await this.getConnection();
            let query = `SELECT 
                            m.action_index
                        FROM 
                            ` + table + ` m
                            LEFT JOIN index_statuses s ON (s.id=m.status_id)
                        WHERE
                            m.action_index=? AND
                            s.status='valid'`;
            let args = [action_index];
            try {
                let rows = await db.query(query, args);
                if(rows.length > 0)
                    valid = true;
            } catch (error) {
                this.util.logError('Error looking up if action_index is valid :', error);
            }
            await this.releaseConnection();
        }
        return valid;
    }

    // Create/Update record in `links` table
    async createLink(data){
        // Normalize data
        data                   = this.truncateDataValues(data);
        let coin1_id           = await this.createCoin(data['COIN1']);
        let coin2_id           = await this.createCoin(data['COIN2']);
        let memo_id            = await this.createMemo(data['MEMO']);
        let status_id          = await this.createStatus(data['STATUS']);
        let action_index       = data['ACTION_INDEX'];
        let coin1_action_index = data['COIN1_ACTION_INDEX'];
        let coin2_action_index = data['COIN2_ACTION_INDEX'];
        // Check if record already exists for this link
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            links
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in links table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        links
                    SET
                        coin1_id=?,
                        coin1_action_index=?,
                        coin2_id=?,
                        coin2_action_index=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO links (coin1_id, coin1_action_index, coin2_id, coin2_action_index, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args = [coin1_id, coin1_action_index, coin2_id, coin2_action_index, memo_id, status_id, action_index];
        // Create or Update the record in the links table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in links table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `broadcasts` table
    async createBroadcast(data){
        // Normalize data
        data                       = this.truncateDataValues(data);
        let memo_id                = await this.createMemo(data['MEMO']);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let broadcast_action_index = data['BROADCAST_ACTION_INDEX'];
        let message                = data['MESSAGE'];
        let value                  = data['VALUE'];
        let fee                    = data['FEE'];
        // Check if record already exists for this broadcast
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            broadcasts
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in broadcasts table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        broadcasts
                    SET
                        message=?,
                        value=?,
                        fee=?,
                        broadcast_action_index=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO broadcasts (message, value, fee, broadcast_action_index, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args = [message, value, fee, broadcast_action_index, memo_id, status_id, action_index];
        // Create or Update the record in the broadcasts table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in broadcasts table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `messages` table
    async createMessage(data){
        // Normalize data
        data                  = this.truncateDataValues(data);
        let destination_id    = await this.createAddress(data['DESTINATION']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let encryption_method = data['ENCRYPTION_METHOD'];
        let encryption_key    = data['ENCRYPTION_KEY'];
        let encrypted_message = data['ENCRYPTED_MESSAGE'];
        let plaintext_message = data['PLAINTEXT_MESSAGE'];
        // Check if record already exists for this message
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            messages
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in messages table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        messages
                    SET
                        encryption_method=?,
                        encryption_key=?,
                        encrypted_message=?,
                        plaintext_message=?,
                        destination_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO messages (encryption_method, encryption_key, encrypted_message, plaintext_message, destination_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args = [encryption_method, encryption_key, encrypted_message, plaintext_message, destination_id, status_id, action_index];
        // Create or Update the record in the messages table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in messages table:', error);
        }
        await this.releaseConnection();
    }        

    // Create/Update record in `sleeps` table
    async createSleep(data){
        // Normalize data
        data             = this.truncateDataValues(data);
        let tick_id      = await this.createTicker(data['TICK']);
        let memo_id      = await this.createMemo(data['MEMO']);
        let status_id    = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        let resume_block = data['RESUME_BLOCK'];
        let type         = (data['TYPE']=='TICK') ? 2 : 1;
        // Check if record already exists for this sleep
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            sleeps
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in sleeps table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        sleeps
                    SET
                        type=?,
                        tick_id=?,
                        resume_block=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO sleeps (type, tick_id, resume_block, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args = [type, tick_id, resume_block, memo_id, status_id, action_index];
        // Create or Update the record in the sleeps table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in sleeps table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `swaps` table
    async createSwap(data){
        // Normalize data
        data               = this.truncateDataValues(data);
        let give_coin_id   = await this.createCoin(data['GIVE_COIN']);
        let give_tick_id   = await this.createTicker(data['GIVE_TICK']);
        let get_coin_id    = await this.createCoin(data['GET_COIN']);
        let get_tick_id    = await this.createTicker(data['GET_TICK']);
        let get_address_id = await this.createAddress(data['GET_ADDRESS']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let give_amount    = data['GIVE_AMOUNT'];
        let get_amount     = data['GET_AMOUNT'];
        let expiration     = data['EXPIRATION'];
        let allow_list     = data['ALLOW_LIST'];
        let block_list     = data['BLOCK_LIST'];
        // Check if record already exists for this swap
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            swaps
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in swaps table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swaps
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_address_id=?,
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO swaps (give_coin_id, give_tick_id, give_amount, get_coin_id, get_tick_id, get_amount, get_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args = [give_coin_id, give_tick_id, give_amount, get_coin_id, get_tick_id, get_amount, get_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index];
        // Create or Update the record in the swaps table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in swaps table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `swap_statuses` table
    // @param {action_index}     integer Action index of action
    // @param {swap_action_tick} integer Action index of swap
    // @param {status}           string  Status of the referenced swap (open/complete/cancelled/expired)
    async createSwapStatus(action_index, swap_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in swap_statuses table
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            swap_statuses
                        WHERE
                            action_index=? AND
                            swap_action_index=?`;
        let args = [action_index, swap_action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in swap_statuses table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swap_statuses
                    SET
                        status_id=?
                    WHERE 
                        action_index=? AND
                        swap_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO swap_statuses (status_id, action_index, swap_action_index) values (?, ?, ?)`;
        }
        args = [status_id, action_index, swap_action_index];
        // Create or Update the record in the swap_statuses table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in swap_statuses table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `swap_cancels` table
    async createSwapCancel(data){
        // Normalize data
        data                  = this.truncateDataValues(data);
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let swap_action_index = data['SWAP_ACTION_INDEX'];
        // Check if record already exists for this swap_cancel
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            swap_cancels
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in swap_cancels table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swap_cancels
                    SET
                        memo_id=?,
                        status_id=?,
                        swap_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO swap_cancels (memo_id, status_id, swap_action_index, action_index) values (?, ?, ?, ?)`;
        }
        args = [memo_id, status_id, swap_action_index, action_index];
        // Create or Update the record in the swap_cancels table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in swap_cancels table:', error);
        }
        await this.releaseConnection();
    }


    // Return swap info for given action_index
    async getSwapInfo(coin, action_index){
        let swap = false;
        let db    = await this.getConnection();
        let query = `SELECT 
                        s.action_index,
                        t2.tick as give_tick,
                        s.give_amount,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        s.get_amount,
                        a2.address as source,
                        a3.address as get_address,
                        s.expiration,
                        s.allow_list,
                        s.block_list,
                        m1.memo,
                        s1.status,
                        b1.block_index,
                        b1.block_time
                    FROM 
                        swaps s
                        INNER JOIN actions         a1 ON (a1.action_index=s.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses a3 ON (a3.id=s.get_address_id)
                        INNER JOIN index_tickers   t2 ON (t2.id=s.give_tick_id)
                        INNER JOIN index_tickers   t3 ON (t3.id=s.get_tick_id)
                        INNER JOIN index_coins     c1 ON (c1.id=s.get_coin_id)
                        INNER JOIN index_memos     m1 ON (m1.id=s.memo_id)
                        INNER JOIN index_statuses  s1 ON (s1.id=s.status_id)
                    WHERE 
                        c1.coin=? AND
                        s.action_index=? 
                    LIMIT 1`;
        let args  = [coin, action_index];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0){
                swap = {};
                swap['GIVE_COIN'] = this.config['COIN'];
                for(let key in rows[0]){
                    let name  = String(key).toUpperCase()
                    let value = rows[0][key];
                    if(['ACTION_INDEX', 'BLOCK_INDEX', 'BLOCK_TIME', 'EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST'].includes(name))
                        value = Number(value);
                    swap[name] = value;
                }
                // Get SWAP_STATUS from the swap_statuses table
                swap['SWAP_STATUS'] = await this.getSwapStatus(action_index);
                // Get updated swap properties from the swap_edits table
                let edit = await this.getSwapEdits(action_index);
                if(edit.expiration)
                    swap['EXPIRATION'] = edit.expiration;
                if(edit.allow_list)
                    swap['ALLOW_LIST'] = edit.allow_list;
                if(edit.block_list)
                    swap['BLOCK_LIST'] = edit.block_list;
            }
        } catch (error) {
            this.util.logError('Error looking up swap using swaps table:', error);
        }
        await this.releaseConnection();
        return swap;
    }

    // Return swap info for given action_index
    async getSwapStatus(action_index){
        let status = false;
        let db     = await this.getConnection();
        let query  = `SELECT 
                        s2.status
                    FROM 
                        swap_statuses s1
                        INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                    WHERE 
                        s1.swap_action_index=?
                    ORDER BY
                        s1.action_index DESC
                    LIMIT 1`;
        let args  = [action_index];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                status = rows[0].status;
        } catch (error) {
            this.util.logError('Error looking up swap status using swap_statuses table:', error);
        }
        await this.releaseConnection();
        return status;
    }

    // Return swap edit information for given action_index
    async getSwapEdits(action_index){
        // Define empty edit object
        let edit  = {
            expiration: false,
            allow_list: false,
            block_list: false
        };
        let db     = await this.getConnection();
        let query  = `SELECT 
                        s1.expiration,
                        s1.allow_list,
                        s1.block_list
                    FROM 
                        swap_edits s1
                        INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                    WHERE 
                        s1.swap_action_index=? AND
                        s2.status=?
                    ORDER BY
                        s1.action_index ASC`;
        let args  = [action_index, 'valid'];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0){
                for(let row of rows){
                    if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration)) edit.expiration = Number(row.expiration);
                    if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list)) edit.allow_list = Number(row.allow_list);
                    if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list)) edit.block_list = Number(row.block_list);
                }
            }
        } catch (error) {
            this.util.logError('Error looking up swap edits using swap_edits table:', error);
        }
        await this.releaseConnection();
        return edit;
    }

    // Handle removing an escrow record for a given ACTION_INDEX
    async removeEscrowRecord(action_index){
        let db    = await this.getConnection();
        let query = `DELETE FROM escrows WHERE action_index=?`;
        let args  = [action_index];
        try {
            let result = await db.query(query, args);
        } catch (error) {
            this.util.logError('Error deleting record from the escrows table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `swap_edits` table
    async createSwapEdit(data){
        // Standardize LIST values to numeric or NULL
        for(let list of this.config['LIST_FIELDS']){
            if(this.util.isNull(data[list]) || !this.util.isNumeric(data[list]))
                delete data[list];
        }
        // Normalize data
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let swap_action_index = data['SWAP_ACTION_INDEX'];
        let expiration        = data['EXPIRATION'];
        let allow_list        = data['ALLOW_LIST'];
        let block_list        = data['BLOCK_LIST'];
        // Check if record already exists for this swap_edits
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            swap_edits
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in swap_edits table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swap_edits
                    SET
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?,
                        swap_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO swap_edits (expiration, allow_list, block_list, memo_id, status_id, swap_action_index, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args = [expiration, allow_list, block_list, memo_id, status_id, swap_action_index, action_index];
        // Create or Update the record in the swap_edits table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in swap_edits table:', error);
        }
        await this.releaseConnection();
    }

    // Handle looking up potential swap matches
    async getSwapMatches(data){
        let matches = false;
        // Normalize data
        let source_id    = await this.createAddress(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        // Lookup any matching swaps from different addresses (not SOURCE)
        let db    = await this.getConnection();
        let query = `SELECT
                        c1.coin as match_coin,
                        s2.action_index as match_action_index
                    FROM
                        swaps s1,
                        swaps s2
                        INNER JOIN index_coins  c1 ON (c1.id=s2.get_coin_id)
                        INNER JOIN actions      a1 ON (a1.action_index=s2.action_index)
                        INNER JOIN transactions t1 ON (t1.tx_index=a1.tx_index)
                    WHERE
                        s1.give_coin_id=s2.get_coin_id AND
                        s1.give_tick_id=s2.get_tick_id AND
                        s1.give_amount=s2.get_amount AND
                        s1.get_amount=s2.give_amount AND
                        s1.action_index=? AND
                        t1.source_id!=?
                    ORDER BY
                        s2.action_index ASC`;
        let args = [action_index, source_id];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0){
                // Loop through possible matches and get full information on the swap match
                for(let row of rows){
                    let swapInfo = await this.getSwapInfo(row.match_coin, row.match_action_index);
                    if(swapInfo['SWAP_STATUS']=='open'){
                        if(!matches)
                            matches = [];
                        matches.push(swapInfo);
                    }
                }
            }
        } catch (error){
            this.util.logError('Error looking up potential swap matches in swaps table:', error);
        }
        await this.releaseConnection();
        return matches;
    }

    // Create/Update record in `swap_matches` table
    async createSwapMatch(data, swap, match){
        // Normalize data
        data                  = this.truncateDataValues(data);
        let give_coin_id      = await this.createCoin(match['GIVE_COIN']);
        let get_coin_id       = await this.createCoin(match['GET_COIN']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let give_action_index = match['ACTION_INDEX']
        let get_action_index  = swap['ACTION_INDEX'];
        // Check if record already exists for this swap_edits
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            swap_matches
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in swap_matches table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swap_matches
                    SET
                        give_coin_id=?,
                        give_action_index=?,
                        get_coin_id=?,
                        get_action_index=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO swap_matches (give_coin_id, give_action_index, get_coin_id, get_action_index, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args = [give_coin_id, give_action_index, get_coin_id, get_action_index, status_id, action_index];
        // Create or Update the record in the swap_matches table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in swap_matches table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `orders` table
    async createOrder(data){
        // Normalize data
        data = this.truncateDataValues(data);
        // Standardize LIST values to numeric or NULL
        for(let list of this.config['LIST_FIELDS'] ){
            if(this.util.isNull(data[list]) || !this.util.isNumeric(data[list]))
                delete data[list];
        }
        // Normalize data
        let give_coin_id   = await this.createCoin(data['GIVE_COIN']);
        let give_tick_id   = await this.createTicker(data['GIVE_TICK']);
        let get_coin_id    = await this.createCoin(data['GET_COIN']);
        let get_tick_id    = await this.createTicker(data['GET_TICK']);
        let get_address_id = await this.createAddress(data['GET_ADDRESS']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let give_amount    = data['GIVE_AMOUNT'];
        let get_amount     = data['GET_AMOUNT'];
        let expiration     = data['EXPIRATION'];
        let allow_list     = data['ALLOW_LIST'];
        let block_list     = data['BLOCK_LIST'];
        // Check if record already exists for this order
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            orders
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in orders table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        orders
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_address_id=?,
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO orders (give_coin_id, give_tick_id, give_amount, get_coin_id, get_tick_id, get_amount, get_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args = [give_coin_id, give_tick_id, give_amount, get_coin_id, get_tick_id, get_amount, get_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index];
        // Create or Update the record in the orders table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in orders table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `order_statuses` table
    // @param {action_index}      integer Action index of action
    // @param {order_action_tick} integer Action index of order
    // @param {status}            string  Status of the referenced order (open/complete/cancelled/expired)
    async createOrderStatus(action_index, order_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in order_statuses table
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            order_statuses
                        WHERE
                            action_index=? AND
                            order_action_index=?`;
        let args = [action_index, order_action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in order_statuses table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        order_statuses
                    SET
                        status_id=?
                    WHERE 
                        action_index=? AND
                        order_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_statuses (status_id, action_index, order_action_index) values (?, ?, ?)`;
        }
        args = [status_id, action_index, order_action_index];
        // Create or Update the record in the order_statuses table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in order_statuses table:', error);
        }
        await this.releaseConnection();
    }

    // Handle looking up potential order matches
    async getOrderMatches(data){
        let matches = false;
        // Normalize data
        let source_id    = await this.createAddress(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        // Lookup any matching orders from different addresses (not SOURCE)
        // TODO: Add support for looking up orders which are not EXACT matches (Javier)
        let db    = await this.getConnection();
        let query = `SELECT
                        c1.coin as match_coin,
                        o2.action_index as match_action_index
                    FROM
                        orders o1,
                        orders o2
                        INNER JOIN index_coins  c1 ON (c1.id=o2.get_coin_id)
                        INNER JOIN actions      a1 ON (a1.action_index=o2.action_index)
                        INNER JOIN transactions t1 ON (t1.tx_index=a1.tx_index)

                    WHERE
                        o1.give_coin_id=o2.get_coin_id AND
                        o1.give_tick_id=o2.get_tick_id AND
                        o1.give_amount=o2.get_amount AND
                        o1.get_amount=o2.give_amount AND
                        o1.action_index=? AND
                        t1.source_id!=?
                    ORDER BY
                        o2.action_index ASC`;
        let args = [action_index, source_id];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0){
                // Loop through possible matches and get full information on the order match
                for(let row of rows){
                    let orderInfo = await this.getOrderInfo(row.match_coin, row.match_action_index);
                    if(orderInfo['ORDER_STATUS']=='open'){
                        if(!matches)
                            matches = [];
                        matches.push(orderInfo);
                    }
                }
            }
        } catch (error){
            this.util.logError('Error looking up potential order matches in orders table:', error);
        }
        await this.releaseConnection();
        return matches;
    }

    // Return order info for given action_index
    async getOrderInfo(coin, action_index){
        let order = false;
        let db    = await this.getConnection();
        let query = `SELECT 
                        o.action_index,
                        t2.tick as give_tick,
                        o.give_amount,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        o.get_amount,
                        a2.address as source,
                        a3.address as get_address,
                        o.expiration,
                        o.allow_list,
                        o.block_list,
                        m1.memo,
                        s1.status,
                        b1.block_index,
                        b1.block_time
                    FROM 
                        orders o
                        INNER JOIN actions         a1 ON (a1.action_index=o.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses a3 ON (a3.id=o.get_address_id)
                        INNER JOIN index_tickers   t2 ON (t2.id=o.give_tick_id)
                        INNER JOIN index_tickers   t3 ON (t3.id=o.get_tick_id)
                        INNER JOIN index_coins     c1 ON (c1.id=o.get_coin_id)
                        INNER JOIN index_memos     m1 ON (m1.id=o.memo_id)
                        INNER JOIN index_statuses  s1 ON (s1.id=o.status_id)
                    WHERE 
                        c1.coin=? AND
                        o.action_index=? 
                    LIMIT 1`;
        let args  = [coin, action_index];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0){
                order = {};
                order['GIVE_COIN'] = this.config['COIN'];
                for(let key in rows[0]){
                    let name  = String(key).toUpperCase()
                    let value = rows[0][key];
                    if(['ACTION_INDEX', 'BLOCK_INDEX', 'BLOCK_TIME', 'EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST'].includes(name))
                        value = Number(value);
                    order[name] = value;
                }
                // Get ORDER_STATUS from the order_statuses table
                order['ORDER_STATUS'] = await this.getOrderStatus(action_index);
                // Get updated order properties from the order_edits table
                let edit = await this.getOrderEdits(action_index);
                if(edit.expiration)
                    order['EXPIRATION'] = edit.expiration;
                if(edit.allow_list)
                    order['ALLOW_LIST'] = edit.allow_list;
                if(edit.block_list)
                    order['BLOCK_LIST'] = edit.block_list;
            }
        } catch (error) {
            this.util.logError('Error looking up order using orders table:', error);
        }
        await this.releaseConnection();
        return order;
    }

    // Return order info for given action_index
    async getOrderStatus(action_index){
        let status = false;
        let db     = await this.getConnection();
        let query  = `SELECT 
                        s2.status
                    FROM 
                        order_statuses s1
                        INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                    WHERE 
                        s1.order_action_index=?
                    ORDER BY
                        s1.action_index DESC
                    LIMIT 1`;
        let args  = [action_index];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                status = rows[0].status;
        } catch (error) {
            this.util.logError('Error looking up order status using order_statuses table:', error);
        }
        await this.releaseConnection();
        return status;
    }

    // Return order edit information for given action_index
    async getOrderEdits(action_index){
        // Define empty edit object
        let edit  = {
            expiration: false,
            allow_list: false,
            block_list: false
        };
        let db     = await this.getConnection();
        let query  = `SELECT 
                        o.expiration,
                        o.allow_list,
                        o.block_list
                    FROM 
                        order_edits o
                        INNER JOIN index_statuses s ON (s.id=o.status_id)
                    WHERE 
                        o.order_action_index=? AND
                        s.status=?
                    ORDER BY
                        o.action_index ASC`;
        let args  = [action_index, 'valid'];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0){
                for(let row of rows){
                    if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration)) edit.expiration = row.expiration
                    if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list)) edit.allow_list = row.allow_list
                    if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list)) edit.block_list = row.block_list
                }
            }
        } catch (error) {
            this.util.logError('Error looking up order edits using order_edits table:', error);
        }
        await this.releaseConnection();
        return edit;
    }

    // Create/Update record in `order_edits` table
    async createOrderEdit(data){
        // Normalize data
        data                   = this.truncateDataValues(data);
        let memo_id            = await this.createMemo(data['MEMO']);
        let status_id          = await this.createStatus(data['STATUS']);
        let action_index       = data['ACTION_INDEX'];
        let order_action_index = data['ORDER_ACTION_INDEX'];
        let expiration         = data['EXPIRATION'];
        let allow_list         = data['ALLOW_LIST'];
        let block_list         = data['BLOCK_LIST'];
        // Check if record already exists for this order_edits
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            order_edits
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in order_edits table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        order_edits
                    SET
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?,
                        order_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_edits (expiration, allow_list, block_list, memo_id, status_id, order_action_index, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args = [expiration, allow_list, block_list, memo_id, status_id, order_action_index, action_index];
        // Create or Update the record in the order_edits table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in order_edits table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `order_matches` table
    async createOrderMatch(action_index, data, match, status){
        // Normalize data
        data                  = this.truncateDataValues(data);
        let give_coin_id      = await this.createCoin(data['GIVE_COIN']);
        let get_coin_id       = await this.createCoin(data['GET_COIN']);
        let status_id         = await this.createStatus(data['STATUS']);
        let give_action_index = data['ACTION_INDEX'];
        let get_action_index  = match['ACTION_INDEX'];
        // Check if record already exists for this order_matches
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            order_matches
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in order_matches table:', error);
        }
        if(exists){
            // UPDATE record
            query = `UPDATE
                        order_matches
                    SET
                        give_coin_id=?,
                        give_action_index=?,
                        get_coin_id=?,
                        get_action_index=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_matches (give_coin_id, give_action_index, get_coin_id, get_action_index, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args = [give_coin_id, give_action_index, get_coin_id, get_action_index, status_id, action_index];
        // Create or Update the record in the order_matches table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in order_matches table:', error);
        }
        await this.releaseConnection();
    }

    // Create records in the 'mappings_actions' table
    async createActionMapping(action_index, type, value){
        let type_id = null,
            id      = null;
        if(type=='tick'){
            type_id = 1;
            id      = await this.createTicker(value);
        }
        if(type=='address'){
            type_id = 2;
            id      = await this.createAddress(value);
        }
        // Check if record already exists
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            mappings_actions
                        WHERE
                            action_index=? AND
                            type_id=? AND
                            id=?`;
        let args = [action_index, type_id, id];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in mappings_actions table:', error);
        }
        // Create record if it does not already exist
        if(!exists){
            query = `INSERT INTO mappings_actions (action_index, type_id, id) values (?, ?, ?)`;
            try {
                let result = await db.query(query, args);
            } catch (error) {
                this.util.logError('Error trying to create record in mappings_actions table:', error);
            }
        }
        await this.releaseConnection();
    }

    // Create records in the 'mappings_files' table
    async createFileMapping(action_index, type, value){
        let type_id = null,
            id      = null;
        if(type=='tick'){
            type_id = 1;
            id      = await this.createTicker(value);
        }
        // Check if record already exists
        let db     = await this.getConnection();
        let query  = `SELECT
                            action_index
                        FROM
                            mappings_files
                        WHERE
                            action_index=? AND
                            type_id=? AND
                            id=?`;
        let args = [action_index, type_id, id];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in mappings_files table:', error);
        }
        // Create record if it does not already exist
        if(!exists){
            query = `INSERT INTO mappings_files (action_index, type_id, id) values (?, ?, ?)`;
            try {
                let result = await db.query(query, args);
            } catch (error) {
                this.util.logError('Error trying to create record in mappings_files table:', error);
            }
        }
        await this.releaseConnection();
    }




    // Get action type for a given action_index
    async getActionType(action_index){
        let type = null;
        // Lookup the ACTION based on the action_index
        let db     = await this.getConnection();
        let args = [action_index];
        let sql  = `SELECT 
                        a2.action
                    FROM
                        actions a1
                        INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                    WHERE
                        a1.action_index=?`;
        let results = await db.query(sql, args);
        if(results && results.length)
            type = results[0].action;
        await this.releaseConnection();
        return type;
    }

    // Get action information for a given action_index
    async getActionData(action_index){
        let data = null;
        let sql  = null;
        let type = await this.getActionType(action_index);
        if(type){
            // Placeholders for queries and arguments
            // ADDRESS action
            if(type=='ADDRESS'){
                sql = `SELECT
                            a3.action,
                            a1.action_index,
                            a4.address as source,
                            a1.fee_preference,
                            a1.require_memo,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            addresses a1
                            INNER JOIN actions            a2 ON (a2.action_index=a1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a3 ON (a3.id=a2.action_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            a1.action_index=?
                        LIMIT 1`;
            }
            // AIRDROP action
            if(type=='AIRDROP'){
                sql = `SELECT
                            a3.action,
                            a1.action_index,
                            a4.address as source,
                            t3.tick,
                            a1.list_action_index,
                            a1.amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            airdrops a1
                            INNER JOIN actions            a2 ON (a2.action_index=a1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a3 ON (a3.id=a2.action_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=a1.tick_id)
                        WHERE 
                            a1.action_index=?
                        LIMIT 1`;
            }
            // BATCH action
            if(type=='BATCH'){
                sql = `SELECT
                            a3.action,
                            b1.action_index,
                            a4.address as source,
                            b2.block_index,
                            b2.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            batches b1
                            INNER JOIN actions            a2 ON (a2.action_index=b1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                            INNER JOIN blocks             b2 ON (b2.block_index=t1.block_index)
                            INNER JOIN index_actions      a3 ON (a3.id=a2.action_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=t1.source_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            b1.action_index=?
                        LIMIT 1`;
            }
            // BROADCAST action
            if(type=='BROADCAST'){
                sql = `SELECT
                            a2.action,
                            b1.action_index,
                            b1.message,
                            b1.value,
                            b1.fee,
                            b1.broadcast_action_index,
                            a3.address as source,
                            b2.block_index,
                            b2.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            broadcasts b1
                            INNER JOIN actions            a1 ON (a1.action_index=b1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b2 ON (b2.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=b1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            b1.action_index=?
                        LIMIT 1`;
            }
            // CALLBACK action
            if(type=='CALLBACK'){
                sql = `SELECT
                            a2.action,
                            c1.action_index,
                            a3.address as source,
                            t3.tick,
                            t4.tick as callback_tick,
                            c1.callback_amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            callbacks c1
                            INNER JOIN actions            a1 ON (a1.action_index=c1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=c1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=c1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=c1.tick_id)
                            INNER JOIN index_tickers      t4 ON (t4.id=c1.callback_tick_id)
                        WHERE 
                            c1.action_index=?
                        LIMIT 1`;
            }
            // DESTROY action
            if(type=='DESTROY'){
                sql = `SELECT
                            a2.action,
                            d1.action_index,
                            a3.address as source,
                            t3.tick,
                            d1.amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            destroys d1
                            INNER JOIN actions            a1 ON (a1.action_index=d1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=d1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=d1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=d1.tick_id)
                        WHERE 
                            d1.action_index=?
                        LIMIT 1`;
            }
            // DISPENSER action
            if(type=='DISPENSER'){
                // TODO
            }
            // DISPENSE action
            if(type=='DISPENSE'){
                // TODO
            }
            // FILE action
            if(type=='FILE'){
                sql = `SELECT
                            a2.action,
                            f1.action_index,
                            f1.name,
                            f1.title,
                            t3.type as type,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            files f1
                            INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                        WHERE 
                            f1.action_index=?
                        LIMIT 1`;
                // TODO: Add code to lookup actual file data from transactions and return an `data` item
            }
            // ISSUE action
            if(type=='ISSUE'){
                sql = `SELECT
                            a2.action,
                            i1.action_index,
                            t3.tick,
                            i1.max_supply,
                            i1.max_mint,
                            i1.decimals,
                            i1.description,
                            i1.mint_supply,
                            a4.address as transfer,
                            a5.address as transfer_supply,
                            i1.lock_max_supply,
                            i1.lock_mint,
                            i1.lock_mint_supply,
                            i1.lock_max_mint,
                            i1.lock_description,
                            i1.lock_sleep,
                            i1.lock_callback,
                            i1.callback_block,
                            t4.tick as callback_tick,
                            i1.callback_amount,
                            i1.allow_list,
                            i1.block_list,
                            i1.mint_address_max,
                            i1.mint_start_block,
                            i1.mint_stop_block,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            issues i1
                            INNER JOIN actions            a1 ON (a1.action_index=i1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=i1.transfer_id)
                            LEFT  JOIN index_addresses    a5 ON (a5.id=i1.transfer_supply_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=i1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=i1.tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=i1.callback_tick_id)
                        WHERE 
                            i1.action_index=?
                        LIMIT 1`;
            }
            // LINK action
            if(type=='LINK'){
                sql = `SELECT
                            a2.action,
                            l1.action_index,
                            c1.coin as coin1,
                            c2.coin as coin2,
                            l1.coin1_action_index,
                            l1.coin2_action_index,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            links l1
                            INNER JOIN actions            a1 ON (a1.action_index=l1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=l1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=l1.coin1_id)
                            INNER JOIN index_coins        c2 ON (c2.id=l1.coin2_id)
                        WHERE 
                            l1.action_index=?
                        LIMIT 1`;
            }
            // LIST action
            if(type=='LIST'){
                sql = `SELECT
                            a2.action,
                            l1.action_index,
                            l1.type,
                            l1.edit,
                            l1.list_action_index,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            lists l1
                            INNER JOIN actions            a1 ON (a1.action_index=l1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            l1.action_index=?
                        LIMIT 1`;
            }
            // MESSAGE action
            if(type=='MESSAGE'){
                sql = `SELECT
                            a2.action,
                            m1.action_index,
                            a3.address as source,
                            a4.address as destination,
                            m1.encryption_method,
                            m1.encryption_key,
                            m1.encrypted_message,
                            m1.plaintext_message,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            messages m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`;
            }
            // MINT action
            if(type=='MINT'){
                sql = `SELECT
                            a2.action,
                            m1.action_index,
                            a3.address as source,
                            a4.address as destination,
                            t3.tick,
                            m1.amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s1.status
                        FROM
                            mints m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                            INNER JOIN index_memos        m2 ON (m2.id=m1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=m1.tick_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`;
            }
            // ORDER action
            if(type=='ORDER'){
                sql = `SELECT
                            a2.action,
                            o1.action_index,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            o1.give_amount,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            o1.get_amount,
                            a3.address as source,
                            a4.address as get_address,
                            o1.expiration,
                            o1.allow_list,
                            o1.block_list,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s1.status
                        FROM
                            orders o1
                            INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=o1.get_address_id)
                            INNER JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=o1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=o1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=o1.get_coin_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=o1.give_tick_id)
                            INNER JOIN index_tickers      t4 ON (t4.id=o1.get_tick_id)
                        WHERE 
                            o1.action_index=?
                        LIMIT 1`;
            }
            // ORDER_CANCEL action
            if(type=='ORDER_CANCEL'){
                sql = `SELECT
                        a2.action,
                        o1.action_index,
                        o1.order_action_index,
                        a3.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s1.status
                    FROM
                        order_cancels o1
                        INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                        INNER JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=o1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        o1.action_index=?
                    LIMIT 1`;
            }
            // ORDER_EDIT action
            if(type=='ORDER_EDIT'){
                sql = `SELECT
                        a2.action,
                        o1.action_index,
                        o1.order_action_index,
                        a3.address as source,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s1.status
                    FROM
                        order_edits o1
                        INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                        INNER JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=o1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        o1.action_index=?
                    LIMIT 1`;
            }
            // ORDER_MATCH action
            if(type=='ORDER_MATCH'){
                sql = `SELECT
                            a2.action,
                            m1.action_index,
                            c1.coin as give_coin,
                            m1.give_action_index,
                            c2.coin as get_coin,
                            m1.get_action_index,
                            b1.block_index,
                            b1.block_time as timestamp,
                            s1.status
                        FROM
                            order_matches m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`;
            }
            // SEND action
            // TODO: Revisit this code and optimize it to support Multi-sends (right now shows first send status instead of every send status as it should)
            if(type=='SEND'){
                sql = `SELECT
                            a2.action,
                            s1.action_index,
                            a3.address as source,
                            a4.address as destination,
                            t3.tick,
                            s1.amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status
                        FROM
                            sends s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=s1.destination_id)
                            INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=s1.tick_id)
                        WHERE 
                            s1.action_index=?
                        LIMIT 1`;                  
            }
            // SLEEP action
            if(type=='SLEEP'){
                sql = `SELECT
                            a2.action,
                            s1.action_index,
                            s1.type,
                            a3.address as source,
                            t3.tick,
                            s1.resume_block,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status
                        FROM
                            sleeps s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT JOIN index_tickers       t3 ON (t3.id=s1.tick_id)
                        WHERE 
                            s1.action_index=?
                        LIMIT 1`;
            }
            // SWAP action
            if(type=='SWAP'){
                sql = `SELECT
                            a2.action,
                            s1.action_index,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            s1.give_amount,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            s1.get_amount,
                            a3.address as source,
                            a4.address as get_address,
                            s1.expiration,
                            s1.allow_list,
                            s1.block_list,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status
                        FROM
                            swaps s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=s1.get_address_id)
                            INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=s1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=s1.get_coin_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=s1.give_tick_id)
                            INNER JOIN index_tickers      t4 ON (t4.id=s1.get_tick_id)
                        WHERE 
                            s1.action_index=?
                        LIMIT 1`;
            }
            // SWAP_CANCEL action
            if(type=='SWAP_CANCEL'){
                sql = `SELECT
                        a2.action,
                        s1.action_index,
                        s1.swap_action_index,
                        a3.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s2.status
                    FROM
                        swap_cancels s1
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        s1.action_index=?
                    LIMIT 1`;
            }
            // SWAP_EDIT action
            if(type=='SWAP_EDIT'){
                sql = `SELECT
                        a2.action,
                        s1.action_index,
                        s1.swap_action_index,
                        a3.address as source,
                        s1.expiration,
                        s1.allow_list,
                        s1.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s2.status
                    FROM
                        swap_edits s1
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        s1.action_index=?
                    LIMIT 1`;
            }
            // SWAP_MATCH action
            if(type=='SWAP_MATCH'){
                sql = `SELECT
                            a2.action,
                            m1.action_index,
                            c1.coin as give_coin,
                            m1.give_action_index,
                            c2.coin as get_coin,
                            m1.get_action_index,
                            b1.block_index,
                            b1.block_time as timestamp,
                            s1.status
                        FROM
                            swap_matches m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`;
            }
            // SWEEP
            if(type=='SWEEP'){
                sql = `SELECT
                            a2.action,
                            s1.action_index,
                            a3.address as source,
                            a4.address as destination,
                            s1.balances,
                            s1.ownerships,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status
                        FROM
                            sweeps s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=s1.destination_id)
                            INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            s1.action_index=?
                        LIMIT 1`;
            }
            // UNKNOWN
            if(type=='UNKNOWN'){
                sql = `SELECT
                            a2.action,
                            a1.action_index,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index
                        FROM
                            actions                       a1
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                        WHERE 
                            a1.action_index=?
                        LIMIT 1`;
            }
            // Run the SQL query to get the information on the action_index
            if(sql){
                let db = await this.getConnection();
                try {
                    let results = await db.query(sql, [action_index]);
                    if(results && results.length)
                        data = results[0];
                } catch (error){
                    this.util.logError('Error trying to run sql query in getActionData:', error);
                }
            }
        }
        return data;
    }    
}
module.exports = Database