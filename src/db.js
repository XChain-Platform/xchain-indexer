/* XChain Indexer Database Connector */

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
                // console.log('e=',e);
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
                return rows[0]["block_index"];
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
                        t1.block_index
                    FROM
                        transactions t1
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
        } catch (error) {
            this.util.logError('Error getting decoder block time:', error);
            return false;
        }
        await this.releaseConnection();
    }

    // Get block hashes using credits/debits/actions table data and previous hash
    async getBlockHashes(block_index){
        let db      = await this.getConnection();
        let query   = null;
        let credits = [];
        let debits  = [];
        let actions = [];
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
            credits = await db.query(query, [block_index]);
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
            debits = await db.query(query, [block_index]);
        } catch (error){
            this.util.logError('Error getting data from the debits table:', error);
        }
        // Get data from actions table
        query = `SELECT
                    a.action_index,
                    a.tx_index,
                    a.tx_action_index,
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
                t1.hash as credits,
                t2.hash as debits,
                t3.hash as actions
            FROM
                blocks b,
                index_transactions t1,
                index_transactions t2,
                index_transactions t3
            WHERE
                t1.id=b.credits_hash_id AND
                t2.id=b.debits_hash_id AND
                t3.id=b.actions_hash_id AND
                b.block_index=?`;
        try {
            let rows = await db.query(query, [prev_block_index]);
            if(rows.length >0){
                hashes['credits'] = rows[0].credits;
                hashes['debits']  = rows[0].debits;
                hashes['actions'] = rows[0].actions;
            }
        } catch (error) {
            this.util.logError('Error getting data on the previous block hashes:', error);
        }
        // Define list of tables with data to hash
        let tables = ['credits','debits','actions'];
        // Loop through the tables, add previous hash to data, then create new block hash
        tables.forEach(table => {
            var data = null;
            if(table=='credits') data = credits;
            if(table=='debits')  data = debits;
            if(table=='actions') data = actions;
            // Include the block_index and previous block hash in the hash calculation for this block hash
            data['block_index']   = block_index;
            data['previous_hash'] = hashes[table];
            info[table] = [];
            info[table]['hash'] = this.util.getDataHash(data);
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
        } catch (error) {
            this.util.logError('Error looking up hash record id in index_transactions table:', error);
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
                id = rows[0].id;
        } catch (error) {
            this.util.logError('Error looking up address record id in index_addresses table:', error);
        }
        await this.releaseConnection();
        return id;
    }

    // Create records in the 'index_addresses' table and return record id
    async createAddress(address){
        // Ignore empty address and return hardcoded record id
        if(address==null||address=='')
            return 1;
        var id = await this.getAddressId(address);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            let query = "INSERT INTO index_addresses (`address`) values (?)"
            try {
                let result = await db.query(query, [address]);
                if(result.insertId)
                    id = result.insertId;
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
                id = rows[0].id;
        } catch (error) {
            this.util.logError('Error looking up block record id in blocks table:', error);
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
        // Create transaction hashes in the `index_transactions` table and get the hash id
        let credits_hash_id = await this.createTransaction(hashes.credits.hash);
        let debits_hash_id  = await this.createTransaction(hashes.debits.hash);
        let actions_hash_id = await this.createTransaction(hashes.actions.hash);
        // Create data
        let db    = await this.getConnection();
        let query = "INSERT INTO blocks (block_time, credits_hash_id, debits_hash_id, actions_hash_id, block_index) values (?, ?, ?, ?, ?)";
        if(block_id!=null){
            query = `UPDATE
                        blocks
                    SET
                        block_time=?,
                        credits_hash_id=?,
                        debits_hash_id=?,
                        actions_hash_id=?
                    WHERE 
                        block_index=?`;
        }
        try {
            let result = await db.query(query, [block_time, credits_hash_id, debits_hash_id, actions_hash_id, block_index]);
        } catch (error) {
            this.util.logError('Error trying to create record in blocks table:', error);
        }
        await this.releaseConnection();
        // Display status message
        let credits = String(hashes.credits.hash).substring(0,5);
        let debits  = String(hashes.debits.hash).substring(0,5);
        let actions = String(hashes.actions.hash).substring(0,5);
        return [credits, debits, actions];
    }

    // Lookup a record in the `index_actions` table and return record id
    async getActionId(action){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_actions WHERE action=? LIMIT 1";
        try {
            let rows = await db.query(query, [action]);
            if(rows.length > 0)
                id = rows[0].id;
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
                    id = result.insertId;
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
                idx = rows[0].tx_index;
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
                tx_index = rows[0].tx_index;
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
            let tx_hash_id  = await this.createTransaction(data.TX_HASH);
            let db          = await this.getConnection();
            let query       = "INSERT INTO transactions (tx_index, block_index, tx_hash_id) values (?, ?, ?)";
            try {
                let result = await db.query(query, [tx_index, block_index, tx_hash_id]);
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
                idx = rows[0].action_index;
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
        let action_index    = null;
        let block_index     = data.BLOCK_INDEX;
        let tx_index        = data.TX_INDEX;
        let tx_action_index = data.TX_ACTION_INDEX;
        let action_id       = await this.createAction(data.ACTION);
        let db              = await this.getConnection();
        let query = `SELECT
                        a.action_index
                    FROM
                        actions a
                        INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                    WHERE
                        t.block_index=? AND 
                        a.tx_index=? AND 
                        a.tx_action_index=? AND 
                        a.action_id=?`;
        let args = [block_index, tx_index, tx_action_index, action_id];
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                action_index = rows[0].action_index;
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
            action_index        = await this.getNextActionIndex();
            let tx_index        = data.TX_INDEX;
            let tx_action_index = data.TX_ACTION_INDEX;
            let action_id       = await this.createAction(data.ACTION);
            let db              = await this.getConnection();
            let query           = "INSERT INTO actions (action_index, tx_index, tx_action_index, action_id) values (?, ?, ?, ?)";
            let args            = [action_index, tx_index, tx_action_index, action_id];
            try {
                let result = await db.query(query, args);
            } catch (error) {
                this.util.logError('Error while trying to create record in actions table:', error);
            }
            await this.releaseConnection();
        }
        return action_index;
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
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_tickers WHERE tick=? LIMIT 1";
        try {
            let rows = await db.query(query, [tick]);
            if(rows.length > 0)
                id = rows[0].id;
        } catch (error) {
            this.util.logError('Error looking up ticker record id in index_tickers table:', error);
        }
        await this.releaseConnection();
        return id;
    }

    // Create records in the 'index_actions' table and return record id
    async createTicker(tick){
        // Ignore empty tickers and return hardcoded record id
        if(this.util.isNull(tick) || tick=='')
            return 1;
        var id = await this.getTickerId(tick);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            let query = "INSERT INTO index_tickers (tick) values (?)";
            try {
                let result = await db.query(query, [tick]);
                if(result.insertId)
                    id = result.insertId;
            } catch (error) {
                this.util.logError('Error trying to create ticker record in index_tickers table:', error);
            }
            await this.releaseConnection();
        }
        return id;
    }

    // Handle getting token information using issues table
    // @param {tick}            string  Ticker name
    // @param {tick_id}         integer Ticker database record id
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    async getTokenInfo(tick, tick_id, block_index, action_index){
        let data = false,
            sql  = '',
            args = [];
        // Get the tick_id for the given ticker
        if(!this.util.isNull(tick) && this.util.isNull(tick_id))
            tick_id = await this.createTicker(tick);
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
                        i.lock_rug,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=i.source_id)
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
                    arr['LOCK_RUG']          = row.lock_rug;
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
        // Get token supply at the given action_index
        if(data)
            data['SUPPLY'] = await this.getTokenSupply(tick, tick_id, null, action_index); 
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

    // Get token supply from credits/debits table (credits - debits = supply)
    // @param {tick}            string  Ticker name
    // @param {tick_id}         integer Ticker database record id
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    async getTokenSupply(tick, tick_id, block_index, action_index){
        let credits = 0;
        let debits  = 0;
        let escrow  = 0;
        let supply  = 0;
        let db      = await this.getConnection(),
            sql     = '',
            query   = '',
            args    = [];
        // Get the tick_id for the given ticker
        if(!this.util.isNull(tick) && this.util.isNull(tick_id))
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
            if(rows.length > 0)
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
            if(rows.length > 0)
                debits = rows[0].debits;
        } catch (error) {
            this.util.logError('Error while trying to get list of debits:', error);
        }
        // TODO: Get Escrowed supply
        await this.releaseConnection();
        // Determine total supply (credits - debits)
        supply = this.util.bcsub(credits, debits, decimals);
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
            if(rows.length > 0)
                supply = rows[0].supply;
        } catch (error) {
            this.util.logError('Error looking up token supply from balances table:', error);
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
        let action_index      = data['ACTION_INDEX'];
        let source_id         = await this.createAddress(data['SOURCE']);
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
                            source_id=?,
                            list_action_index=?,
                            status_id=?
                        WHERE 
                            action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO lists (type, edit, source_id, list_action_index, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args = [list_type, list_edit, source_id, list_action_index, status_id, action_index];
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
                id = rows[0].id;
        } catch (error) {
            this.util.logError('Error looking up status record id in index_statuses table:', error);
        }
        await this.releaseConnection();
        return id;
    }

    // Create records in the 'index_statuses' table and return record id
    async createStatus(status){
        var id = await this.getStatusId(status);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            let query = "INSERT INTO index_statuses (status) values (?)";
            try {
                let result = await db.query(query, [status]);
                if(result.insertId)
                    id = result.insertId;
            } catch (error) {
                this.util.logError('Error trying to create status record in index_statuses table:', error);
            }
            await this.releaseConnection();
        }
        return id;
    }

    // Create/Update record in `issues` table
    async createIssue(data){
        // Define list of LOCK fields
        let locks = [
            'LOCK_MAX_SUPPLY',
            'LOCK_MINT',
            'LOCK_MINT_SUPPLY',
            'LOCK_MAX_MINT',
            'LOCK_DESCRIPTION',
            'LOCK_RUG',
            'LOCK_SLEEP',
            'LOCK_CALLBACK'
        ];
        // Define list of LIST fields
        let lists = [
            'ALLOW_LIST',
            'BLOCK_LIST'
        ];
        // Standardize lock values to explicitly unlocked (0) or locked (1)
        for(let lock of locks){
            if([0,1].indexOf(data[lock]) == -1)
                delete data[lock];
        }
        // Standardize list values to numeric or NULL
        for(let list of lists){
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
        let lock_rug           = data['LOCK_RUG'];
        let lock_sleep         = data['LOCK_SLEEP'];
        let lock_callback      = data['LOCK_CALLBACK'];
        let callback_block     = data['CALLBACK_BLOCK'];
        let callback_amount    = data['CALLBACK_AMOUNT'];
        let allow_list         = data['ALLOW_LIST'];
        let block_list         = data['BLOCK_LIST'];
        let callback_tick_id   = await this.createTicker(data['CALLBACK_TICK']);
        let tick_id            = await this.createTicker(data['TICK']);
        let source_id          = await this.createAddress(data['SOURCE']);
        let transfer_id        = await this.createAddress(data['TRANSFER']);
        let transfer_supply_id = await this.createAddress(data['TRANSFER_SUPPLY']);
        let status_id          = await this.createStatus(data['STATUS']);
        // Truncate description to MAX_TOKEN_DESCRIPTION characters
        if(!this.util.isNull(description) && description.length > this.config['MAX_TOKEN_DESCRIPTION'])
            description = description.substring(0,this.config['MAX_TOKEN_DESCRIPTION']); 
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
                        lock_rug=?,
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
                        source_id=?,
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
                        lock_rug, 
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
                        source_id, 
                        status_id,
                        action_index
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args = [tick_id, max_supply, max_mint, decimals, description, mint_supply, transfer_id, transfer_supply_id, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint, lock_description, lock_rug, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, source_id, status_id, action_index ];
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
        let lock_rug           = (data['LOCK_RUG']==1) ? 1 : 0;
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
                        lock_rug=?,
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
                        action_index=?
                    WHERE 
                        tick_id=?`;
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
                        lock_rug, 
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
                        tick_id 
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        let args = [max_supply, max_mint, decimals, description, lock_max_supply, lock_mint, lock_max_mint,lock_description, lock_rug, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, supply, owner_id, action_index, tick_id];
        // Create or Update the record in the tokens table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in tokens table:', error);
        }
        await this.releaseConnection();
    }

    // Create / Update record in `credits` or `debits` table
    async createCreditDebitRecord(table, action_index, tick, amount, address){
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

    // Create/Update record in `credits` table
    async createCredit(action_index, tick, amount, address){
        await this.createCreditDebitRecord('credits', action_index, tick, amount, address);
    }

    // Create/Update record in `debits` table
    async createDebit(action_index, tick, amount, address){
        await this.createCreditDebitRecord('debits', action_index, tick, amount, address);
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
        let type  = typeof tickers;
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
            this.updateTokenInfo(tick);
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
                action_index = rows[0].action_index;
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

    // Check if an address is allowed to perform an action on a token (ALLOW/BLOCK list)
    async isActionAllowed(tick, address){
        let info = await this.getTokenInfo(tick);
        let list = null;
        // False if we have an ALLOW_LIST and user is NOT on it
        if(!this.util.isNull(info['ALLOW_LIST']) && this.util.isNumeric(info['ALLOW_LIST'])){
            list = await this.getList(info['ALLOW_LIST']);
            if(!list.includes(address))
                return false;
        }
        // False if we have an BLOCK_LIST and user IS on it
        if(!this.util.isNull(info['BLOCK_LIST']) && this.util.isNumeric(info['BLOCK_LIST'])){
            list = await this.getList(info['BLOCK_LIST']);
            if(list.includes(address))
                return false;
        }
        return true;
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
                id = rows[0].id;
        } catch (error) {
            this.util.logError('Error looking up ticker record id in index_memos table:', error);
        }
        await this.releaseConnection();
        return id;
    }

    // Create records in the 'index_memos' table and return record id
    async createMemo(memo){
        // Ignore empty memos and return hardcoded record id
        if(this.util.isNull(memo) || memo=='')
            return 1;
        var id = await this.getMemoId(memo);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            let query = "INSERT INTO index_memos (memo) values (?)";
            try {
                let result = await db.query(query, [memo]);
                if(result.insertId)
                    id = result.insertId;
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
        let tick_id        = await this.createTicker(data['TICK']);
        let source_id      = await this.createAddress(data['SOURCE']);
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
                        source_id=?,
                        destination_id=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO mints (tick_id, amount, source_id, destination_id, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        let args = [tick_id, amount, source_id, destination_id, memo_id, status_id, action_index];
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
        let tickers = {};
        let supply  = {}; // Assoc array of supplys
        let db      = await this.getConnection();
        // Get list of tickers and supply from credits/debits/tokens tables using block_index
        let query   = `SELECT
                        DISTINCT(x.tick_id),
                        t2.tick,
                        t1.supply 
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
                        ) as x
                        INNER JOIN tokens        t1 ON (t1.tick_id=x.tick_id)
                        INNER JOIN index_tickers t2 ON (t2.id=x.tick_id)
                    ORDER BY 
                        t2.tick ASC`;
        try {
            let rows = await db.query(query, [block_index, block_index]);
            if(rows.length >0){
                for(let row of rows){
                    // Add ticker and supply info to assoc arrays
                    tickers[row.tick] = row.tick_id;
                    supply[row.tick]  = (!this.util.isNull(row.supply)) ? row.supply : "0";
                };
            }
        } catch (error){
            this.util.logError('Error looking up credits/debits in block:', error);
        }
        // Loop through the tickers and validate token supply match credits/debits/balances info
        for(let tick in tickers){
            let tick_id = tickers[tick];
            let supplyA = this.util.bcnum(supply[tick]);                           // Supply from tokens table
            let supplyB = this.util.bcnum(await this.getTokenSupplyBalance(tick)); // Supply from balances table
            let supplyC = this.util.bcnum(await this.getTokenSupply(tick));        // Supply from credits/debits tables
            // DEBUG : Dump information on the sanity check failure
            if(supplyA!=supplyB || supplyA!=supplyC){
                console.log("Tick,       tick_id =", tick, tick_id);
                console.log("token        supply =", supplyA);
                console.log("balances     supply =", supplyB);
                console.log("credit/debit supply =", supplyC);
            }
            if(supplyA!=supplyB)
                this.util.throwError("SanityError: balances table supply does not match token supply : " + tick + " (" + supplyB + " != " + supplyA + ")");
            if(supplyA!=supplyC)
                this.util.throwError("SanityError: credits/debits table supply does not match token supply : " + tick + " (" + supplyC + " != " + supplyA + ")");
        }
        await this.releaseConnection();
    }

    // Create record in `addresses` table
    async createAddressOption(data){
        let source_id      = await this.createAddress(data['SOURCE']);
        let status_id      = await this.createStatus(data['STATUS']);
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
                        source_id=?,
                        fee_preference=?,
                        require_memo=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            query = "INSERT INTO addresses (source_id, fee_preference, require_memo, status_id, action_index) values (?, ?, ?, ?, ?)";
        }
        try {
            let rows = await db.query(query, [source_id, fee_preference, require_memo, status_id, action_index]);
        } catch (error){
            this.util.logError('Error trying to create record in addresses table:', error);
        }
        await this.releaseConnection();
    }

    // Delete records in lists, list_items, and list_edits tables
    async deleteLists(list, rollback){
        if(!this.util.isNull(list) && list.length > 0){
            let db     = await this.getConnection();
            let tables = ['list_items', 'list_edits'];
            let query  = '';
            for(let list_id of list){
                // Delete item from lists table
                query = `DELETE FROM lists WHERE tx_hash_id=?`;
                try {
                    let rows = await db.query(query, list_id);
                } catch (error){
                    this.util.logError('Error while trying to delete data from lists table:', error);
                }
                // Deletes item from list_items and list_edits tables
                for(let table of tables){
                    query = `DELETE FROM ` + table + ` WHERE list_id=?`;
                    try {
                        let rows = await db.query(query, list_id);
                    } catch (error){
                        this.util.logError('Error while trying to delete data from ' + table + ' table:', error);
                    }
                }
            }
            await this.releaseConnection();
        }
    }

    // Create record in `batches` table
    async createBatch(data){
        let source_id      = await this.createAddress(data['SOURCE']);
        let tx_hash_id     = await this.createTransaction(data['TX_HASH']);
        let status_id      = await this.createStatus(data['STATUS']);
        let block_index    = data['BLOCK_INDEX'];
        let tx_index       = data['TX_INDEX'];
        // Check if record already exists for this address
        let db     = await this.getConnection();
        let query  = "SELECT tx_index FROM batches WHERE tx_hash_id=? LIMIT 1";
        let exists = false;
        try {
            let rows = await db.query(query, tx_hash_id);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in batches table:', error);
        }
        if(exists){
            query = `UPDATE
                        batches
                    SET
                        tx_index=?,
                        source_id=?,
                        block_index=?,
                        status_id=?
                    WHERE 
                        tx_hash_id=?`;
        } else {
            query = "INSERT INTO batches (tx_index, source_id, block_index, status_id, tx_hash_id) values (?, ?, ?, ?, ?)";
        }
        try {
            let rows = await db.query(query, [tx_index, source_id, block_index, status_id, tx_hash_id]);
        } catch (error){
            this.util.logError('Error trying to create record in batches table:', error);
        }
        await this.releaseConnection();
    }

    // Create/Update record in `sends` table
    async createSend(data){
        // Normalize data
        let tick_id        = await this.createTicker(data['TICK']);
        let source_id      = await this.createAddress(data['SOURCE']);
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
                            source_id=? AND
                            destination_id=? AND
                            amount=? AND
                            action_index=?`;
        let args = [tick_id, source_id, destination_id, amount, action_index];
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
                        source_id=?,
                        destination_id=?,
                        amount=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO sends (tick_id, source_id, destination_id, amount, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args = [tick_id, source_id, destination_id, amount, memo_id, status_id, action_index];
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
                a1.source_id=? AND 
                s1.status=?` + sql + `
            ORDER BY 
                a.action_index ASC`;
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
        let tick_id        = await this.createTicker(data['TICK']);
        let source_id      = await this.createAddress(data['SOURCE']);
        let tx_hash_id     = await this.createTransaction(data['TX_HASH']);
        let list_id        = await this.createTransaction(data['LIST']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let tx_index       = data['TX_INDEX'];
        let amount         = data['AMOUNT'];
        let block_index    = data['BLOCK_INDEX'];
        // Check if record already exists for this airdrop
        let db     = await this.getConnection();
        let query  = `SELECT
                    tx_index
                FROM
                    airdrops
                WHERE
                    tick_id=? AND
                    source_id=? AND
                    list_id=? AND
                    amount=? AND
                    tx_hash_id=?`;
        let args = [tick_id, source_id, list_id, amount, tx_hash_id];
        let exists = false;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                exists = true;
        } catch (error){
            this.util.logError('Error looking up record in airdrops table:', error);
        }
        // Define list of arguments for sql insert/update
        args = [tx_index, block_index, memo_id, status_id, tick_id, source_id, list_id, amount, tx_hash_id];
        if(exists){
            // UPDATE record
            query = `UPDATE
                        airdrops
                    SET
                        tx_index=?,
                        block_index=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        tick_id=? AND
                        source_id=? AND
                        list_id=? AND
                        amount=? AND
                        tx_hash_id=?`;
        } else {
            // INSERT record
            query = `INSERT INTO airdrops (tx_index, block_index, memo_id, status_id, tick_id, source_id, list_id, amount, tx_hash_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        // Create or Update the record in the sends table
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
        let source_id      = await this.createAddress(data['SOURCE']);
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
        args = [tick_id, source_id, destination_id, amount, method, action_index];
        if(exists){
            // UPDATE record
            query = `UPDATE
                        fees
                    SET
                        tick_id=?,
                        source_id=?,
                        destination_id=?,
                        amount=?,
                        method=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO fees (tick_id, source_id, destination_id, amount, method, action_index) values (?, ?, ?, ?, ?, ?)`;
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
        let tick_id        = await this.createTicker(data['TICK']);
        let source_id      = await this.createAddress(data['SOURCE']);
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
                        source_id=?,
                        amount=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO destroys (tick_id, source_id, amount, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args = [tick_id, source_id, amount, memo_id, status_id, action_index];
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
        let tick_id        = await this.createTicker(data['TICK']);
        let source_id      = await this.createAddress(data['SOURCE']);
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
                        source_id=?,
                        destination_id=?,
                        balances=?,
                        ownerships=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO sweeps (source_id, destination_id, balances, ownerships, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args = [source_id, destination_id, balances, ownerships, memo_id, status_id, action_index];
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
        let tick_id          = await this.createTicker(data['TICK']);
        let dividend_tick_id = await this.createTicker(data['DIVIDEND_TICK']);
        let source_id        = await this.createAddress(data['SOURCE']);
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
                        source_id=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;

        } else {
            // INSERT record
            query = `INSERT INTO dividends (tick_id, dividend_tick_id, amount, source_id, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?)`;
        }
        args = [tick_id, dividend_tick_id, amount, source_id, memo_id, status_id, action_index];
        // Create or Update the record in the dividends table
        try {
            let result = await db.query(query, args);
        } catch (error){
            this.util.logError('Error trying to create record in dividends table:', error);
        }
        await this.releaseConnection();
    }

    // // Create/Update record in `callbacks` table
    // async createCallback(data){
    //     // Normalize data
    //     let tick_id          = await this.createTicker(data['TICK']);
    //     let callback_tick_id = await this.createTicker(data['CALLBACK_TICK']);
    //     let source_id        = await this.createAddress(data['SOURCE']);
    //     let tx_hash_id       = await this.createTransaction(data['TX_HASH']);
    //     let memo_id          = await this.createMemo(data['MEMO']);
    //     let status_id        = await this.createStatus(data['STATUS']);
    //     let tx_index         = data['TX_INDEX'];
    //     let block_index      = data['BLOCK_INDEX'];
    //     let callback_amount  = data['CALLBACK_AMOUNT'];
    //     // Check if record already exists for this callback
    //     let db     = await this.getConnection();
    //     let query  = `SELECT
    //                         tx_index
    //                     FROM
    //                         callbacks
    //                     WHERE
    //                         source_id=? AND
    //                         tx_hash_id=?`; Error looking up addresses credits for
    //     let args = [source_id, tx_hash_id];
    //     let exists = false;
    //     try {
    //         let rows = await db.query(query, args);
    //         if(rows.length > 0)
    //             exists = true;
    //     } catch (error){
    //         this.util.logError('Error looking up record in callbacks table:', error);
    //     }
    //     if(exists){
    //         // UPDATE record
    //         query = `UPDATE
    //                     callbacks
    //                 SET
    //                     tx_index=?,
    //                     block_index=?,
    //                     tick_id=?,
    //                     callback_tick_id=?,
    //                     callback_amount=?,
    //                     memo_id=?,
    //                     status_id=?
    //                 WHERE 
    //                     source_id=? AND
    //                     tx_hash_id=?`;

    //     } else {
    //         // INSERT record
    //         query = `INSERT INTO callbacks (tx_index, block_index, tick_id, callback_tick_id, callback_amount, memo_id, status_id, source_id, tx_hash_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    //     }
    //     args = [tx_index, block_index, tick_id, callback_tick_id, callback_amount, memo_id, status_id, source_id, tx_hash_id];
    //     // Create or Update the record in the callbacks table
    //     try {
    //         let result = await db.query(query, args);
    //     } catch (error){
    //         this.util.logError('Error trying to create record in callbacks table:', error);
    //     }
    //     await this.releaseConnection();
    // }

}

module.exports = Database