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

    // Lookup a record in the `index_addresses` table and return record id
    async getAddressId(address){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_addresses WHERE `address`=? LIMIT 1"
        try {
            let rows = await db.query(query, [address]);
            if(rows.length > 0)
                id = rows[0].id;
        } catch (err) {
            console.error('Error looking up address record id in index_addresses table:', err);
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
            } catch (err) {
                console.error('Error trying to create address record in index_addresses table:', err);
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

    // Lookup a record in the `index_actions` table and return record id
    async getActionId(action){
        let id    = null;
        let db    = await this.getConnection();
        let query = "SELECT id FROM index_actions WHERE action=? LIMIT 1";
        try {
            let rows = await db.query(query, [action]);
            if(rows.length > 0)
                id = rows[0].id;
        } catch (err) {
            console.error('Error looking up action record id in index_actions table:', err);
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
            } catch (err) {
                console.error('Error trying to create action record in index_actions table:', err);
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
        } catch (err) {
            console.error('Error looking up action record id in index_actions table:', err);
        }
        // Increase current tx_index by 1 to get the next tx_index
        idx++;
        await this.releaseConnection();
        return idx;
    }

    // Lookup a record in the `transactions` table and return record id
    async getTxIndex(hash){
        let id      = null;
        let hash_id = await this.createTransaction(hash);
        let db      = await this.getConnection();
        let query = "SELECT tx_index FROM transactions WHERE tx_hash_id=? LIMIT 1";
        try {
            let rows = await db.query(query, [hash_id]);
            if(rows.length > 0)
                id = rows[0].tx_index;
        } catch (err) {
            console.error('Error looking up tx_index in transactions table:', err);
        }
        await this.releaseConnection();
        return id;
    }

    // Create records in the 'transactions' table and return record id
    async createTxIndex(data){
        var id = await this.getTxIndex(data.TX_HASH);
        // Handle creating record
        if(id==null){
            let block_index = data.BLOCK_INDEX;
            let tx_hash_id  = await this.createTransaction(data.TX_HASH);
            let action_id   = await this.createAction(data.ACTION);
            let tx_index    = await this.getNextTxIndex();
            let db          = await this.getConnection();
            let query       = "INSERT INTO transactions (tx_index, block_index, tx_hash_id, action_id) values (?, ?, ?, ?)";
            try {
                let result = await db.query(query, [tx_index, block_index, tx_hash_id, action_id]);
            } catch (err) {
                console.error('Error while trying to create record in transactions table:', err);
                util.throwError('Error while trying to create record in transactions table');
            }
            await this.releaseConnection();
        }
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
        } catch (err) {
            console.error('Error looking up ticker record id in index_tickers table:', err);
        }
        await this.releaseConnection();
        return id;
    }

    // Create records in the 'index_actions' table and return record id
    async createTicker(tick){
        var id = await this.getTickerId(tick);
        // Handle creating record
        if(id==null){
            let db    = await this.getConnection();
            let query = "INSERT INTO index_tickers (tick) values (?)";
            try {
                let result = await db.query(query, [tick]);
                if(result.insertId)
                    id = result.insertId;
            } catch (err) {
                console.error('Error trying to create ticker record in index_tickers table:', err);
            }
            await this.releaseConnection();
        }
        return id;
    }

    // Handle getting token information using issues table
    // @param {tick}            string  Ticker name
    // @param {tick_id}         integer Ticker database record id
    // @param {block_index}     integer Block Index 
    // @param {tx_index}        integer tx_index of transaction
    async getTokenInfo(tick, tick_id, block_index, tx_index){
        let data = false,
            sql  = '',
            args = [];
        // Get the tick_id for the given ticker
        if(!util.isNull(tick) && util.isNull(tick_id))
            tick_id = await this.createTicker(tick);
        // Add tick_id to SQL query arguments
        args.push(tick_id);
        // If a block_index was given, only lookup tokens created before or in given block_index
        if(!util.isNull(block_index) && util.isNumeric(block_index)){
            sql += " AND t1.block_index <= ?";
            args.push(parseInt(block_index));
        }
        // If a tx_index was given, only lookup tokens created before given tx_index
        if(!util.isNull(tx_index) && util.isNumeric(tx_index)){
            sql += " AND t1.tx_index < ?";
            args.push(parseInt(tx_index));
        }
        // Build out SQL query based on search params
        let query = `SELECT 
                        t2.tick,
                        t1.max_supply,
                        t1.max_mint,
                        t1.decimals,
                        t1.description,
                        t1.block_index,
                        t1.lock_max_supply,
                        t1.lock_mint_supply,
                        t1.lock_mint,
                        t1.lock_max_mint,
                        t1.lock_description,
                        t1.lock_rug,
                        t1.lock_sleep,
                        t1.lock_callback,
                        t1.callback_block,
                        t3.tick as callback_tick,            
                        t1.callback_amount,
                        t4.hash as allow_list,
                        t5.hash as block_list,
                        t1.mint_address_max,
                        t1.mint_start_block,
                        t1.mint_stop_block,
                        a1.address as owner,
                        a2.address as transfer
                    FROM 
                        issues t1
                        LEFT JOIN index_addresses a2 on (a2.id=t1.transfer_id)
                        LEFT JOIN index_tickers t3 on (t3.id=t1.callback_tick_id)
                        LEFT JOIN index_transactions t4 on (t4.id=t1.allow_list_id)
                        LEFT JOIN index_transactions t5 on (t5.id=t1.block_list_id),
                        index_tickers t2,
                        index_addresses a1,
                        index_statuses s1
                    WHERE 
                        t2.id=t1.tick_id AND
                        a1.id=t1.source_id AND
                        s1.id=t1.status_id AND
                        s1.status='valid' AND
                        t1.tick_id=?` + sql + `
                    ORDER BY tx_index ASC`;
        try {
            let db   = await this.getConnection();
            let rows = await db.query(query, args);
            if(rows.length > 0){
                // Define data object
                if(!data)
                    data = {};
                // Loop through ISSUE transactions for the given ticker
                rows.forEach(function(row){
                    // Define object of values for this ISSUE tx
                    let arr  = {};
                    arr['TICK']              = row.tick;
                    arr['OWNER']             = (row.transfer) ? row.transfer : row.owner;
                    arr['MAX_SUPPLY']        = row.max_supply;
                    arr['MAX_MINT']          = row.max_mint;
                    // Force decimal precision to a integer value
                    arr['DECIMALS']          = (!util.isNull(row.decimals)) ? parseInt(row.decimals) : 0;
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
                    for(key in arr){
                        let value = arr[key];
                        console.log('key,value=',key,value);
                        // Disallow unsetting of LOCK flags
                        if(String(key).substr(0,5)=='LOCK_')
                            if(data[key]==1)
                                continue;
                        // Prevent changing decimal precision 
                        if(key=='DECIMALS' && data[key] > value)
                            continue;
                        // Skip setting value if value is null or empty (use last explicit value)
                        if(util.isNull(value) || value=='')
                            continue;
                        // Update data object with value from this ISSUE tx
                        data[key] = value;
                    }
                });
            }
        } catch (err) {
            console.error('Error looking up token info : ', err);
        }
        await this.releaseConnection();
        // Get token supply at the given tx_index
        if(data)
            data['SUPPLY'] = await this.getTokenSupply(tick, tick_id, null, tx_index); 
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
                rows.forEach(function(row){
                if(!isNull(row.decimals) && row.decimals > decimals)
                    decimals = row.decimals;
                });
            }
        } catch (err) {
            console.error('Error looking up decimal precision from the issues table:', err);
        }
        await this.releaseConnection();
        return decimals;
    }

    // Get token supply from credits/debits table (credits - debits = supply)
    // @param {tick}            string  Ticker name
    // @param {tick_id}         integer Ticker database record id
    // @param {block_index}     integer Block Index 
    // @param {tx_index}        integer tx_index of transaction
    async getTokenSupply(tick, tick_id, block_index, tx_index){
        let credits = 0;
        let debits  = 0;
        let escrow  = 0;
        let supply  = 0;
        let db      = await this.getConnection(),
            sql     = '',
            query   = '',
            args    = [];
        // Get the tick_id for the given ticker
        if(!util.isNull(tick) && util.isNull(tick_id))
            tick_id = await this.createTicker(tick);
        // Get info on decimal precision
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        // Add tick_id to SQL query arguments
        args.push(tick_id);
        // If a block_index was given, only lookup tokens created before or in given block_index
        if(!util.isNull(block_index) && util.isNumeric(block_index)){
            sql += " AND m.block_index <= ?";
            args.push(parseInt(block_index));
        }
        // If a tx_index was given, only lookup tokens created before given tx_index
        if(!util.isNull(tx_index) && util.isNumeric(tx_index)){
            sql += " AND t.tx_index < ?";
            args.push(parseInt(tx_index));
        }
        // Get Credits 
        query = `SELECT 
                    CAST(SUM(m.amount) AS DECIMAL(60,` + decimals + `)) as credits 
                FROM 
                    credits m,
                    transactions t
                WHERE 
                    m.event_id=t.tx_hash_id AND
                    m.tick_id=?` + sql;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                credits = rows[0].credits;
        } catch (err) {
            console.error('Error while trying to get list of credits:', err);
        }
        // Get Debits 
        query = `SELECT 
                    CAST(SUM(m.amount) AS DECIMAL(60,` + decimals + `)) as debits 
                FROM 
                    debits m,
                    transactions t
                WHERE 
                    m.event_id=t.tx_hash_id AND
                    m.tick_id=?` + sql;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0)
                debits = rows[0].debits;
        } catch (err) {
            console.error('Error while trying to get list of debits:', err);
        }
        // TODO: Get Escrowed supply
        // query = `SELECT 
        //             CAST(SUM(m.amount) AS DECIMAL(60,` + decimals + `)) as escrow 
        //         FROM 
        //             debits m,
        //             transactions t
        //         WHERE 
        //             m.event_id=t.tx_hash_id AND
        //             m.tick_id=?` + sql;
        // try {
        //     let rows = await db.query(query, args);
        //     if(rows.length > 0)
        //         escrow = rows[0].escrow;
        // } catch (err) {
        //     console.error('Error while trying to get list of escrowed supply:', err);
        // }
        // Determine total supply (credits - debits)
        supply = util.bcsub(credits, debits, decimals);
        return supply;
    }

    // Handle getting a list of TICK holders and amounts
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {tx_index}        integer tx_index of transaction
    // TODO: Add support for 'escrowed' tokens (dispensers, orders, bets)
    async getHolders(tick, block_index, tx_index){
        let holders = {};
        let db      = await this.getConnection(),
            sql     = '',
            query   = '',
            args    = [];
        // Get the tick_id for the given ticker
        if(!util.isNull(tick) && util.isNull(tick_id))
            tick_id = await this.createTicker(tick);
        // Get info on decimal precision
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        // Add tick_id to SQL query arguments
        args.push(tick_id);
        // If a block_index was given, only lookup tokens created before or in given block_index
        if(!util.isNull(block_index) && util.isNumeric(block_index)){
            sql += " AND m.block_index <= ?";
            args.push(parseInt(block_index));
        }
        // If a tx_index was given, only lookup tokens created before given tx_index
        if(!util.isNull(tx_index) && util.isNumeric(tx_index)){
            sql += " AND t.tx_index < ?";
            args.push(parseInt(tx_index));
        }
        // Get Credits 
        query = `SELECT 
                    CAST(SUM(m.amount) AS DECIMAL(60,` + decimals + `)) as credits,
                    a.address
                FROM 
                    credits m,
                    transactions t,
                    index_addresses a
                WHERE 
                    m.event_id=t.tx_hash_id AND
                    m.address_id=a.id AND
                    m.tick_id=?` + sql;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0){
                rows.forEach(function(row){
                    holders[row.address] = row.credits;
                });
            }
        } catch (err) {
            console.error('Error while trying to get list of holders from credits table:', err);
        }
        // Get Debits 
        query = `SELECT 
                    CAST(SUM(m.amount) AS DECIMAL(60,` + decimals + `)) as debits,
                    a.address
                FROM 
                    debits m,
                    transactions t,
                    index_addresses a
                WHERE 
                    m.event_id=t.tx_hash_id AND
                    m.address_id=a.id AND
                    m.tick_id=?` + sql;
        try {
            let rows = await db.query(query, args);
            if(rows.length > 0){
                rows.forEach(function(row){
                    let balance = util.bcsub(holders[row.address], row.debits, decimals);
                    if(balance > 0)
                        holders[row.address] = balance;
                    else
                       delete holders[row.address];
                });
            }
        } catch (err) {
            console.error('Error while trying to get list of holders from debits table:', err);
        }
        return holders;
    }

    // Determine if an ticker is distributed to users (held by more than owner)
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {tx_index}        integer tx_index of transaction
    async isDistributed(tick, block_index, tx_index){
        let info    = await this.getTokenInfo(tick, null, block_index, tx_index);
        let holders = (info) ? await this.getHolders(tick, block_index, tx_index) : [];
        // More than one holder
        if(Object.keys(holders).length>1)
            return true;
        // Holder that is not OWNER
        for(address in holders)
            if(address!=info['OWNER'])
                return true;
        return false;
    }

}

module.exports = Database