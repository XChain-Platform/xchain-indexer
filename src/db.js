/* XChain Indexer Database Connector */

const mariadb = require('mariadb');
const fs      = require('fs');
const util    = require('./util.js');

class Database {

    // Handle constructing a class instance
    constructor(host, port, dbName, user, pass) {
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
                // console.log('e=',e);
                console.log("There was an error trying to check if the " + this.dbName + " database exists. Trying again in a few seconds...");
                await util.sleep(5000); // Wait 5 seconds
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
                console.log('e=',e);
                console.log("There was an error trying to connect to the " + this.dbName + " database. Trying again in a few seconds...");
                await util.sleep(5000); // Waiting 5 seconds
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
                    console.log('e=',e);
                    util.throwError('Error while trying to verify ' + table + ' table exists!');
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
                util.throwError('Error while trying to create ' + table + ' table!');
            }
        }
        // Dont release connection after each table is created, connection released in verifyTables() after ALL tables created and verified
        // await this.releaseConnection();
    }

    /* 
     * Common database connection functions (connect / rollback / commit)
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
                await util.sleep(1000);
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
            util.throwError('beginTransaction error=' + e);
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


    /* 
     * Common database connection functions (connect / rollback / commit)
     */


    // Handle getting block index for a given component and request type
    async getBlockIndex(component, type){
        // Bail out on any invalid request type
        var componentTypes = ['decoder', 'indexer'];
        if(!componentTypes.includes(component)){
            console.error('Invalid component');
            return false;
        }
        // Bail out on any invalid request type
        var validTypes = ['first', 'last', 'rollback'];
        if(!validTypes.includes(type)){
            console.error('Invalid type');
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
                return rows[0]["block_index"];
            } else {
                return -1   
            }
        } catch (err) {
            console.error('Error getting block height:', err);
            return false;
        }
        await this.releaseConnection();
    }

    // Handle getting block transaction for a given block from the Decoder
    async getBlockData(block_index){
        let db = await this.getConnection();
        // XChain-decoder SQL
        let query  = `SELECT
                t1.data,
                t2.hash as tx_hash,
                a.address as source,
                t1.block_index
            FROM
                transactions t1,
                index_transactions t2,
                index_addresses a
            WHERE 
                t2.id=t1.tx_hash_id AND
                a.id=t1.source_id AND
                t1.block_index=? 
            ORDER BY t1.tx_index ASC`;
        try {
            const rows = await db.query(query, [block_index]);
            await db.end();
            return rows;
        } catch (err) {
            console.error('Error getting decoder block data:', err);
            return false;
        }
        await this.releaseConnection();
    }

    // Handle getting block time for a given block from the Decoder
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
        } catch (err) {
            console.error('Error getting decoder block time:', err);
            return false;
        }
        await this.releaseConnection();
    }

    // Get block hashes using credits/debits/transactions table data and previous hash
    async getBlockHashes(block_index){
        let db      = await this.getConnection();
        let query   = null;
        let credits = [];
        let debits  = [];
        let txlist  = [];
        let info    = [];
        let hashes  = [];
        // Get data from credits table
        query  = `SELECT * FROM credits WHERE block_index=? ORDER BY block_index ASC, tick_id ASC, address_id ASC, amount DESC`;
        try {
            credits = await db.query(query, [block_index]);
        } catch (err) {
            console.error('Error getting data from the credits table:', err);
        }
        // Get data from debits table
        query  = `SELECT * FROM debits WHERE block_index=? ORDER BY block_index ASC, tick_id ASC, address_id ASC, amount DESC`;
        try {
            debits = await db.query(query, [block_index]);
        } catch (err) {
            console.error('Error getting data from the debits table:', err);
        }
        // Get data from transactions table
        query  = `SELECT * FROM transactions WHERE block_index=? ORDER BY tx_index ASC`;
        try {
            txlist = await db.query(query, [block_index]);
        } catch (err) {
            console.error('Error getting data from the txlist table:', err);
        }
        // Subtract one block from current block
        let prev_block_index = block_index -1;
        // Get hashes from the previous block to include in this blocks hash
        query = `SELECT
                t1.hash as credits,
                t2.hash as debits,
                t3.hash as txlist
            FROM
                blocks b,
                index_transactions t1,
                index_transactions t2,
                index_transactions t3
            WHERE
                t1.id=b.credits_hash_id AND
                t2.id=b.debits_hash_id AND
                t3.id=b.txlist_hash_id AND
                b.block_index=?`;
        try {
            let rows = await db.query(query, [prev_block_index]);
            if(rows.length >0){
                hashes['credits'] = rows[0].credits;
                hashes['debits']  = rows[0].debits;
                hashes['txlist']  = rows[0].txlist;
            }
        } catch (err) {
            console.error('Error getting data on the previous block hashes:', err);
        }
        // Define list of tables with data to hash
        let tables = ['credits','debits','txlist'];
        // Loop through the tables, add previous hash to data, then create new block hash
        tables.forEach(table => {
            var data = null;
            if(table=='credits') data = credits;
            if(table=='debits')  data = debits;
            if(table=='txlist')  data = txlist;
            // Include the block_index and previous block hash in the hash calculation for this block hash
            data['block_index']   = block_index;
            data['previous_hash'] = hashes[table];
            info[table] = [];
            info[table]['hash'] = util.getDataHash(data);
            // info[table]['data'] = data;
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
                id = rows[0].id;
        } catch (err) {
            console.error('Error looking up hash record id in index_transactions table:', err);
        }
        await this.releaseConnection();
        return id;
    }

    // Create records in the 'index_transactions' table and return record id
    async createTransaction(hash){
        // Ignore empty hashes and return hardcoded record id
        if(hash==null||hash=='')
            return 1;
        var id = await this.getTransactionId(hash);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            let query = "INSERT INTO index_transactions (`hash`) values (?)"
            try {
                let result = await db.query(query, [hash]);
                if(result.insertId)
                    id = result.insertId;
            } catch (err) {
                console.error('Error trying to create hash record in index_transactions table:', err);
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
                id = rows[0].id;
        } catch (err) {
            console.error('Error looking up block record id in blocks table:', err);
        }
        await this.releaseConnection();
        return id;
    }

    // Handle creating/updating a block in the `blocks` table
    async createBlock(block_index){
        // Ignore empty hashes and return hardcoded record id
        if(block_index==null||block_index=='')
            return false;
        let block_id   = await this.getBlockId(block_index);
        let block_time = await this.getBlockTime(block_index);
        let hashes     = await this.getBlockHashes(block_index);
        // Create transaction hashes in the `transaction` table and get the hash id
        let credits_hash_id = await this.createTransaction(hashes.credits.hash);
        let debits_hash_id  = await this.createTransaction(hashes.debits.hash);
        let txlist_hash_id  = await this.createTransaction(hashes.txlist.hash);
        // Create data
        let db    = await this.getConnection();
        let query = "INSERT INTO blocks (block_time, credits_hash_id, debits_hash_id, txlist_hash_id, block_index) values (?, ?, ?, ?, ?)";
        if(block_id!=null){
            query = `UPDATE
                        blocks
                    SET
                        block_time=?,
                        credits_hash_id=?,
                        debits_hash_id=?,
                        txlist_hash_id=?
                    WHERE 
                        block_index=?`;
        }
        try {
            let result = await db.query(query, [block_time, credits_hash_id, debits_hash_id, txlist_hash_id, block_index]);
        } catch (err) {
            console.error('Error trying to create record in blocks table:', err);
        }
        await this.releaseConnection();
        // Display status message
        let credits = String(hashes.credits.hash).substring(0,5);
        let debits  = String(hashes.debits.hash).substring(0,5);
        let txlist  = String(hashes.txlist.hash).substring(0,5);
        console.log('Block Created' + "\t: " + block_index + ' [credits:' + credits + ' debits:' + debits + ' txlist:' + txlist + ']');
    }



}

module.exports = Database