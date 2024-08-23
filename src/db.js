/* XChain Indexer Database Connector */

const mariadb = require('mariadb');
const fs      = require('fs');

class Database {

    // Handle constructing a class instance
    constructor(host, port, dbName, user, pass) {
        // Database connection information
        this.host   = host;
        this.port   = port;
        this.dbName = dbName;
        this.user   = user;
        this.pass   = pass;
        // Database pool connection parameters
        let connectionParams = {
            host: host,
            user: user,
            password: pass,
            database: dbName,
            connectionLimit: 5,
            //connectTimeout: 0,
            port: port
        };
        // Setup pool of connections
        this.pool = mariadb.createPool(connectionParams);   
        this.transactionConnection = null;
    }

    // Hnadle sleeping for a given number of milliseconds
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Handle throwing an error and logging to console
    throwError(error){
        console.log(error);
        throw new Error(error);
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
                await this.sleep(5000); // Wait 5 seconds
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
                await this.sleep(5000); // Waiting 5 seconds
            }
        }
        return true;
    }
    
    // Handle verifying all database tables exist 
    async verifyTables(){
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port
        };
        let path  = '/XChainIndexer/src/sql';
        let files = fs.readdirSync(path);
        let file  = null;
        let db    = await mariadb.createConnection(connectionParams);
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
                    console.log('Error: SQL error=',e);
                    this.throwError('Error while trying to verify ' + table + ' table exists!');
                }
            }
        }
        db.end();
    }

    // Handle verifying all database tables exist 
    async createTable(file){
        let connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port
        };
        let path    = '/XChainIndexer/src/sql';
        let data    = fs.readFileSync(path + '/' + file, "utf8");
        let table   = file.substring(0, file.indexOf('.sql'));
        let db      = await mariadb.createConnection(connectionParams);
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
                console.log('Error: SQL query=',query);
                this.throwError('Error while trying to create ' + table + ' table!');
            }
        }
        db.end();
    }

    /* 
     * Common database connection functions
     */

    // Handle getting a database Connection    
    async getConnection(){
        if(this.transactionConnection)
            return this.transactionConnection;
        var connection = null
        while(connection == null){        
            try {
                connection = await this.pool.getConnection();
                // console.log("Connected to database!")
            } catch (e){
                console.log("Can't connect to mariadb. Trying again...");
                connection = null;
                await this.sleep(1000);
            }
        }
        return connection;
    }

    // Handle beginning a SQL transaction
    async beginTransaction(){
        if(this.transactionConnection != null)
            await this.endTransaction();
        this.transactionConnection = await this.getConnection();
        try {
            await this.transactionConnection.beginTransaction();
        } catch(err){
            throw err
        }
    }
    
    // Handle ending a SQL transaction and rolling back any data  
    async endTransaction(){
        if(this.transactionConnection != null){
            console.log("rolling back");
            await this.transactionConnection.rollback();
            await this.transactionConnection.release();
            this.transactionConnection = null;
        }  
    }
    
    // Handle commiting a SQL transaction    
    async commitTransaction(){
        if(this.transactionConnection != null){
            try {
                await this.transactionConnection.commit();
                this.transactionConnection.release();
                this.transactionConnection = null;
                return true;
            } catch (e){
                console.log(e);
                console.log("There was an error trying to commit a transaction");
                this.transactionConnection = null; //the transaction is not valid anymore
            }
        }
        return false      
    }

}

module.exports = Database