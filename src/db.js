/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
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
const path    = require('path');

class Database {

    // Handle constructing a class instance
    constructor(host, port, dbName, user, pass, indexer) {
        // Parse in indexer configuration
        this.config = indexer.config

        // Create instance of the utility class
        this.util   = indexer.util;

        // Reference back to the parent indexer (so dependent code can access hubDb, etc.)
        this.indexer = indexer;

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
            connectionLimit:      10,
            connectTimeout:       10000,
            acquireTimeout:       10000,
            idleTimeout:          60000,
            insertIdAsNumber:     true,
            // Return BIGINT columns as JS Numbers rather than BigInts. Without
            // this, any JSON-RPC handler returning a DB row crashes the process
            // on res.json() with `TypeError: Do not know how to serialize a
            // BigInt` (xchain-hub polls getlatestblock/getactivevalidators/
            // getownstake on a loop, so the crash window is always open).
            // Matches xchain-hub and xchain-sync; all indexer BIGINT columns
            // are within Number.MAX_SAFE_INTEGER for any realistic chain.
            bigIntAsNumber:       true,
            minDelayValidation:   3000,
            queryTimeout:         parseInt(process.env.DB_QUERY_TIMEOUT) || 30000
        };

        // Setup pool of connections
        this.pool = mariadb.createPool(this.connectionPoolParams);
        this.transactionConnection = null;

        // Circuit breaker state for database connections
        this.circuitState     = 'closed';  // closed | open | half-open
        this.circuitFailures  = 0;         // consecutive connection failures
        this.circuitThreshold = 10;        // failures before opening circuit
        this.circuitCooldown  = 30000;     // 30s cooldown before half-open retry
        this.circuitOpenUntil = 0;         // timestamp when circuit can transition to half-open
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
                let db      = await mariadb.createConnection(connectionParams);
                let results = await db.query("SELECT * FROM information_schema.schemata WHERE schema_name = ?",[this.dbName]);
                await db.end();
                if(results.length > 0)
                    return true;
                return false;
            } catch (e){
                console.error('Error checking if database ' + this.dbName + ' exists:', e)
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
        // Validate database name to prevent SQL injection
        if(!/^[A-Za-z0-9_]+$/.test(this.dbName))
            throw new Error('Invalid database name: ' + this.dbName);
        console.log("Creating " + this.dbName + " database!");
        while(!databaseCreated){
            try {
                let db      = await mariadb.createConnection(connectionParams);
                let results = await db.query("CREATE DATABASE IF NOT EXISTS `" + this.dbName + "`");
                await db.end();
                databaseCreated = true;
            } catch(e){
                console.error('Error creating database ' + this.dbName + ':', e)
                await this.util.sleep(5000); // Waiting 5 seconds
            }
        }
        return true;
    }
    
    // Handle verifying all database tables exist
    async verifyTables(){
        let dir   = path.join(__dirname, 'sql');
        let files = fs.readdirSync(dir);
        let file  = null;
        let db    = await this.getConnection();
        // Loop through SQL files
        for (file of files){
            if(file.indexOf('.sql') !== -1){
                let table   = file.substring(0, file.indexOf('.sql'));
                console.log('Verifying ' + table + ' table exists...');
                try {
                    let results = await db.query("SELECT * FROM information_schema.tables WHERE table_schema = ? AND table_name = ?",[this.dbName, table]);
                    if(results.length > 0){
                        // Existing table — reconcile column nullability against the
                        // SQL source. Catches schemas that were updated upstream but
                        // never migrated on stacks created from an older release.
                        await this.alterTableForDrift(file, db);
                        // Also reconcile declared indexes. A UNIQUE index added to the
                        // SQL source AFTER a table was first created (e.g. balances'
                        // addr_tick on 2026-05-29) is otherwise never applied, which
                        // silently degrades updateAddressBalance's INSERT ... ON DUPLICATE
                        // KEY UPDATE to a plain INSERT and accumulates duplicate rows.
                        await this.reconcileTableIndexes(file, db);
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
        await db.release();
        return true;
    }

    // Parse a CREATE TABLE statement to extract expected column nullability.
    // Conservative — only used for drift detection, not for full schema mgmt.
    // Returns array of {name, nullable} or null when parsing can't recognize
    // the file (e.g. a non-CREATE-TABLE definition).
    parseExpectedColumns(sqlData){
        // Strip `--` line comments BEFORE any structural parsing. Inline comments
        // routinely contain commas and parens (e.g. `-- 0=request, 1=response
        // (matches ...)`) that otherwise fool the top-level-comma split below into
        // emitting phantom columns and triggering bogus ADD COLUMN drift fixes.
        sqlData = this.stripSqlLineComments(sqlData);
        const m = sqlData.match(/CREATE\s+TABLE\s+\S+\s*\(([\s\S]+?)\)\s*ENGINE/i);
        if(!m) return null;
        // Split on top-level commas (i.e. commas not inside type parens like VARCHAR(250))
        const parts = m[1].split(/,(?![^()]*\))/g);
        const cols = [];
        for(let raw of parts){
            // Strip trailing `-- comment` text
            let line = raw.replace(/--[^\n\r]*/g, '').trim();
            if(!line) continue;
            // Skip constraint/index/key lines — column definitions only
            if(/^(PRIMARY|UNIQUE|INDEX|KEY|CHECK|CONSTRAINT|FOREIGN)\b/i.test(line)) continue;
            const tokens = line.split(/\s+/);
            if(tokens.length < 2) continue;
            const name = tokens[0].replace(/`/g, '');
            // SQL columns are NULL unless explicitly NOT NULL
            const nullable = !/\bNOT\s+NULL\b/i.test(line);
            // Keep the full (comment-stripped) column definition so a missing
            // column can be re-added verbatim — this preserves the DEFAULT
            // clause, which is what backfills existing rows on NOT NULL columns.
            const notNull    = !nullable;
            const hasDefault = /\bDEFAULT\b/i.test(line);
            cols.push({ name, nullable, definition: line, notNull, hasDefault });
        }
        return cols.length > 0 ? cols : null;
    }

    // Detect schema drift between the live table and its SQL source, and fix
    // it by ALTER. Two kinds of drift are handled:
    //   1. Missing columns — a column declared in the SQL source but absent
    //      from the live table is added with ADD COLUMN, reusing the source
    //      definition verbatim so its DEFAULT clause backfills existing rows.
    //      (A NOT NULL column with no DEFAULT can't be backfilled safely, so
    //      it's skipped with a loud warning rather than aborting startup.)
    //   2. Nullability — only relaxes NOT NULL -> NULL (the safe direction —
    //      never strengthens to NOT NULL since live rows might hold NULLs that
    //      would block the ALTER).
    // Doesn't touch types or defaults of existing columns. Index reconciliation
    // is handled separately by reconcileTableIndexes(). Each applied ALTER is loudly logged.
    async alterTableForDrift(file, db){
        const dir      = path.join(__dirname, 'sql');
        const data     = fs.readFileSync(dir + '/' + file, "utf8");
        const table    = file.substring(0, file.indexOf('.sql'));
        const expected = this.parseExpectedColumns(data);
        if(!expected) return;
        const live = await db.query(
            "SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE FROM information_schema.columns WHERE table_schema = ? AND table_name = ?",
            [this.dbName, table]
        );
        const liveByName = new Map(live.map(c => [c.COLUMN_NAME.toLowerCase(), c]));
        for(const exp of expected){
            const cur = liveByName.get(exp.name.toLowerCase());
            if(!cur){
                // Column declared in the SQL source but absent from the live
                // table (schema created before the column was introduced).
                if(exp.notNull && !exp.hasDefault){
                    console.log('Schema drift on ' + table + '.' + exp.name + ': column missing live, source is NOT NULL with no DEFAULT — cannot backfill existing rows safely. Skipping; add manually.');
                    continue;
                }
                console.log('Schema drift on ' + table + '.' + exp.name + ': column missing live. Adding column from SQL source.');
                await db.query('ALTER TABLE `' + table + '` ADD COLUMN ' + exp.definition);
                continue;
            }
            const liveIsNullable = cur.IS_NULLABLE === 'YES';
            if(!liveIsNullable && exp.nullable){
                console.log('Schema drift on ' + table + '.' + exp.name + ': live=NOT NULL, source=NULL. Relaxing constraint.');
                await db.query('ALTER TABLE `' + table + '` MODIFY `' + exp.name + '` ' + cur.COLUMN_TYPE + ' NULL');
            }
        }
    }

    // Parse standalone `CREATE [UNIQUE] INDEX <name> ON <table> (<cols>)` statements
    // from a table's SQL source. Returns [{name, unique, columns:[...]}]. Inline
    // PRIMARY KEY / UNIQUE clauses inside CREATE TABLE are created with the table and
    // are not reconciled here. Index/column names come from the trusted SQL files.
    parseExpectedIndexes(sqlData, table){
        sqlData = this.stripSqlLineComments(sqlData);
        const re = /CREATE\s+(UNIQUE\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?\s*\(\s*([\s\S]+?)\s*\)\s*;/gi;
        const out = [];
        let m;
        while((m = re.exec(sqlData)) !== null){
            if(m[3].toLowerCase() !== table.toLowerCase()) continue;
            // Split the column list on commas; strip backticks, ASC/DESC, and any (len) prefix.
            const columns = m[4].split(',')
                .map(c => c.trim().replace(/`/g, '').split(/\s+/)[0].replace(/\(\d+\)$/, ''))
                .filter(Boolean);
            if(columns.length) out.push({ name: m[2], unique: !!m[1], columns });
        }
        return out;
    }

    // Reconcile declared indexes against the live table. Adds any index named in the
    // SQL source that is absent live (matched by column set, so a renamed-but-equivalent
    // index is treated as present). For a UNIQUE index blocked by pre-existing duplicate
    // rows, dedupes first (see dedupeForUniqueIndex) then retries. Never throws — a
    // failure is logged and startup continues. On a table that already has every declared
    // index (the normal case) this is a single information_schema read and a no-op.
    async reconcileTableIndexes(file, db){
        try {
            const dir      = path.join(__dirname, 'sql');
            const data     = fs.readFileSync(dir + '/' + file, "utf8");
            const table    = file.substring(0, file.indexOf('.sql'));
            const expected = this.parseExpectedIndexes(data, table);
            if(!expected.length) return;

            // Live indexes -> map keyed by ordered column-set: "c1,c2" => {unique}
            const rows = await db.query(
                "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.statistics " +
                "WHERE table_schema = ? AND table_name = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
                [this.dbName, table]);
            const byName = new Map();
            const liveNames = new Set();
            for(const r of rows){
                liveNames.add(r.INDEX_NAME.toLowerCase());
                if(!byName.has(r.INDEX_NAME)) byName.set(r.INDEX_NAME, { unique: Number(r.NON_UNIQUE) === 0, cols: [] });
                byName.get(r.INDEX_NAME).cols.push(r.COLUMN_NAME.toLowerCase());
            }
            const liveByCols = new Map();
            for(const info of byName.values()) liveByCols.set(info.cols.join(','), info);

            for(const idx of expected){
                const key  = idx.columns.map(c => c.toLowerCase()).join(',');
                const live = liveByCols.get(key);
                if(live && (!idx.unique || live.unique)) continue;          // already satisfied
                if(liveNames.has(idx.name.toLowerCase())) continue;          // name taken by a different index — leave alone
                const colList = idx.columns.map(c => '`' + c + '`').join(', ');

                if(!idx.unique){
                    console.log('Schema drift on ' + table + ': missing index ' + idx.name + ' (' + key + '). Adding.');
                    await db.query('ALTER TABLE `' + table + '` ADD INDEX `' + idx.name + '` (' + colList + ')');
                    continue;
                }
                try {
                    console.log('Schema drift on ' + table + ': missing UNIQUE index ' + idx.name + ' (' + key + '). Adding.');
                    await db.query('ALTER TABLE `' + table + '` ADD UNIQUE INDEX `' + idx.name + '` (' + colList + ')');
                } catch(e){
                    const dup = e && (Number(e.errno) === 1062 || /duplicate entry/i.test(e.message || ''));
                    if(!dup){ console.log('  could not add UNIQUE index ' + idx.name + ' on ' + table + ': ' + (e && e.message)); continue; }
                    console.log('  ' + table + '.' + idx.name + ': duplicate rows block the UNIQUE index — deduping (keep newest id per ' + key + ') then retrying.');
                    if(!(await this.dedupeForUniqueIndex(db, table, idx.columns))) continue;
                    try {
                        await db.query('ALTER TABLE `' + table + '` ADD UNIQUE INDEX `' + idx.name + '` (' + colList + ')');
                        console.log('  added ' + idx.name + ' after dedupe.');
                    } catch(e2){
                        console.log('  ' + table + '.' + idx.name + ' still failing after dedupe — leaving as-is: ' + (e2 && e2.message));
                    }
                }
            }
        } catch(e){
            // Never abort startup over index reconciliation.
            console.warn('reconcileTableIndexes(' + file + ') failed (non-fatal): ' + (e && e.message));
        }
    }

    // Collapse duplicate rows on `columns` so a UNIQUE index can be added, keeping the
    // row with the highest `id` in each group. For the failure this repairs — an
    // INSERT ... ON DUPLICATE KEY UPDATE upsert that degraded to plain INSERT because the
    // unique index was missing — each balance change appended a fresh row with the current
    // value, so the highest id is the live (correct) value and the older rows are stale.
    // Uses `=` (not `<=>`) so NULL tuples are left intact, matching UNIQUE semantics (a
    // UNIQUE index permits multiple NULLs). Requires a single `id` column to pick a
    // survivor; skips with a warning if absent. Returns true if the table is now safe to index.
    async dedupeForUniqueIndex(db, table, columns){
        const hasId = (await db.query(
            "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND COLUMN_NAME = 'id'",
            [this.dbName, table])).length > 0;
        if(!hasId){
            console.log('  cannot dedupe ' + table + ' (no `id` column to pick a surviving row) — skipping unique-index add.');
            return false;
        }
        const on  = columns.map(c => 't1.`' + c + '` = t2.`' + c + '`').join(' AND ');
        const res = await db.query('DELETE t1 FROM `' + table + '` t1 JOIN `' + table + '` t2 ON ' + on + ' AND t1.id < t2.id');
        console.log('  deduped ' + table + ': removed ' + (res && res.affectedRows != null ? res.affectedRows : '?') + ' stale duplicate row(s).');
        return true;
    }

    // Handle creating database tables.
    //
    // Uses raw db.query (not doQuery) because doQuery swallows non-transactional
    // errors — a DROP TABLE that committed followed by a CREATE TABLE that
    // failed on a connection blip would leave a partial-state table missing
    // (observed on LTC regtest: `dispensers` ended up missing after a transient
    // MariaDB hiccup during init, fatal-looped the indexer on every block).
    // Retries the whole file with exponential backoff so transient DB issues
    // don't leave half-built schema.
    // Remove SQL `--` line comments while respecting quoted strings, so a ';'
    // appearing inside comment prose is never mistaken for a statement
    // terminator. Single/double-quote and backtick spans are preserved verbatim
    // (doubled quotes treated as escapes); a `--` outside any quote skips to the
    // end of its line. Newlines are kept so error positions stay meaningful.
    stripSqlLineComments(sql){
        let out = '';
        let quote = null;
        for(let i = 0; i < sql.length; i++){
            const ch = sql[i];
            if(quote){
                out += ch;
                if(ch === quote){
                    if(sql[i + 1] === quote){ out += sql[++i]; }
                    else { quote = null; }
                }
                continue;
            }
            if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; out += ch; continue; }
            if(ch === '-' && sql[i + 1] === '-'){
                while(i < sql.length && sql[i] !== '\n'){ i++; }
                if(i < sql.length){ out += '\n'; }
                continue;
            }
            out += ch;
        }
        return out;
    }

    async createTable(file){
        const dir     = path.join(__dirname, 'sql');
        const data    = fs.readFileSync(dir + '/' + file, "utf8");
        const table   = file.substring(0, file.indexOf('.sql'));
        // Strip `--` line comments BEFORE splitting on ';'. A ';' inside a
        // comment (prose punctuation in a header block) must not be treated as
        // a statement terminator — that truncates the comment into a bogus
        // standalone query and fails schema creation (observed: a semicolon in
        // attests.sql's header split its comment, crash-looping the indexer).
        const queries = this.stripSqlLineComments(data).split(';').map(q => q.trim()).filter(q => q !== '');
        console.log('Creating ' + table + ' table and indexes...');

        const MAX_ATTEMPTS = 5;
        let lastErr = null;
        for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
            let db = null;
            try {
                db = await this.getConnection();
                for(const query of queries){
                    await db.query(query);
                }
                await db.release();
                return;
            } catch (err) {
                lastErr = err;
                if(db){
                    try { await db.release(); } catch (_){}
                }
                if(attempt >= MAX_ATTEMPTS) break;
                const backoffMs = Math.min(30000, 500 * Math.pow(2, attempt - 1));
                console.log('Error creating ' + table + ' (attempt ' + attempt + '/' + MAX_ATTEMPTS + '): ', err, '. Retrying in ' + backoffMs + 'ms...');
                await this.util.sleep(backoffMs);
            }
        }
        this.util.throwError('Failed to create ' + table + ' table after ' + MAX_ATTEMPTS + ' attempts: ' + (lastErr ? lastErr.message : 'unknown'));
    }

    /* 
     * Common database connection functions (connect / rollback / commit / doQuery)
     */

    // Handle getting a database Connection (with exponential backoff + jitter)
    async getConnection(){
        if(this.transactionConnection)
            return this.transactionConnection;
        // Circuit breaker: reject immediately if open
        if(this.circuitState === 'open'){
            if(Date.now() < this.circuitOpenUntil)
                this.util.throwError('Circuit breaker open — database connections rejected until cooldown expires');
            // Cooldown expired, transition to half-open
            this.circuitState = 'half-open';
            console.log('Circuit breaker half-open — attempting reconnection');
        }
        var connection    = null;
        var attempts      = 0;
        var maxAttempts   = 30;
        var baseDelay     = 500;   // 500ms initial delay
        var maxDelay      = 15000; // 15s max delay
        while(connection == null){
            try {
                connection = await this.pool.getConnection();
                // Reset circuit breaker on success
                if(this.circuitState === 'half-open'){
                    this.circuitState = 'closed';
                    this.circuitFailures = 0;
                    console.log('Circuit breaker closed — database connection restored');
                }
                this.circuitFailures = 0;
            } catch (e){
                attempts++;
                this.circuitFailures = (this.circuitFailures || 0) + 1;
                // Circuit breaker: open after consecutive failures
                if(this.circuitFailures >= this.circuitThreshold){
                    this.circuitState = 'open';
                    this.circuitOpenUntil = Date.now() + this.circuitCooldown;
                    this.util.throwError('Circuit breaker opened after ' + this.circuitFailures + ' consecutive failures — cooling down for ' + (this.circuitCooldown / 1000) + 's');
                }
                if(attempts >= maxAttempts)
                    this.util.throwError('Could not connect to MariaDB after ' + maxAttempts + ' attempts. Giving up.');
                // Exponential backoff with jitter: delay = min(baseDelay * 2^attempt, maxDelay) + random jitter
                let delay = Math.min(baseDelay * Math.pow(2, attempts - 1), maxDelay);
                let jitter = Math.floor(Math.random() * delay * 0.3); // up to 30% jitter
                let totalDelay = delay + jitter;
                console.error('MariaDB connection attempt ' + attempts + '/' + maxAttempts + ' failed. Retrying in ' + totalDelay + 'ms...', e)
                connection = null;
                await this.util.sleep(totalDelay);
            }
        }
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
            await this.transactionConnection.release();
            this.transactionConnection = null;
            this.util.throwError('beginTransaction error=' + e);
        }
    }

    // Handle rolling back a SQL transaction and releasing the connection
    async rollbackTransaction(){
        if(this.transactionConnection != null){
            console.log("rolling back");
            try {
                await this.transactionConnection.rollback();
            } finally {
                await this.transactionConnection.release();
                this.transactionConnection = null;
            }
        }
    }
    
    // Handle commiting a SQL transaction and releasing the connection
    async commitTransaction(){
        if(this.transactionConnection != null){
            try {
                await this.transactionConnection.commit();
                await this.transactionConnection.release();
                this.transactionConnection = null;
                return true;
            } catch (e){
                console.error('Error committing transaction:', e)
                try {
                    await this.transactionConnection.rollback();
                } finally {
                    await this.transactionConnection.release();
                    this.transactionConnection = null;
                }
                this.util.throwError('commitTransaction error=' + e);
            }
        }
        return false;
    }

    // Handle running a query and returning the results
    async doQuery(query, args){
        let results = [];
        if(!this.util.isNull(query)){
            // Normalize args: convert any boxed primitives (e.g. mathjs BigNumber) to plain values.
            // Skip Buffers — the mariadb driver inserts them as binary into BLOB columns; calling
            // .toString() on them would UTF-8-decode the bytes and replace invalid sequences with
            // U+FFFD, corrupting binary payloads (e.g. FILE raw_data ciphertext).
            if(Array.isArray(args)){
                for(let i = 0; i < args.length; i++){
                    if(args[i] !== null && args[i] !== undefined && typeof args[i] === 'object' && !Buffer.isBuffer(args[i]))
                        args[i] = args[i].toString();
                }
            }
            let tx = this.transactionConnection != null;
            let db = await this.getConnection();
            try {
                results = await db.query(query, args);
            } catch (error){
                this.util.logError('Error running database query :', error);
                // Inside a transaction, re-throw so the block-level catch triggers a rollback
                // This prevents silent data loss from failed writes within an ACID transaction
                if(tx)
                    throw error;
            }
            // Release the connection if we are not in the middle of a ACID transaction
            if(!tx)
                await db.release();
        }
        return results;
    }

    /* 
     * General database functions
     */

    // Handle normalizing data values before inserting in the database tables
    normalizeDataValues(data){
        // Handle converting any boxed primitives (e.g. mathjs Decimal) to plain primitives.
        // Buffers (e.g. FILE raw_data) must pass through unchanged — String(buffer) would
        // UTF-8-decode the bytes and replace any invalid sequences with U+FFFD, corrupting
        // binary payloads like AES-GCM ciphertext.
        for(let key in data){
            if(!this.util.isNull(data[key]) && typeof data[key] === 'object' && !Buffer.isBuffer(data[key]))
                data[key] = this.util.safeToString(data[key]);
        }
        // Set LIST field values to numeric value or NULL
        for(let field of this.config['LIST_FIELDS'] ){
            if(!this.util.isNull(data[field]) && !this.util.isNumeric(data[field]))
                data[field] = null;
        }
        // Set NUMBER field values to numeric or NULL
        for(let field of this.config['NUMBER_FIELDS'] ){
            if(this.util.isNull(data[field]) || !this.util.isNumeric(data[field]))
                data[field] = null;
        }
        // set LOCK field values to explicitly unlocked (0), locked (1), or null
        for(let field of this.config['LOCK_FIELDS']){
            // Convert bignumber/string lock values to plain integers before checking
            let lockVal = data[field];
            if(lockVal !== null && lockVal !== undefined && typeof lockVal === 'object' && typeof lockVal.toNumber === 'function')
                lockVal = lockVal.toNumber();
            else if(typeof lockVal === 'string' && this.util.isNumeric(lockVal))
                lockVal = parseInt(lockVal);
            if([0,1].indexOf(lockVal) == -1)
                data[field] = null;
            else
                data[field] = lockVal;
        }
        // Set DECIMALS to null if it is outside of the acceptable range
        if(!this.util.isNull(data['DECIMALS']) && (data['DECIMALS'] < this.config.MIN_TOKEN_DECIMALS || data['DECIMALS'] > this.config.MAX_TOKEN_DECIMALS))
            data['DECIMALS'] = null;
        // Handle ACTION specific customizations
        let action = (!this.util.isNull(data['ACTION'])) ? data['ACTION'] : 'UNKNOWN';
        if(action=='BROADCAST'){
            // Truncate MESSAGE value to 250 characters
            if(!this.util.isNull(data['MESSAGE']))
                data['MESSAGE'] = String(data['MESSAGE']).substring(0,250);
            // Truncate VALUE value to 25 characters
            if(!this.util.isNull(data['VALUE']))
                data['VALUE'] = String(data['VALUE']).substring(0,25);
            // Truncate FEE value to 11 characters (0.00000000)
            if(!this.util.isNull(data['FEE']))
                data['FEE']  = String(data['FEE']).substring(0,11);
        } else if(action=='FILE'){
            // Truncate NAME value to 250 characters
            if(!this.util.isNull(data['NAME']))
                data['NAME'] = String(data['NAME']).substring(0,250);
            // Truncate TITLE value to 250 characters
            if(!this.util.isNull(data['TITLE']))
                data['TITLE'] = String(data['TITLE']).substring(0,250);
        } else if(action=='ISSUE'){
            // Truncate DESCRIPTION to MAX_TOKEN_DESCRIPTION
            if(!this.util.isNull(data['DESCRIPTION']))  
                data['DESCRIPTION'] = String(data['DESCRIPTION']).substring(0,this.config['MAX_TOKEN_DESCRIPTION']);
        } else if(action=='SLEEP'){
            // Truncate RESUME_BLOCK to 25 characters
            if(!this.util.isNull(data['RESUME_BLOCK'])) 
                data['RESUME_BLOCK'] = String(data['RESUME_BLOCK']).substring(0,25);
        }
        // Truncate MEMO  to 250 characters
        if(!this.util.isNull(data['MEMO']))
            data['MEMO'] = String(data['MEMO']).substring(0,250);
        return data;
    }

    // Handle getting block index for a given component and request type
    async getBlockIndex(component, type){
        let block_index = null;
        // Bail out on any invalid request type
        var componentTypes = ['decoder', 'indexer'];
        if(!componentTypes.includes(component)){
            this.util.logError('Invalid component');
            return null;
        }
        // Bail out on any invalid request type
        var validTypes = ['first', 'last', 'reorg'];
        if(!validTypes.includes(type)){
            this.util.logError('Invalid type');
            return null;
        }
        // Handle reorgs
        if(type=='reorg'){

            // Handle getting reorg data from the decoder
            if(component=='decoder'){
                let query = `SELECT data FROM events WHERE code='REORG' ORDER BY id DESC LIMIT 1`;
                let results = await this.doQuery(query);
                if(results.length > 0){
                    for(let row of results){
                        let data = JSON.parse(row.data);
                        if(typeof data === 'object'){
                            for (let block of data){
                                // Reorg events are stored as an array of {block_index, block_hash}
                                // objects, so unwrap the numeric block index before comparing.
                                let idx = (typeof block === 'object' && block !== null) ? block.block_index : block;
                                if(idx < block_index || block_index === null)
                                    block_index = idx;
                            }
                        }

                    }
                }

            }

            // Handle getting reorg data from the indexer. Newer rows store a JSON
            // {block_index, decoder_event_id} payload; legacy rows store a bare number.
            if(component=='indexer'){
                let query = `SELECT data FROM events WHERE code='REORG' ORDER BY id DESC LIMIT 1`;
                let results = await this.doQuery(query);
                if(results.length > 0){
                    let raw = results[0]["data"];
                    try {
                        let parsed = JSON.parse(raw);
                        block_index = (parsed !== null && typeof parsed === 'object') ? Number(parsed.block_index) : Number(parsed);
                    } catch(e){
                        block_index = Number(raw);
                    }
                }
            }
        } else {
            let func  = (type=='first') ? 'MIN' : 'MAX';
            let query = 'SELECT ' + func + '(block_index) AS block_index FROM blocks';
            let results = await this.doQuery(query);
            if(results.length > 0 && !this.util.isNull(results[0]["block_index"]))
                block_index = Number(results[0]["block_index"]);
        }
        return block_index;
    }

    // Get the decoder's most-recent reorg event as { id, block_index }, or null if none.
    // `id` is the decoder events.id — the IDENTITY used to decide whether a reorg is new.
    // Block height alone is ambiguous across repeated reorgs (heights increase), so the
    // caller compares this id rather than the block number. `block_index` is the lowest
    // block touched by the event (the rollback target).
    async getLatestReorg(){
        let query = `SELECT id, data FROM events WHERE code='REORG' ORDER BY id DESC LIMIT 1`;
        let results = await this.doQuery(query);
        if(results.length === 0)
            return null;
        let row = results[0];
        let block_index = null;
        let data = JSON.parse(row.data);
        if(typeof data === 'object' && data !== null){
            for(let block of data){
                // Reorg events are stored as an array of {block_index, block_hash}
                // objects, so unwrap the numeric block index before comparing.
                let idx = (typeof block === 'object' && block !== null) ? block.block_index : block;
                if(idx < block_index || block_index === null)
                    block_index = idx;
            }
        }
        return { id: Number(row.id), block_index: block_index };
    }

    // Get the decoder event id of the most-recent reorg the indexer has already recorded,
    // or null if none. This is the value compared against getLatestReorg().id to decide
    // whether a new reorg needs processing — an IDENTITY check, not a block-height compare.
    async getLastProcessedReorgId(){
        let query = `SELECT data FROM events WHERE code='REORG' ORDER BY id DESC LIMIT 1`;
        let results = await this.doQuery(query);
        if(results.length === 0)
            return null;
        try {
            let parsed = JSON.parse(results[0]["data"]);
            if(parsed !== null && typeof parsed === 'object' && parsed.decoder_event_id !== undefined)
                return Number(parsed.decoder_event_id);
        } catch(e){
            // Legacy plain-block-number rows carry no decoder event id.
        }
        return null;
    }

    // Handle creating a record of a block reorg. Persists the decoder event id alongside the
    // block index so reorgs can be matched by identity (see getLastProcessedReorgId), not by
    // block-height magnitude — which silently misses every reorg after the first.
    async createReorg(block_index, decoder_event_id){
        let payload = JSON.stringify({ block_index: Number(block_index), decoder_event_id: Number(decoder_event_id) });
        let query = `INSERT INTO events (time, code, data) values (now(), 'REORG', ?)`;
        let args  = [payload];
        let results = await this.doQuery(query, args);
    }

    // Handle getting block transaction data for a given block from xchain-decoder database
    async getDecoderBlockData(block_index){
        let data = [];
        let query = `SELECT
                        t1.data,
                        t1.raw_data,
                        t2.hash as tx_hash,
                        a1.address as source,
                        a2.address as destination,
                        t1.amount,
                        t1.fee,
                        t1.block_index,
                        b1.block_time,
                        t3.vout,
                        t3.amount as output_amount,
                        a3.address as output_destination,
                        p1.pubkey as source_pubkey
                    FROM
                        transactions t1
                        INNER JOIN blocks              b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_transactions  t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN transaction_outputs t3 ON (t3.tx_index=t1.tx_index)
                        LEFT  JOIN index_addresses     a1 ON (a1.id=t1.source_id)
                        LEFT  JOIN index_addresses     a2 ON (a2.id=t1.destination_id)
                        LEFT  JOIN index_addresses     a3 ON (a3.id=t3.destination_id)
                        LEFT  JOIN pubkeys             p1 ON (p1.address_id=t1.source_id)
                    WHERE
                        t1.block_index=?
                    ORDER BY
                        t1.tx_index ASC,
                        t3.vout ASC`;
        let results = await this.doQuery(query, [block_index]);
        if(results.length > 0){
            // First pass: collect the stored outputs for each transaction so every emitted row can
            // carry the full output set. The indexer uses this for native-coin fee detection
            // (xchain-indexer/src/utility.js detectFeePaymentMode / validateNativeCoinFee). The
            // decoder persists the fee-destination output (and COINPAY/dispense outputs) to
            // transaction_outputs.
            let outputsByTx = {};
            for(let row of results){
                if(this.util.isNull(row.output_destination))
                    continue;
                let key = row.tx_hash;
                if(!outputsByTx[key])
                    outputsByTx[key] = [];
                outputsByTx[key].push({
                    vout:    this.util.isNull(row.vout) ? 0 : row.vout,
                    address: row.output_destination,
                    value:   row.output_amount
                });
            }
            for(let key in outputsByTx)
                outputsByTx[key].sort((a, b) => Number(a.vout) - Number(b.vout));

            for(let row of results){
                if(!this.util.isNull(row.output_destination))
                    row.destination = row.output_destination;
                if(!this.util.isNull(row.output_amount))
                    row.amount = row.output_amount;
                if(this.util.isNull(row.vout))
                    row.vout = 0;
                // Full output set for this transaction (used by native-coin fee validation)
                row.tx_outputs = outputsByTx[row.tx_hash] || [];
                delete row.output_destination;
                delete row.output_amount;
                data.push(row);
            }
        }
        return data;
    }

    // Handle getting block time for a given block
    async getBlockTime(block_index){
        let query   = `SELECT block_time from blocks where block_index=?`; 
        let results = await this.doQuery(query, [block_index]);
        if(results.length > 0)
            return results[0]['block_time'];
        return false;
    }

    // Get block hashes using credits/debits/actions table data and previous hash
    async getBlockHashes(block_index){
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
        ledger.credits = await this.doQuery(query, [block_index]);
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
        ledger.debits = await this.doQuery(query, [block_index]);
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
        ledger.escrows = await this.doQuery(query, [block_index]);
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
        actions = await this.doQuery(query, [block_index]);
        // Contract hash data
        let contracts_data = {
            contracts:   [],
            state:       [],
            executions:  [],
            emissions:   [],
            deposits:    [],
            withdrawals: []
        };
        // New deployments
        query = `SELECT c.action_index, c.source_id, c.code_hash, c.status_id
                 FROM contracts c
                 INNER JOIN actions a ON (a.action_index=c.action_index)
                 INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                 WHERE t.block_index=?
                 ORDER BY c.action_index ASC`;
        contracts_data.contracts = await this.doQuery(query, [block_index]);
        // Contract state (latest value per key written in this block)
        query = `SELECT cs.contract_index, cs.state_key, cs.state_value
                 FROM contract_state cs
                 INNER JOIN (
                     SELECT MAX(id) as max_id
                     FROM contract_state
                     WHERE block_index=?
                     GROUP BY contract_index, state_key
                 ) latest ON cs.id = latest.max_id
                 ORDER BY cs.contract_index ASC, cs.state_key ASC`;
        contracts_data.state = await this.doQuery(query, [block_index]);
        // Executions
        query = `SELECT ce.action_index, ce.contract_index, ce.caller_id, ce.gas_used, ce.status_id, ce.emitted_count
                 FROM contract_executions ce
                 INNER JOIN actions a ON (a.action_index=ce.action_index)
                 INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                 WHERE t.block_index=?
                 ORDER BY ce.action_index ASC`;
        contracts_data.executions = await this.doQuery(query, [block_index]);
        // Emissions (join through executions to get block scope)
        query = `SELECT em.execution_index, em.emitted_action, em.action_index, em.position
                 FROM contract_emissions em
                 INNER JOIN contract_executions ce ON (ce.action_index=em.execution_index)
                 INNER JOIN actions a ON (a.action_index=ce.action_index)
                 INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                 WHERE t.block_index=?
                 ORDER BY em.execution_index ASC, em.position ASC`;
        contracts_data.emissions = await this.doQuery(query, [block_index]);
        // Deposits
        query = `SELECT d.action_index, d.contract_index, d.source_id, d.tick_id, d.amount, d.status_id
                 FROM deposits d
                 INNER JOIN actions a ON (a.action_index=d.action_index)
                 INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                 WHERE t.block_index=?
                 ORDER BY d.action_index ASC`;
        contracts_data.deposits = await this.doQuery(query, [block_index]);
        // Withdrawals
        query = `SELECT w.action_index, w.contract_index, w.source_id, w.tick_id, w.amount, w.status_id
                 FROM withdrawals w
                 INNER JOIN actions a ON (a.action_index=w.action_index)
                 INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                 WHERE t.block_index=?
                 ORDER BY w.action_index ASC`;
        contracts_data.withdrawals = await this.doQuery(query, [block_index]);
        // Subtract one block from current block
        let prev_block_index = block_index -1;
        // Get hashes from the previous block to include in this blocks hash
        query = `SELECT
                t1.hash as ledger,
                t2.hash as actions,
                t3.hash as contracts
            FROM
                blocks b
                LEFT JOIN index_transactions t1 ON (t1.id=b.ledger_hash_id)
                LEFT JOIN index_transactions t2 ON (t2.id=b.actions_hash_id)
                LEFT JOIN index_transactions t3 ON (t3.id=b.contract_hash_id)
            WHERE
                b.block_index=?`;
        let results = await this.doQuery(query, [prev_block_index]);
        if(results.length >0){
            hashes['ledger']    = results[0].ledger;
            hashes['actions']   = results[0].actions;
            hashes['contracts'] = results[0].contracts;
        }
        // Define list of data to hash
        let tables = ['ledger','actions','contracts'];
        // Loop through the tables, add previous hash to data, then create new block hash
        tables.forEach(table => {
            var data = null;
            if(table=='ledger')    data = ledger;
            if(table=='actions')   data = actions;
            if(table=='contracts') data = contracts_data;
            // Include the block_index and previous block hash in the hash calculation for this block hash
            data['block_index']   = block_index;
            data['previous_hash'] = hashes[table];
            info[table] = [];
            info[table]['hash'] = this.util.getDataHash(data);
        });
        return info;
    }

    // Lookup a record in the `index_transactions` table and return record id
    async getTransactionId(hash){
        let id    = null;
        let query = "SELECT id FROM index_transactions WHERE `hash`=? LIMIT 1"
        let results = await this.doQuery(query, [hash]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    }

    // Create records in the 'index_transactions' table and return record id
    async createTransaction(hash){
        // Ignore empty hash and return NULL
        if(this.util.isNull(hash))
            return null;
        // Truncate to 250 characters
        hash = String(hash).substring(0,250);
        let id = await this.getTransactionId(hash);
        // Create transaction if it does not already exist
        if(id === null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index: a
            // concurrent insert of the same hash is skipped (no duplicate-key throw),
            // and the refetch resolves to the canonical row id.
            let query   = "INSERT IGNORE INTO index_transactions (`hash`) values (?)";
            await this.doQuery(query, [hash]);
            id = await this.getTransactionId(hash);
        }
        // Convert id to a number
        if(id !== null)
            id = Number(id);
        return id;
    }

    // Lookup a record in the `index_addresses` table and return record id
    async getAddressId(address){
        let id    = null;
        let query = "SELECT id FROM index_addresses WHERE `address`=? LIMIT 1"
        let results = await this.doQuery(query, [address]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    }

    // Create records in the 'index_addresses' table and return record id
    async createAddress(address){
        // Ignore empty address and return NULL
        if(this.util.isNull(address))
            return null;
        // Truncate to 120 characters
        address = String(address).substring(0,120);
        let id = await this.getAddressId(address);
        // Create address if it does not already exist
        if(id === null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index: a
            // concurrent insert of the same address is skipped (no duplicate-key throw),
            // and the refetch resolves to the canonical row id.
            let query   = "INSERT IGNORE INTO index_addresses (`address`) values (?)";
            await this.doQuery(query, [address]);
            id = await this.getAddressId(address);
        }
        // Convert id to a number
        if(id !== null)
            id = Number(id);
        return id;
    }

    // Lookup a record in the `blocks` table and return record id
    async getBlockId(block_index){
        let id    = null;
        let query = "SELECT id FROM blocks WHERE block_index=? LIMIT 1"
        let results = await this.doQuery(query, [block_index]);
        if(results.length > 0)
            id = Number(results[0].id);
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
        let ledger_hash_id   = await this.createTransaction(hashes.ledger.hash);
        let actions_hash_id  = await this.createTransaction(hashes.actions.hash);
        let contract_hash_id = await this.createTransaction(hashes.contracts.hash);
        // Create data
        let query = "INSERT INTO blocks (block_time, ledger_hash_id, actions_hash_id, contract_hash_id, block_index) values (?, ?, ?, ?, ?)";
        if(block_id!=null){
            query = `UPDATE
                        blocks
                    SET
                        block_time=?,
                        ledger_hash_id=?,
                        actions_hash_id=?,
                        contract_hash_id=?
                    WHERE
                        block_index=?`;
        }
        let results = await this.doQuery(query, [block_time, ledger_hash_id, actions_hash_id, contract_hash_id, block_index]);
        // Display status message
        let ledger    = String(hashes.ledger.hash).substring(0,5);
        let actions   = String(hashes.actions.hash).substring(0,5);
        let contracts = String(hashes.contracts.hash).substring(0,5);
        return [ledger, actions, contracts];
    }

    // Lookup a record in the `index_actions` table and return record id
    async getActionId(action){
        let id    = null;
        let query = "SELECT id FROM index_actions WHERE action=? LIMIT 1";
        let results = await this.doQuery(query, [action]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    }

    // Create records in the 'index_actions' table and return record id
    async createAction(action){
        var id = await this.getActionId(action);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch keeps this consistent with the other index_*
            // upserts. NOTE: index_actions carries only a non-unique index, so IGNORE
            // does not itself prevent duplicate rows under true concurrency — the
            // single-threaded block-processing loop is what serializes these inserts.
            let query = "INSERT IGNORE INTO index_actions (action) values (?)";
            await this.doQuery(query, [action]);
            id = await this.getActionId(action);
        }
        return id;
    }

    // Handles returning the highest tx_index from transactions table
    async getNextTxIndex(){
        let idx   = 0;
        let query = "SELECT tx_index FROM transactions ORDER BY tx_index DESC LIMIT 1";
        let results = await this.doQuery(query);
        if(results.length > 0)
            idx = Number(results[0].tx_index);
        // Increase current tx_index by 1 to get the next tx_index
        idx++;
        return idx;
    }

    // Lookup a record in the `transactions` table and return record id
    async getTxIndex(hash){
        let tx_index = null;
        let hash_id  = await this.createTransaction(hash);
        let query = "SELECT tx_index FROM transactions WHERE tx_hash_id=? LIMIT 1";
        let results = await this.doQuery(query, [hash_id]);
        if(results.length > 0)
            tx_index = Number(results[0].tx_index);
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
            let fee         = (data.FEE !== undefined && data.FEE !== null) ? data.FEE : null;
            let tx_data     = (data.TX_DATA !== undefined && data.TX_DATA !== null) ? data.TX_DATA : null;
            let query       = "INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id, fee, data) values (?, ?, ?, ?, ?, ?)";
            let results     = await this.doQuery(query, [tx_index, block_index, tx_hash_id, source_id, fee, tx_data]);
            // Store source pubkey mapping if the decoder provided one
            if(data.SOURCE_PUBKEY && source_id)
                await this.createPubkey(source_id, data.SOURCE_PUBKEY);
        }
        return tx_index;
    }

    // Handles returning the highest action_index from `actions` table
    async getNextActionIndex(){
        let idx   = 0;
        let query = "SELECT action_index FROM actions ORDER BY action_index DESC LIMIT 1";
        let results = await this.doQuery(query);
        if(results.length > 0)
            idx = Number(results[0].action_index);
        // Increase current action_index by 1 to get the next action_index
        idx++;
        return idx;
    }

    // Lookup action_index records in the `actions` table and return them
    async getActionIndex(data){
        let action_index  = null;
        let block_index   = data['BLOCK_INDEX'];
        let tx_index      = data['TX_INDEX'];
        let tx_vout       = data['TX_VOUT'];
        let action_format = data['FORMAT'];
        let action_id     = await this.createAction(data['ACTION']);
        let query = `SELECT
                        a.action_index
                    FROM
                        actions a
                    WHERE
                        a.block_index=? AND 
                        a.tx_index=? AND 
                        a.tx_vout=? AND
                        a.action_id=? AND
                        a.action_format=?`;
        let args = [block_index, tx_index, tx_vout, action_id, action_format];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            action_index = Number(results[0].action_index);
        return action_index;
    }

    // Create records in the 'actions' table and return record id
    async createActionIndex(data, force=false){
        // Set values to NULL if it is not already set
        data['BLOCK_INDEX'] = (!this.util.isNull(data['BLOCK_INDEX'])) ? data['BLOCK_INDEX'] : null;
        data['TX_INDEX']    = (!this.util.isNull(data['TX_INDEX'])) ? data['TX_INDEX'] : null;
        data['FORMAT']      = (!this.util.isNull(data['FORMAT'])) ? data['FORMAT'] : null;
        // Check if the action index already exists for this action
        let action_index = await this.getActionIndex(data);
        // Handle creating record
        if(action_index==null || force==true){
            action_index      = await this.getNextActionIndex();
            let block_index   = data['BLOCK_INDEX'];
            let tx_index      = data['TX_INDEX'];
            let tx_vout       = data['TX_VOUT'];
            let action_format = data['FORMAT'];
            let action_id     = await this.createAction(data['ACTION']);
            // Persist the action's TRUE source so it is never re-derived from the transaction.
            // For user actions this is the tx sender (identical to transactions.source_id); for
            // contract emissions it is the contract's derived address (the caller's EXECUTE tx
            // would otherwise mis-attribute it). createAddress returns null for null/undefined,
            // so system/synthetic actions (which pass no SOURCE) store NULL.
            let source_id     = await this.createAddress(data['SOURCE']);
            let query         = "INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id) values (?, ?, ?, ?, ?, ?, ?)";
            let args          = [action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id];
            let results       = await this.doQuery(query, args);
        }
        return action_index;
    }

    // Update records in the 'actions' table and return record id
    async updateActionIndex(action_index, action){
        if(action_index){
            let action_id = await this.createAction(action);
            let query     = "UPDATE actions SET action_id=? WHERE action_index=?";
            let args      = [action_id, action_index];
            let results   = await this.doQuery(query, args);
        }
    }

    // Delete records in the 'actions' table
    async deleteActionIndex(action_index){
        if(action_index){
            let query   = "DELETE FROM actions WHERE action_index=?";
            let args    = [action_index];
            let results = await this.doQuery(query, args);
        }
    }

    // Lookup a record in the `index_tickers` table and return record tick
    async getTicker(tick_id){
        let tick    = null;
        let query   = "SELECT tick FROM index_tickers WHERE id=? LIMIT 1";
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0)
            tick = results[0].tick;
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
        // Try to lookup id using tick passed 
        if(this.util.isNull(id)){
            let query   = "SELECT id FROM index_tickers WHERE LOWER(tick)=? LIMIT 1";
            let args    = [String(tick).toLowerCase()]
            let results = await this.doQuery(query, args);
            if(results.length > 0)
                id = Number(results[0].id);
        }
        return id;
    }

    // Create records in the 'index_tickers' table and return record id
    async createTicker(tick){
        // Ignore empty tick and return NULL
        if(this.util.isNull(tick))
            return null;
        let id = await this.getTickerId(tick);
        // Create ticker if it does not already exist
        if(id === null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index. The
            // get-first lookup above is retained because getTickerId() matches
            // case-insensitively (LOWER(tick)) while the UNIQUE index is binary —
            // refetching through getTickerId keeps that case-folding behaviour.
            let query   = "INSERT IGNORE INTO index_tickers (tick) values (?)";
            await this.doQuery(query, [tick]);
            id = await this.getTickerId(tick);
        }
        // Convert id to a number
        if(id !== null)
            id = Number(id);
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
                            INNER JOIN index_addresses    a2 ON (a2.id=a1.source_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=i.status_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=i.transfer_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=i.callback_tick_id)
                        WHERE
                            s1.status='valid' AND
                            i.tick_id=?` + sql + `
                        ORDER BY 
                            i.action_index ASC`;
            let results = await this.doQuery(query, args);
            if(results.length > 0){
                // Define data object
                if(!data)
                    data = {};
                // Loop through ISSUE transactions for the given ticker
                for(let row of results){
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
        let query = `SELECT
                        i.decimals
                    FROM
                        issues i,
                        index_statuses s
                    WHERE
                        i.status_id=s.id AND
                        i.tick_id=? AND
                        s.status='valid'`;
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0){
            // Loop through ISSUE transactions for the given ticker
            for(let row of results){
                if(!this.util.isNull(row.decimals) && row.decimals > decimals)
                    decimals = row.decimals;
            }
        }
        // Clamp decimals to valid range [0, 18] to prevent SQL injection via DECIMAL CAST
        decimals = Math.max(0, Math.min(18, parseInt(decimals) || 0));
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
        let sql     = '',
            query   = '',
            args    = [],
            results = null,
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
                    SUM(CAST(m.amount AS DECIMAL(60,` + decimals + `))) as credits 
                FROM 
                    credits m
                    INNER JOIN actions      a ON (a.action_index=m.action_index)
                    INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                WHERE 
                    m.tick_id=?` + sql;
        results = await this.doQuery(query, args);
        if(results.length > 0 && !this.util.isNull(results[0].credits))
            credits = results[0].credits;
        // Get Debits 
        query = `SELECT 
                    SUM(CAST(m.amount AS DECIMAL(60,` + decimals + `))) as debits 
                FROM 
                    debits m
                    INNER JOIN actions      a ON (a.action_index=m.action_index)
                    INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                WHERE 
                    m.tick_id=?` + sql;
        results = await this.doQuery(query, args);
        if(results.length > 0 && !this.util.isNull(results[0].debits))
            debits = results[0].debits;
        // Get Escrows 
        query = `SELECT 
                    SUM(CAST(m.amount AS DECIMAL(60,` + decimals + `))) as escrows 
                FROM 
                    escrows m
                    INNER JOIN actions      a ON (a.action_index=m.action_index)
                    INNER JOIN transactions t ON (t.tx_index=a.tx_index)
                WHERE 
                    m.tick_id=?` + sql;
        results = await this.doQuery(query, args);
        if(results.length > 0 && !this.util.isNull(results[0].escrows))
            escrows = results[0].escrows;
        // Determine total supply ((credits - debits) + escrows)
        supply = this.util.bcadd(this.util.bcsub(credits, debits, decimals), escrows, decimals);
        return supply;
    }

    // Get token supply for a given ticker from tokens table
    async getTokenSupplyToken(tick){
        let supply   = 0;
        let tick_id  = await this.createTicker(tick);
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        let query = `SELECT supply FROM tokens WHERE tick_id=? LIMIT 1`;
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0 && !this.util.isNull(results[0].supply))
            supply = results[0].supply;
        return supply;
    }

    // Get token supply for a given ticker from balances table
    async getTokenSupplyBalance(tick){
        let supply   = 0;
        let tick_id  = await this.createTicker(tick);
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        let query = `SELECT SUM(CAST(amount AS DECIMAL(60, ` + decimals + `))) as supply FROM balances WHERE tick_id=? LIMIT 1`;
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0 && !this.util.isNull(results[0].supply))
            supply = results[0].supply;
        return supply;
    }

    // Get escrowed token supply for a given ticker from escrows table
    async getTokenSupplyEscrow(tick){
        let supply   = 0;
        let tick_id  = await this.createTicker(tick);
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        let query = `SELECT SUM(CAST(amount AS DECIMAL(60, ` + decimals + `))) as supply FROM escrows WHERE tick_id=? LIMIT 1`;
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0 && !this.util.isNull(results[0].supply))
            supply = results[0].supply;
        return supply;
    }


    // Handle getting a list of TICK holders and amounts
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    // TODO: Add support for 'escrowed' tokens (dispensers, orders, bets)
    // TODO(j-dog): Can optimize this function to allow getting list of holders from balances table instead of credits/debits
    async getHolders(tick, block_index, action_index){
        let holders = {};
        let sql     = '',
            query   = '',
            results = null,
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
            sql += " AND a1.block_index <= ?";
            args.push(parseInt(block_index));
        }
        // If a action_index was given, only lookup tokens created before given action_index
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            sql += " AND m.action_index < ?";
            args.push(parseInt(action_index));
        }
        // Get Credits 
        query = `SELECT 
                    SUM(CAST(m.amount AS DECIMAL(60,` + decimals + `))) as credits,
                    a2.address
                FROM 
                    credits m
                    INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                    INNER JOIN index_addresses a2 ON (a2.id=m.address_id)
                WHERE 
                    m.tick_id=?` + sql + `
                GROUP BY a2.address`;
        results = await this.doQuery(query, args);
        if(results.length > 0)
            for(let row of results)
                holders[row.address] = row.credits;
        // Get Debits 
        query = `SELECT 
                    SUM(CAST(m.amount AS DECIMAL(60,` + decimals + `))) as debits,
                    a2.address
                FROM 
                    debits m
                    INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                    INNER JOIN index_addresses a2 ON (a2.id=m.address_id)
                WHERE 
                    m.tick_id=?` + sql + `
                GROUP BY a2.address`;
        results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                let balance = this.util.bcsub(holders[row.address], row.debits, decimals);
                if(this.util.bcgt(balance, 0))
                    holders[row.address] = balance;
                else
                   delete holders[row.address];
            }
        }
        // Sort holders list from biggest to smallest
        holders = Object.fromEntries(Object.entries(holders).sort(([, a], [, b]) => this.util.bcgt(b, a) ? 1 : this.util.bclt(b, a) ? -1 : 0));
        return holders;
    }

    // Determine if an ticker is distributed to users (held by more than owner)
    // @param {tick}            string  Ticker name
    // @param {block_index}     integer Block Index 
    // @param {action_index}    integer action_index of action
    async isDistributed(tick, block_index, action_index, tokenInfo=null){
        let info    = tokenInfo ?? await this.getTokenInfo(tick, block_index, action_index);
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
        let list_type = await this.getListType(action_index);
        if(list_type==type)
            return true;
        return false;
    }

    // Return a list type given a tx_hash
    async getListType(action_index){
        let type  = false;
        if(!this.util.isNull(action_index) && this.util.isNumeric(action_index)){
            let query = "SELECT type FROM lists WHERE action_index=? LIMIT 1";
            let args  = [action_index];
            let results = await this.doQuery(query, args);
            if(results.length > 0)
                type = parseInt(results[0].type);

        }
        return type;
    }

    // Return a list given a tx_hash
    async getList(action_index){
        let type = await this.getListType(action_index);
        let list = [];
        if(type){
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
            let results = await this.doQuery(query, args);
            if(results.length > 0)
                for(let row of results)
                    list.push(row['item']);
        }
        return list;
    }

    // Create record in `lists` table
    async createList(data){
        data                  = this.normalizeDataValues(data);
        let action_index      = data['ACTION_INDEX'];
        let status_id         = await this.createStatus(data['STATUS']);
        let list_type         = data['TYPE'];
        let list_edit         = data['EDIT'];
        let list_action_index = data['LIST_ACTION_INDEX'];
        // Check if record already exists for this token
        let query  = "SELECT action_index FROM lists WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [list_type, list_edit, list_action_index, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Lookup a record in the `index_statuses` table and return record id
    async getStatusId(status){
        let id    = null;
        let query = "SELECT id FROM index_statuses WHERE status=? LIMIT 1";
        let results = await this.doQuery(query, [status]);
        if(results.length > 0)
            id = Number(results[0].id);
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
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_statuses (status) values (?)";
            await this.doQuery(query, [status]);
            id = await this.getStatusId(status);
        }
        return id;
    }

    // Create/Update record in `issues` table
    async createIssue(data){
        data                   = this.normalizeDataValues(data);
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
        let memo_id            = await this.createMemo(data['MEMO']);
        let status_id          = await this.createStatus(data['STATUS']);
        // Check if record already exists for this ISSUE action
        let query = `SELECT action_index FROM issues WHERE action_index=?`;
        let args  = [action_index]
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
                        memo_id=?,
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
                        memo_id,
                        status_id,
                        action_index
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [tick_id, max_supply, max_mint, decimals, description, mint_supply, transfer_id, transfer_supply_id, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint, lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, memo_id, status_id, action_index ];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `tokens` table
    async createToken(data){
        data                   = this.normalizeDataValues(data);
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
            max_supply         = this.util.bcformat(max_supply, decimals);
            max_mint           = this.util.bcformat(max_mint, decimals);
            mint_supply        = this.util.bcformat(mint_supply, decimals);
            mint_address_max   = this.util.bcformat(mint_address_max, decimals);
            // callback_amount    = this.util.bcformat(callback_amount, decimals);
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
        let query  = "SELECT id FROM tokens WHERE tick_id=? LIMIT 1";
        let exists = false;
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0)
            exists = true;
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
            args    = [max_supply, max_mint, decimals, description, lock_max_supply, lock_mint, lock_max_mint,lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, supply, owner_id, action_index, action_index, tick_id];
        }
        results = await this.doQuery(query, args);

    }

    // Create / Update ledger change records (credits / debits / escrows)
    async createLedgerChangeRecord(table, action_index, tick, amount, address){
        // Whitelist valid ledger table names to prevent SQL injection
        const VALID_LEDGER_TABLES = ['credits', 'debits', 'escrows'];
        if(!VALID_LEDGER_TABLES.includes(table))
            throw new Error('Invalid ledger table: ' + table);
        let tick_id    = await this.createTicker(tick);
        let address_id = await this.createAddress(address);
        // Round amount to the tick's actual decimal precision before storing.
        // Without this, fractional amounts (e.g. VM gas fees calculated at 8
        // decimals against a tick issued with fewer) drift between ledger sums
        // (rounded once at SUM time) and per-address balance sums (rounded per
        // row by updateAddressBalance) — triggering the supply SanityError.
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        amount = this.util.bcadd(amount, 0, decimals);
        // Convert any BigNumber amount to a plain string before inserting into the database
        amount = String(amount);
        // Check if record already exists for this token
        let query = `SELECT
                        action_index
                    FROM
                        ` + table + `
                    WHERE
                        action_index=? AND
                        address_id=? AND 
                        tick_id=?`;
        let exists = false;
        let args    = [action_index, address_id, tick_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [amount, action_index, address_id, tick_id];
        results = await this.doQuery(query, args);
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
            let query = "SELECT address FROM index_addresses";
            let results = await this.doQuery(query);
            if(results.length > 0)
                for(let row of results)
                    addrs.push(row.address);
        }
        // Loop through addresses and update balances SERIALLY. During block
        // processing these run on the single shared transaction connection
        // (getConnection() returns this.transactionConnection mid-transaction),
        // which cannot serve concurrent queries — a Promise.all here interleaves
        // each address's read-compute-write and corrupts balances (observed:
        // AIRDROP double-counted token supply, 200 != 100, tripping the supply
        // sanity check and crash-looping the indexer). The N+1->UPSERT win in
        // updateAddressBalance still applies; only the parallelism is unsafe.
        for(const addr of addrs)
            await this.updateAddressBalance(addr, rollback);
    }

    // Create/Update/Delete records in the 'balances' table
    async updateAddressBalance(address, rollback){
        let type        = typeof address;
        let address_id  = null;
        let balance     = 0;
        let old_balance = 0;
        let query       = false;
        let results     = null;
        if(type==='number' && this.util.isNumeric(address))
            address_id = address;
        if(type==='string')
            address_id = await this.createAddress(address);
        // Get list of address balances based on credits/debits tables
        let balances = await this.getAddressBalances(address_id);
        // Get list of address balances based on balances table
        let old_balances = await this.getAddressTableBalances(address_id);
        // Handle updating any current balances based on credits/debits table records
        for(let tick_id in balances){
            balance = balances[tick_id];
            let args = [];
            if(balance==0){
                query = "DELETE FROM balances WHERE address_id=? AND tick_id=?";
                args.push(address_id, tick_id);
            } else {
                // Convert BigNumber to plain string so mariadb driver serializes it correctly
                balance = String(balance);
                query = "INSERT INTO balances (tick_id, address_id, amount) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = VALUES(amount)";
                args.push(tick_id, address_id, balance);
            }
            results = await this.doQuery(query, args);
        }
        // If this is a rollback, then handle detecting records in balances table which should not exist and delete them
        // TODO: Test this code a bit better with various random rollbacks and verify all is working without any sanity check issues
        if(rollback){
            for(let tick_id in old_balances){
                old_balance = old_balances[tick_id];
                balance     = balances[tick_id];
                if(!this.util.isNull(old_balance) && (this.util.isNull(balance) || balance==0 )){
                    query   = "DELETE FROM balances WHERE address_id=? AND tick_id=?";
                    results = await this.doQuery(query, [address_id, tick_id]);
                }
            }
        }
    }

    // Get address balances using credits/debits table data
    async getAddressBalances(address, tick, block_index, action_index){
        let type       = typeof address;
        let address_id = null;
        if(type==='number' && this.util.isNumeric(address))
            address_id = address;
        if(type==='string')
            address_id = await this.createAddress(address);
        let [credits, debits] = await Promise.all([
            this.getAddressCreditDebit('credits', address_id, null, block_index, action_index),
            this.getAddressCreditDebit('debits',  address_id, null, block_index, action_index)
        ]);
        let balances = {}; // Object to store tick_id/balance
        // Build out balances (credits - debits).
        // Compute at full (18-decimal) precision rather than the token's own
        // precision: rounding here per-address causes sum-of-rounded-balances
        // to drift from rounded-sum-of-ledger when a token's decimals are too
        // low to represent the underlying ledger values (e.g. fractional VM
        // gas fees against a tick issued with decimals=0). The sanityCheck's
        // DECIMAL(60, decimals) cast rounds the aggregate sum the same way on
        // both sides, so as long as per-address balances stay exact, both
        // paths agree.
        for(let tick_id in credits){
            let credit  = credits[tick_id];
            let debit   = (!this.util.isNull(debits[tick_id])) ? debits[tick_id] : 0;
            let balance = null;
            try {
                balance = this.util.bcsub(credit, debit, 18);
            } catch(err){
                balance = this.util.bcadd(0, 0, 18);
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
        if(type==='string')
            address_id = await this.createAddress(address);
        let query = "SELECT tick_id, amount FROM balances WHERE address_id=?";
        let results = await this.doQuery(query, [address_id]);
        if(results.length > 0)
            for(let row of results)
                balances[row.tick_id] = row.amount;
        return balances;
    }

    // Handle getting credits or debits records for a given address
    async getAddressCreditDebit(table, address, action, block_index, action_index){
        let data       = [];
        let type       = typeof address;
        let address_id = null;
        if(type==='number' && this.util.isNumeric(address))
            address_id = address;
        if(type==='string')
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
            let query = `SELECT 
                    m.tick_id,
                    m.amount,
                    t2.decimals
                FROM
                    ` + table + ` m
                    INNER JOIN actions       a1 ON (a1.action_index=m.action_index)
                    LEFT  JOIN transactions  t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN tokens        t2 ON (t2.tick_id=m.tick_id)
                    INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                WHERE 
                    m.address_id=?` + sql;
            let results = await this.doQuery(query, args);
            if(results.length > 0){
                for(let row of results){
                    if(!data[row.tick_id])
                        data[row.tick_id] = 0;
                    data[row.tick_id] = this.util.bcadd(data[row.tick_id], row.amount, row.decimals);
                }
            }
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
            let query = "SELECT t2.tick FROM tokens t1, index_tickers t2 WHERE t1.tick_id=t2.id";
            let results = await this.doQuery(query);
            if(results.length > 0)
                for(let row of results)
                    tokens.push(row.tick);
        }
        // Loop through tokens and update basic info
        await Promise.all(tokens.map(t => this.updateTokenInfo(t)));
    }

    // Handle getting token info (supply, price, etc) and updating the `tokens` table
    async updateTokenInfo(tick){
        // createTicker and getTokenInfo are independent; run them concurrently.
        // tick_id is unused here — createToken calls createTicker internally.
        const [, data] = await Promise.all([this.createTicker(tick), this.getTokenInfo(tick)]);
        // Update the record in `tokens` table
        if(data)
            await this.createToken(data);
    }

    // Mark a token's ownership as held in escrow by an ORDER/SWAP/DISPENSER action.
    // While set, owner-only actions targeting this tick are rejected; on cancel/expire/match
    // the corresponding action handler calls clearTokenEscrow() to release.
    async setTokenEscrow(tick, action_index){
        let tick_id = await this.createTicker(tick);
        let query   = "UPDATE tokens SET escrow_action_index=? WHERE tick_id=?";
        await this.doQuery(query, [action_index, tick_id]);
    }

    // Release a token's ownership escrow.
    async clearTokenEscrow(tick){
        let tick_id = await this.createTicker(tick);
        let query   = "UPDATE tokens SET escrow_action_index=NULL WHERE tick_id=?";
        await this.doQuery(query, [tick_id]);
    }

    // Returns the action_index of the offer holding this tick's ownership in escrow, or null
    // if ownership is not currently escrowed. Used by ISSUE v1-5 / CALLBACK / SLEEP / LINK /
    // FILE / child-ISSUE handlers to reject owner-only actions during escrow.
    async getTokenEscrow(tick){
        if(this.util.isNull(tick))
            return null;
        let tick_id = await this.createTicker(tick);
        let query   = "SELECT escrow_action_index FROM tokens WHERE tick_id=? LIMIT 1";
        let results = await this.doQuery(query, [tick_id]);
        if(results.length === 0 || this.util.isNull(results[0].escrow_action_index))
            return null;
        return results[0].escrow_action_index;
    }

    // Convenience wrapper — true if this tick's ownership is currently escrowed.
    async isOwnershipEscrowed(tick){
        return (await this.getTokenEscrow(tick)) !== null;
    }

    // Return the tick associated with an ISSUE action_index, or null if the
    // action_index does not resolve to a valid ISSUE. Used by LINK to decide
    // whether a linked action is targeting a TICK (and thus subject to the
    // owner / ownership-escrow rules).
    async getIssueTick(action_index){
        let query = `SELECT
                        t.tick
                    FROM
                        issues i
                        INNER JOIN index_tickers t ON (t.id=i.tick_id)
                        INNER JOIN index_statuses s ON (s.id=i.status_id)
                    WHERE
                        i.action_index=? AND
                        s.status='valid'
                    LIMIT 1`;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0)
            return results[0].tick;
        return null;
    }

    // Get action_index of the first valid ISSUE action for a given ticker
    async getFirstIssueActionIndex(tick){
        let tick_id      = await this.createTicker(tick);
        let action_index = false;
        let query = `SELECT 
                        i.action_index 
                    FROM
                        issues i
                        INNER JOIN index_statuses s ON (s.id=i.status_id)
                    WHERE 
                        i.tick_id=? AND 
                        s.status='valid'
                    ORDER BY 
                        action_index ASC 
                    LIMIT 1`;
        let args = [tick_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            action_index = Number(results[0].action_index);
        return action_index;
    }

    // Validate if a ticker exists before before a given action_index
    async validTickerBeforeTxIndex(tick, action_index){
        let issue_index = await this.getFirstIssueActionIndex(tick);
        if(issue_index !== false && issue_index < action_index)
            return true;
        return false;
    }

    // Validate if ADDRESS is in SLEEP mode
    async isAddressSleeping(address, block_index){
        let sleep = false;
        if(!this.util.isNull(address) && this.util.isCryptoAddress(address) && !this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            let id    = await this.createAddress(address);
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
            let results = await this.doQuery(query, args);
            if(results.length > 0){
                let resume_block = Number(results[0].resume_block);
                if(resume_block ==  -1 || resume_block > block_index)
                    sleep = true;
            }
        }
        return sleep;
    }

    // Validate if TICK is in SLEEP mode
    async isTickSleeping(tick, block_index){
        let sleep = false;
        if(!this.util.isNull(tick) && !this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            let id    = await this.createTicker(tick);
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
            let results = await this.doQuery(query, args);
            if(results.length > 0){
                let resume_block = Number(results[0].resume_block);
                if(resume_block ==  -1 || resume_block > block_index)
                    sleep = true;
            }
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
            // Validate TICK and ADDRESS sleep status in parallel
            const [tickSleeping, addressSleeping] = await Promise.all([
                (!this.util.isNull(tick))     ? this.isTickSleeping(tick, block_index)       : Promise.resolve(false),
                (!this.util.isNull(address))  ? this.isAddressSleeping(address, block_index) : Promise.resolve(false)
            ]);
            if(tickSleeping || addressSleeping)
                allow = false;
        }
        // Validate address against any tick allow/block lists
        if(allow && !this.util.isNull(address) && !this.util.isNull(tick)){
            let info = await this.getTokenInfo(tick, block_index);
            // Fetch allow/block lists in parallel if both exist
            const hasAllowList = info && !this.util.isNull(info['ALLOW_LIST']) && this.util.isNumeric(info['ALLOW_LIST']);
            const hasBlockList = info && !this.util.isNull(info['BLOCK_LIST']) && this.util.isNumeric(info['BLOCK_LIST']);
            const [allowList, blockList] = await Promise.all([
                hasAllowList ? this.getList(info['ALLOW_LIST']) : Promise.resolve(null),
                hasBlockList ? this.getList(info['BLOCK_LIST']) : Promise.resolve(null)
            ]);
            // False if we have an ALLOW_LIST and address is NOT on it
            if(allow && allowList && !allowList.includes(address))
                allow = false;
            // False if we have a BLOCK_LIST and address IS on it
            if(allow && blockList && blockList.includes(address))
                allow = false;
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
        let query = "SELECT id FROM index_memos WHERE memo=? LIMIT 1";
        let results = await this.doQuery(query, [memo]);
        if(results.length > 0)
            id = Number(results[0].id);
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
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_memos (memo) values (?)";
            await this.doQuery(query, [memo]);
            id = await this.getMemoId(memo);
        }
        return id;
    }

    // Create/Update record in `mints` table
    async createMint(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        // Check if record already exists for this mint
        let exists  = false;
        let query   = "SELECT action_index FROM mints WHERE action_index=? LIMIT 1";
        let args    = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args = [tick_id, amount, destination_id, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
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
        let query  = "SELECT item_id FROM list_edits WHERE action_index=? AND item_id=? AND status_id=? LIMIT 1";
        let args   = [action_index, item_id, status_id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // INSERT record
        if(!exists){
            query = "INSERT INTO list_edits (action_index, item_id, status_id) values (?, ?, ?)";
            results = await this.doQuery(query, args);
        }
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
        let query  = "SELECT item_id FROM list_items WHERE action_index=? AND item_id=? LIMIT 1";
        let args   = [action_index, item_id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // INSERT record
        if(!exists){
            query = "INSERT INTO list_items (action_index, item_id) values (?, ?)";
            results = await this.doQuery(query, args);
        }
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
        let query  = "SELECT item_id FROM list_items_invalid WHERE action_index=? AND item_id=? AND status_id=? LIMIT 1";
        let args   = [action_index, item_id, status_id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // INSERT record
        if(!exists){
            query = "INSERT INTO list_items_invalid (action_index, item_id, status_id) values (?, ?, ?)";
            results = await this.doQuery(query, args);
        }
    }


    // Validate that token supplys match credits/debits/balances information
    async sanityCheck(block_index){
        // Ignore any calls without a block index
        if(this.util.isNull(block_index))
            return;
        let tickers  = {};
        let decimals = {};
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
        let results = await this.doQuery(query, [block_index, block_index, block_index]);
        if(results.length >0){
            for(let row of results){
                // Add ticker, decimal, and supply info to assoc arrays
                tickers[row.tick]  = Number(row.tick_id);
                decimals[row.tick] = row.decimals;
            };
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
            if(String(token)!=String(ledger) || String(token)!=String(total)){
                console.log("Tick,   tick_id =", tick, tick_id);
                console.log("token   supply =", token);
                console.log("ledger  supply =", ledger);  // Credits / Debits / Escrows
                console.log("balance supply =", balance); // balances table
                console.log("escrow  supply =", escrow);  // Escrows
                console.log("total   supply =", total);   // balance + escrow
            }
            if(String(token)!=String(ledger))
                this.util.throwError("SanityError: ledger supply does not match token supply : " + tick + " (" + ledger + " != " + token + ")");
            if(String(token)!=String(total))
                this.util.throwError("SanityError: total supply does not match token supply : " + tick + " (" + total + " != " + token + ")");
        }
    }

    // Create record in `addresses` table
    async createAddressOption(data){
        data                     = this.normalizeDataValues(data);
        let status_id            = await this.createStatus(data['STATUS']);
        let memo_id              = await this.createMemo(data['MEMO']);
        let action_index         = data['ACTION_INDEX'];
        let fee_preference       = data['FEE_PREFERENCE'];
        let require_memo         = data['REQUIRE_MEMO'];
        let dispenser_preference = data['DISPENSER_PREFERENCE'];
        // Check if record already exists for this address
        let query  = "SELECT action_index FROM addresses WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE
                        addresses
                    SET
                        fee_preference=?,
                        require_memo=?,
                        dispenser_preference=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            query = "INSERT INTO addresses (fee_preference, require_memo, dispenser_preference, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)";
        }
        args    = [fee_preference, require_memo, dispenser_preference, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create record in `batches` table
    async createBatch(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        // Check if record already exists for this address
        let query = "SELECT action_index FROM batches WHERE action_index=? LIMIT 1";
        let args  = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `sends` table
    async createSend(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        // Check if record already exists for this send
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
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        results = await this.doQuery(query, args);
    }

    // Get address preferences for a given address
    async getAddressPreferences(address, block_index, action_index){
        let id   = await this.createAddress(address);
        // Set default address preferences
        let data = {};
        data['FEE_PREFERENCE']       = 2; // 2=Donate FEES to development
        data['REQUIRE_MEMO']         = 0; // 0=Do NOT Require memo on SENDs to this address
        data['DISPENSER_PREFERENCE'] = 1; // 1=Only owner can open dispenser on this address
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
        let query = `SELECT
                a1.fee_preference,
                a1.require_memo,
                a1.dispenser_preference
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
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                data['FEE_PREFERENCE'] = Number(row.fee_preference);
                data['REQUIRE_MEMO']   = Number(row.require_memo);
                if(!this.util.isNull(row.dispenser_preference))
                    data['DISPENSER_PREFERENCE'] = Number(row.dispenser_preference);
            }
        }
        return data;
    }

    // Get escrowed tokens for a given address
    async getAddressEscrows(address, block_index, action_index){
        let id      = await this.createAddress(address);
        let escrows = [];
        let args    = [id];
        // Get list of orders with escrowed tokens
        let query = `SELECT 
                        o1.action_index
                    FROM
                        orders                    o1
                        INNER JOIN order_statuses s1 ON (s1.order_action_index=o1.action_index)
                        INNER JOIN actions        a1 ON (a1.action_index=o1.action_index)        
                        INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                    WHERE 
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                order_statuses s3
                            WHERE
                                s3.order_action_index=o1.action_index
                        ) AND
                        a1.source_id=? AND
                        s2.status='open'
                    ORDER BY 
                        a1.action_index ASC`;
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results)
                escrows.push({
                    type: 'order',
                    action_index: Number(row.action_index)
                });
        }
        // Get list of swaps with escrowed tokens
        query = `SELECT 
                    s1.action_index
                FROM
                    swaps                     s1
                    INNER JOIN swap_statuses  s2 ON (s2.swap_action_index=s1.action_index)
                    INNER JOIN actions        a1 ON (a1.action_index=s1.action_index)        
                    INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN index_statuses s3 ON (s3.id=s2.status_id)
                WHERE 
                    s2.action_index = (
                        SELECT
                            MAX(s4.action_index)
                        FROM
                            swap_statuses s4
                        WHERE
                            s4.swap_action_index=s1.action_index
                    ) AND
                    a1.source_id=? AND
                    s3.status='open'
                ORDER BY 
                    a1.action_index ASC`;
        results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results)
                escrows.push({
                    type: 'swap',
                    action_index: Number(row.action_index)
                });

        } 
        // Get list of dispensers with escrowed tokens
        query = `SELECT 
                    d1.action_index
                FROM
                    dispensers                    d1
                    INNER JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=d1.action_index)
                    INNER JOIN actions            a1 ON (a1.action_index=d1.action_index)        
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                WHERE 
                    s1.action_index = (
                        SELECT
                            MAX(s3.action_index)
                        FROM
                            dispenser_statuses s3
                        WHERE
                            s3.dispenser_action_index=d1.action_index
                    ) AND
                    a1.source_id=? AND
                    s2.status='open'
                ORDER BY 
                    a1.action_index ASC`;
        results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results)
                escrows.push({
                    type: 'dispenser',
                    action_index: Number(row.action_index)
                });

        } 
        return escrows;
    }

    // Create/Update record in `airdrops` table
    async createAirdrop(data){
        data                  = this.normalizeDataValues(data);
        let tick_id           = await this.createTicker(data['TICK']);
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let amount            = data['AMOUNT'];
        let list_action_index = (!this.util.isNumeric(data['LIST_ACTION_INDEX'])) ? null : data['LIST_ACTION_INDEX'];
        // Check if record already exists for this airdrop
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
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // Define list of arguments for sql insert/update
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
        args    = [tick_id, list_action_index, amount, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `fees` table
    async createFeeRecord(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        let method         = data['METHOD'];
        // Unified gas fields (default to legacy values if not present)
        let gas_cost           = data['GAS_COST'] || 0;
        let gas_price          = data['GAS_PRICE'] || '0';
        let xchain_amount      = data['XCHAIN_AMOUNT'] || amount || '0';
        let payment_mode       = data['PAYMENT_MODE'] || 2;
        let fee_preference     = data['FEE_PREFERENCE'] || method || 2;
        let fee_version        = data['FEE_VERSION'] || 1;
        // Native coin fields (Track B — null for XCHAIN balance payments)
        let native_coin_amount = data['NATIVE_COIN_AMOUNT'] || null;
        let native_coin        = data['NATIVE_COIN'] || null;
        let oracle_round       = data['ORACLE_ROUND'] || null;
        // Check if record already exists
        let query = `SELECT action_index FROM fees WHERE action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE fees SET
                        tick_id=?, destination_id=?, amount=?, method=?,
                        gas_cost=?, gas_price=?, xchain_amount=?,
                        payment_mode=?, fee_preference=?, fee_version=?,
                        native_coin_amount=?, native_coin=?, oracle_round=?
                    WHERE action_index=?`;
            args = [tick_id, destination_id, amount, method,
                    gas_cost, gas_price, xchain_amount,
                    payment_mode, fee_preference, fee_version,
                    native_coin_amount, native_coin, oracle_round, action_index];
        } else {
            query = `INSERT INTO fees
                        (tick_id, destination_id, amount, method,
                         gas_cost, gas_price, xchain_amount,
                         payment_mode, fee_preference, fee_version,
                         native_coin_amount, native_coin, oracle_round, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [tick_id, destination_id, amount, method,
                    gas_cost, gas_price, xchain_amount,
                    payment_mode, fee_preference, fee_version,
                    native_coin_amount, native_coin, oracle_round, action_index];
        }
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `destroys` table
    async createDestroy(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        // Check if record already exists for this destroy
        let query  = `SELECT
                            action_index
                        FROM
                            destroys
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [tick_id, amount, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Get tokens owned by a given address
    async getAddressOwnerships(address){
        let id   = await this.createAddress(address);
        let data = [];
        // Lookup the address preferences
        let query = `SELECT 
                        t2.tick
                    FROM
                        tokens t1
                        INNER JOIN index_tickers t2 ON (t2.id=t1.tick_id)
                    WHERE 
                        t1.owner_id=? 
                    ORDER BY 
                        t2.tick`;
        let results = await this.doQuery(query, [id]);
        if(results.length > 0)
            for(let row of results)
                data.push(row.tick);
        return data;
    }

    // Create/Update record in `sweeps` table
    async createSweep(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let balances       = data['BALANCES'];
        let ownerships     = data['OWNERSHIPS'];
        let orders         = data['ORDERS'];
        let swaps          = data['SWAPS'];
        let dispensers     = data['DISPENSERS'];
        // Check if record already exists for this sweep
        let query = `SELECT
                        action_index
                    FROM
                        sweeps
                    WHERE
                        action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        sweeps
                    SET
                        destination_id=?,
                        balances=?,
                        ownerships=?,
                        orders=?,
                        swaps=?,
                        dispensers=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO sweeps (destination_id, balances, ownerships, orders, swaps, dispensers, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [destination_id, balances, ownerships, orders, swaps, dispensers, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `dividends` table
    async createDividend(data){
        data                 = this.normalizeDataValues(data);
        let tick_id          = await this.createTicker(data['TICK']);
        let dividend_tick_id = await this.createTicker(data['DIVIDEND_TICK']);
        let memo_id          = await this.createMemo(data['MEMO']);
        let status_id        = await this.createStatus(data['STATUS']);
        let action_index     = data['ACTION_INDEX'];
        let amount           = data['AMOUNT'];
        // Check if record already exists for this dividend
        let query  = `SELECT
                            action_index
                        FROM
                            dividends
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [tick_id, dividend_tick_id, amount, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `callbacks` table
    async createCallback(data){
        data                 = this.normalizeDataValues(data);
        let tick_id          = await this.createTicker(data['TICK']);
        let callback_tick_id = await this.createTicker(data['CALLBACK_TICK']);
        let memo_id          = await this.createMemo(data['MEMO']);
        let status_id        = await this.createStatus(data['STATUS']);
        let action_index     = data['ACTION_INDEX'];
        let callback_amount  = data['CALLBACK_AMOUNT'];
        // Check if record already exists for this callback
        let query = `SELECT
                        action_index
                    FROM
                        callbacks
                    WHERE
                        action_index=?`; 
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [tick_id, callback_tick_id, callback_amount, memo_id, status_id,  action_index];
        results = await this.doQuery(query, args);
    }

    // Lookup a record in the `index_mime_types` table and return record id
    async getMimeTypeId(type){
        let id    = null;
        let query = "SELECT id FROM index_mime_types WHERE `type`=? LIMIT 1";
        let args  = [type];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            id = Number(results[0].id);
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
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_mime_types (`type`) values (?)";
            let args  = [type];
            await this.doQuery(query, args);
            id = await this.getMimeTypeId(type);
        }
        return id;
    }

    // Create/Update record in `files` table
    async createFile(data){
        data             = this.normalizeDataValues(data);
        let type_id      = await this.createMimeType(data['TYPE']);
        let memo_id      = await this.createMemo(data['MEMO']);
        let status_id    = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        let name         = data['NAME'];
        let title        = data['TITLE'];
        // Check if record already exists for this file
        let query  = `SELECT
                            action_index
                        FROM
                            files
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [name, title, type_id, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `gated_files` table.
    // Called by the FILE handler when GATE_TICKER is non-empty.
    // Mirrors the ciphertext bytes (data['RAW_DATA']) so the explorer can
    // serve them via /api/file/{action_index}/raw without reaching across
    // databases. See xchain-documentation/protocol/TOKEN_GATED_CONTENT.md.
    async createGatedFile(data){
        data              = this.normalizeDataValues(data);
        let action_index  = data['ACTION_INDEX'];
        let gate_ticker   = data['GATE_TICKER'];
        let enc_method    = Number(data['ENCRYPTION_METHOD']) || 1;
        let key_hash      = String(data['KEY_HASH'] || '').toLowerCase();
        let status_id     = await this.createStatus(data['STATUS']);
        let raw_data      = data['RAW_DATA'] || null;

        let exists = false;
        let q = `SELECT action_index FROM gated_files WHERE action_index=?`;
        let r = await this.doQuery(q, [action_index]);
        if(r.length > 0) exists = true;

        let query;
        let args;
        if(exists){
            query = `UPDATE gated_files SET gate_ticker=?, encryption_method=?, key_hash=?, status_id=?, raw_data=? WHERE action_index=?`;
            args  = [gate_ticker, enc_method, key_hash, status_id, raw_data, action_index];
        } else {
            query = `INSERT INTO gated_files (action_index, gate_ticker, encryption_method, key_hash, status_id, raw_data) values (?, ?, ?, ?, ?, ?)`;
            args  = [action_index, gate_ticker, enc_method, key_hash, status_id, raw_data];
        }
        await this.doQuery(query, args);
    }

    // Fetch the raw ciphertext bytes for a gated FILE by ACTION_INDEX.
    // Returns null when no such gated file exists. Used by the explorer's
    // /api/file/{action_index}/raw endpoint.
    async getGatedFileRaw(action_index){
        let q = `SELECT raw_data FROM gated_files WHERE action_index=? LIMIT 1`;
        let r = await this.doQuery(q, [action_index]);
        if(r.length === 0) return null;
        return r[0].raw_data;
    }

    // Return the set of distinct KEY_HASH values across all currently-active
    // gated FILE v1 actions for a given token. Used by the SEND processor
    // to determine whether a transfer requires a paired MESSAGE handoff.
    // A pack of N files contributes one entry. Returns [] if the token has
    // no gated content.
    async getActiveGatedKeyHashes(tick){
        // Active = status maps to 'valid' (the canonical accepted status id).
        let q = `SELECT DISTINCT gf.key_hash
                 FROM gated_files gf
                 INNER JOIN index_statuses s ON s.id = gf.status_id
                 WHERE gf.gate_ticker = ?
                   AND s.status = 'valid'`;
        let r = await this.doQuery(q, [tick]);
        return r.map((row) => String(row.key_hash).toLowerCase());
    }

    // Lookup a record in the `index_coins` table and return record id
    async getCoinId(coin){
        let id    = null;
        let query = "SELECT id FROM index_coins WHERE `coin`=? LIMIT 1";
        let args  = [coin];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            id = Number(results[0].id);
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
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_coins (`coin`) values (?)";
            let args  = [coin];
            await this.doQuery(query, args);
            id = await this.getCoinId(coin);
        }
        return id;
    }

    // Lookup a record in the `index_fiats` table and return record id
    async getFiatId(code){
        let id    = null;
        let query = "SELECT id FROM index_fiats WHERE `code`=? LIMIT 1";
        let args  = [code];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    }

    // Create records in the 'index_fiats' table and return record id
    async createFiat(code){
        // Ignore empty fiat and return NULL
        if(this.util.isNull(code))
            return null;
        var id = await this.getFiatId(code);
        // Handle creating record
        if(id==null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query = "INSERT IGNORE INTO index_fiats (`code`) values (?)";
            let args  = [code];
            await this.doQuery(query, args);
            id = await this.getFiatId(code);
        }
        return id;
    }    


    // Lookup table associated with an action
    async getActionIndexTable(action_index){
        let table  = null;
        let query  = `SELECT 
                        LCASE(a2.action) as action
                    FROM 
                        actions a1
                        INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                    WHERE
                        a1.action_index=?
                    LIMIT 1`;
        let args   = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            let action = results[0].action;
            if(['address','batch','dispense'].includes(action)){
                table = action + 'es';
            } else {
                table = action + 's';
            }
        }
        return table;
    }

    // Verify that a given action_index is associated with a `valid` transaction
    async isActionIndexValid(action_index){
        let valid = false;
        let table = await this.getActionIndexTable(action_index);
        if(!this.util.isNull(table)){
            let query = `SELECT 
                            m.action_index
                        FROM 
                            ` + table + ` m
                            LEFT JOIN index_statuses s ON (s.id=m.status_id)
                        WHERE
                            m.action_index=? AND
                            s.status='valid'`;
            let args = [action_index];
            let results = await this.doQuery(query, args);
            if(results.length > 0)
                valid = true;
        }
        return valid;
    }

    // Create/Update record in `links` table
    async createLink(data){
        data                   = this.normalizeDataValues(data);
        let coin1_id           = await this.createCoin(data['COIN1']);
        let coin2_id           = await this.createCoin(data['COIN2']);
        let memo_id            = await this.createMemo(data['MEMO']);
        let status_id          = await this.createStatus(data['STATUS']);
        let action_index       = data['ACTION_INDEX'];
        let coin1_action_index = data['COIN1_ACTION_INDEX'];
        let coin2_action_index = data['COIN2_ACTION_INDEX'];
        // Check if record already exists for this link
        let query  = `SELECT
                            action_index
                        FROM
                            links
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [coin1_id, coin1_action_index, coin2_id, coin2_action_index, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `broadcasts` table
    async createBroadcast(data){
        data                       = this.normalizeDataValues(data);
        let memo_id                = await this.createMemo(data['MEMO']);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let broadcast_action_index = data['BROADCAST_ACTION_INDEX'];
        let message                = data['MESSAGE'];
        let value                  = data['VALUE'];
        let fee                    = data['FEE'];
        // Check if record already exists for this broadcast
        let query  = `SELECT
                            action_index
                        FROM
                            broadcasts
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [message, value, fee, broadcast_action_index, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `messages` table
    async createMessage(data){
        data                  = this.normalizeDataValues(data);
        let destination_id    = await this.createAddress(data['DESTINATION']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let coin              = data['COIN'];
        let encryption_method = data['ENCRYPTION_METHOD'];
        let encryption_key    = data['ENCRYPTION_KEY'];
        let encrypted_message = data['ENCRYPTED_MESSAGE'];
        let plaintext_message = data['PLAINTEXT_MESSAGE'];
        // Check if record already exists for this message
        let query  = `SELECT
                            action_index
                        FROM
                            messages
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        messages
                    SET
                        coin=?,
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
            query = `INSERT INTO messages (coin, encryption_method, encryption_key, encrypted_message, plaintext_message, destination_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [coin, encryption_method, encryption_key, encrypted_message, plaintext_message, destination_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }        

    // Create/Update record in `sleeps` table
    async createSleep(data){
        // Capture the sleep TYPE *before* normalizeDataValues runs: TYPE is a
        // NUMBER_FIELD, so the non-numeric string 'TICK'/'ADDRESS' gets nulled
        // there. Reading it after normalize made (data['TYPE']=='TICK') always
        // false, so every TICK sleep (SLEEP v1) was stored as an ADDRESS sleep
        // (type=1) — wrongly sleeping the token owner's whole address and never
        // pausing the tick (isTickSleeping looks for type=2).
        let type         = (data['TYPE']=='TICK') ? 2 : 1;
        data             = this.normalizeDataValues(data);
        let tick_id      = await this.createTicker(data['TICK']);
        let memo_id      = await this.createMemo(data['MEMO']);
        let status_id    = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        let resume_block = data['RESUME_BLOCK'];
        // Check if record already exists for this sleep
        let query  = `SELECT
                            action_index
                        FROM
                            sleeps
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [type, tick_id, resume_block, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `swaps` table
    async createSwap(data){
        data               = this.normalizeDataValues(data);
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
        let give_ownership = (data['GIVE_OWNERSHIP']==1) ? 1 : 0;
        let get_ownership  = (data['GET_OWNERSHIP']==1)  ? 1 : 0;
        let expiration     = data['EXPIRATION'];
        let allow_list     = data['ALLOW_LIST'];
        let block_list     = data['BLOCK_LIST'];
        // Check if record already exists for this swap
        let query  = `SELECT
                            action_index
                        FROM
                            swaps
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swaps
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        give_ownership=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_ownership=?,
                        get_address_id=?,
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
            args = [give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO swaps (give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index];
        }
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `swap_statuses` table
    // @param {action_index}     integer Action index of action
    // @param {swap_action_tick} integer Action index of swap
    // @param {status}           string  Status of the referenced swap (open/complete/cancelled/expired)
    async createSwapStatus(action_index, swap_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in swap_statuses table
        let query  = `SELECT
                            action_index
                        FROM
                            swap_statuses
                        WHERE
                            action_index=? AND
                            swap_action_index=?`;
        let args = [action_index, swap_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [status_id, action_index, swap_action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `swap_cancels` table
    async createSwapCancel(data){
        data                  = this.normalizeDataValues(data);
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let swap_action_index = data['SWAP_ACTION_INDEX'];
        // Check if record already exists for this swap_cancel
        let query  = `SELECT
                            action_index
                        FROM
                            swap_cancels
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [memo_id, status_id, swap_action_index, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `swap_statuses` table
    // @param {action_index}     integer Action index of action
    // @param {swap_action_tick} integer Action index of swap
    // @param {status}           string  Status of the expire (valid/invalid)
    async createSwapExpire(action_index, swap_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in swap_expires table
        let query  = `SELECT
                            action_index
                        FROM
                            swap_expires
                        WHERE
                            action_index=? AND
                            swap_action_index=?`;
        let args = [action_index, swap_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swap_expires
                    SET
                        status_id=?
                    WHERE 
                        action_index=? AND
                        swap_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO swap_expires (status_id, action_index, swap_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, swap_action_index];
        results = await this.doQuery(query, args);
    }

    // Return swap info for given action_index
    async getSwapInfo(coin, action_index){
        let swap = false;
        let query = `SELECT
                        s1.action_index,
                        t2.tick as give_tick,
                        s1.give_amount,
                        s1.give_ownership,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        s1.get_amount,
                        s1.get_ownership,
                        a2.address as source,
                        a3.address as get_address,
                        s1.expiration,
                        s1.allow_list,
                        s1.block_list,
                        m1.memo,
                        s3.status,
                        s4.status as swap_status,
                        b1.block_index,
                        b1.block_time
                    FROM
                        swaps s1
                        INNER JOIN actions         a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                        INNER JOIN index_addresses a3 ON (a3.id=s1.get_address_id)
                        INNER JOIN index_tickers   t2 ON (t2.id=s1.give_tick_id)
                        INNER JOIN index_tickers   t3 ON (t3.id=s1.get_tick_id)
                        INNER JOIN index_coins     c1 ON (c1.id=s1.get_coin_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=s1.memo_id)
                        INNER JOIN swap_statuses   s2 ON (s2.swap_action_index=s1.action_index)
                        INNER JOIN index_statuses  s3 ON (s3.id=s1.status_id)
                        INNER JOIN index_statuses  s4 ON (s4.id=s2.status_id)
                    WHERE 
                        s2.action_index = (
                            SELECT
                                MAX(s5.action_index)
                            FROM
                                swap_statuses s5
                            WHERE
                                s5.swap_action_index=s1.action_index
                        ) AND
                        c1.coin=? AND
                        s1.action_index=? 
                    LIMIT 1`;
        let args  = [coin, action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            swap = {};
            swap['GIVE_COIN'] = this.config['COIN'];
            for(let key in results[0]){
                let name  = String(key).toUpperCase()
                let value = results[0][key];
                if(['ACTION_INDEX', 'BLOCK_INDEX', 'BLOCK_TIME', 'EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST', 'GIVE_OWNERSHIP', 'GET_OWNERSHIP'].includes(name))
                    value = Number(value);
                swap[name] = value;
            }
            // Ownership swaps expose virtual '1' for the ownership side's GIVE_AMOUNT /
            // GET_AMOUNT so the matching engine can compare amounts uniformly. Settlement
            // code branches on GIVE_OWNERSHIP / GET_OWNERSHIP flags rather than the
            // synthetic amount.
            if(swap['GIVE_OWNERSHIP'] == 1 && this.util.isNull(swap['GIVE_AMOUNT']))
                swap['GIVE_AMOUNT'] = '1';
            if(swap['GET_OWNERSHIP']  == 1 && this.util.isNull(swap['GET_AMOUNT']))
                swap['GET_AMOUNT']  = '1';
            // Get updated swap properties from the swap_edits table
            let edit = await this.getSwapEdits(action_index);
            if(edit.expiration)
                swap['EXPIRATION'] = edit.expiration;
            if(edit.allow_list)
                swap['ALLOW_LIST'] = edit.allow_list;
            if(edit.block_list)
                swap['BLOCK_LIST'] = edit.block_list;
        }
        return swap;
    }

    // Return swap edit information for given action_index
    async getSwapEdits(action_index){
        // Define empty edit object
        let edit  = {
            expiration: false,
            allow_list: false,
            block_list: false
        };
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
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration)) edit.expiration = Number(row.expiration);
                if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list)) edit.allow_list = Number(row.allow_list);
                if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list)) edit.block_list = Number(row.block_list);
            }
        }
        return edit;
    }

    // Create/Update record in `swap_edits` table
    async createSwapEdit(data){
        data = this.normalizeDataValues(data);
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
        let query  = `SELECT
                            action_index
                        FROM
                            swap_edits
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [expiration, allow_list, block_list, memo_id, status_id, swap_action_index, action_index];
        results = await this.doQuery(query, args);
    }

    // Handle looking up potential swap matches
    async findSwapMatches(data){
        let matches = false;
        // Normalize data
        let source_id    = await this.createAddress(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        // Lookup any matching swaps from different addresses (not SOURCE)
        let query = `SELECT
                        c1.coin,
                        s2.action_index
                    FROM
                        swaps s1,
                        swaps s2
                        INNER JOIN index_coins    c1 ON (c1.id=s2.get_coin_id)
                        INNER JOIN actions        a1 ON (a1.action_index=s2.action_index)
                        INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN swap_statuses  s3 ON (s3.swap_action_index=s2.action_index)
                        INNER JOIN index_statuses s4 ON (s4.id=s3.status_id)
                    WHERE
                        s3.action_index = (
                            SELECT
                                MAX(s4.action_index)
                            FROM
                                swap_statuses s4
                            WHERE
                                s4.swap_action_index=s2.action_index
                        ) AND
                        s1.give_coin_id=s2.get_coin_id AND
                        s1.give_tick_id=s2.get_tick_id AND
                        s1.give_amount=s2.get_amount AND
                        s1.get_amount=s2.give_amount AND
                        s1.action_index=? AND
                        a1.source_id!=? AND
                        s4.status='open'
                    ORDER BY
                        s2.action_index ASC`;
        let args = [action_index, source_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            // Loop through possible matches and get full information on the swap match
            for(let row of results){
                let swapInfo = await this.getSwapInfo(row.coin, row.action_index);
                if(!matches)
                    matches = [];
                matches.push(swapInfo);
            }
        }
        return matches;
    }

    // Create/Update record in `swap_matches` table
    async createSwapMatch(data, swap, match){
        data                  = this.normalizeDataValues(data);
        let give_coin_id      = await this.createCoin(match['GIVE_COIN']);
        let get_coin_id       = await this.createCoin(match['GET_COIN']);
        let give_tick_id      = await this.createTicker(match['GIVE_TICK']);
        let get_tick_id       = await this.createTicker(match['GET_TICK']);
        let status_id         = await this.createStatus(data['STATUS']);
        let give_amount       = match['GIVE_AMOUNT']
        let get_amount        = match['GET_AMOUNT']
        let action_index      = data['ACTION_INDEX'];
        let give_action_index = match['ACTION_INDEX']
        let get_action_index  = swap['ACTION_INDEX'];
        // Check if record already exists for this swap_matches
        let query  = `SELECT
                            action_index
                        FROM
                            swap_matches
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swap_matches
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        give_action_index=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_action_index=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO swap_matches (give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, status_id, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `orders` table
    async createOrder(data){
        data               = this.normalizeDataValues(data);
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
        let give_ownership = (data['GIVE_OWNERSHIP']==1) ? 1 : 0;
        let get_ownership  = (data['GET_OWNERSHIP']==1)  ? 1 : 0;
        let expiration     = data['EXPIRATION'];
        let allow_list     = data['ALLOW_LIST'];
        let block_list     = data['BLOCK_LIST'];
        // Check if record already exists for this order
        let query  = `SELECT
                            action_index
                        FROM
                            orders
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        orders
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        give_ownership=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_ownership=?,
                        get_address_id=?,
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
            args = [give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO orders (give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [give_coin_id, give_tick_id, give_amount, give_ownership, get_coin_id, get_tick_id, get_amount, get_ownership, get_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index];
        }
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `order_statuses` table
    // @param {action_index}      integer Action index of action
    // @param {order_action_tick} integer Action index of order
    // @param {status}            string  Status of the referenced order (open/complete/cancelled/expired)
    async createOrderStatus(action_index, order_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in order_statuses table
        let query  = `SELECT
                            action_index
                        FROM
                            order_statuses
                        WHERE
                            action_index=? AND
                            order_action_index=?`;
        let args = [action_index, order_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [status_id, action_index, order_action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `order_expires` table
    // @param {action_index}      integer Action index of action
    // @param {order_action_tick} integer Action index of order
    // @param {status}            string  Status of the expire (valid/invalid)
    async createOrderExpire(action_index, order_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in order_expires table
        let query  = `SELECT
                            action_index
                        FROM
                            order_expires
                        WHERE
                            action_index=? AND
                            order_action_index=?`;
        let args = [action_index, order_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        order_expires
                    SET
                        status_id=?
                    WHERE 
                        action_index=? AND
                        order_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_expires (status_id, action_index, order_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, order_action_index];
        results = await this.doQuery(query, args);
    }


    // Handle looking up potential order matches
    async findOrderMatches(data){
        let matches = false;
        // Normalize data
        let source_id    = await this.createAddress(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        // Lookup any matching orders from different addresses (not SOURCE)
        let query = `SELECT
                        c1.coin,
                        o2.action_index
                    FROM
                        orders o1,
                        orders o2
                        INNER JOIN index_coins    c1 ON (c1.id=o2.get_coin_id)
                        INNER JOIN actions        a1 ON (a1.action_index=o2.action_index)
                        INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN order_statuses s1 ON (s1.order_action_index=o2.action_index)
                        INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                order_statuses s3
                            WHERE
                                s3.order_action_index=o2.action_index
                        ) AND
                        o1.give_coin_id=o2.get_coin_id AND
                        (o1.give_tick_id=o2.get_tick_id OR (o1.give_tick_id IS NULL AND o2.get_tick_id IS NULL)) AND
                        o1.action_index=? AND
                        a1.source_id!=? AND
                        s2.status='open'
                    ORDER BY
                        o2.action_index ASC`;
        let args = [action_index, source_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            // Loop through possible matches and get full information on the order match
            for(let row of results){
                let orderInfo = await this.getOrderInfo(row.coin, row.action_index);
                if(!matches)
                    matches = [];
                matches.push(orderInfo);
            }
        }
        // Sort matches by price, then by action_index
        if(matches)
            matches = this.util.sortPriceActionIndex(matches);
        return matches;
    }

    // Return order info for given action_index
    async getOrderInfo(coin, action_index){
        let order = false;
        let query = `SELECT
                        o1.action_index,
                        t2.tick as give_tick,
                        o1.give_amount,
                        o1.give_ownership,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        o1.get_amount,
                        o1.get_ownership,
                        a2.address as source,
                        a3.address as get_address,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        m1.memo,
                        s2.status,
                        s3.status as order_status,
                        b1.block_index,
                        b1.block_time
                    FROM
                        orders o1
                        INNER JOIN actions         a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                        INNER JOIN index_addresses a3 ON (a3.id=o1.get_address_id)
                        LEFT  JOIN index_tickers   t2 ON (t2.id=o1.give_tick_id)
                        LEFT  JOIN index_tickers   t3 ON (t3.id=o1.get_tick_id)
                        INNER JOIN index_coins     c1 ON (c1.id=o1.get_coin_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=o1.memo_id)
                        INNER JOIN order_statuses  s1 ON (s1.order_action_index=o1.action_index)
                        INNER JOIN index_statuses  s2 ON (s2.id=o1.status_id)
                        INNER JOIN index_statuses  s3 ON (s3.id=s1.status_id)
                    WHERE 
                        s1.action_index = (
                            SELECT
                                MAX(s4.action_index)
                            FROM
                                order_statuses s4
                            WHERE
                                s4.order_action_index=o1.action_index
                        ) AND
                        c1.coin=? AND
                        o1.action_index=?
                    LIMIT 1`;
        let args  = [coin, action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            order = {};
            order['GIVE_COIN'] = this.config['COIN'];
            for(let key in results[0]){
                let name  = String(key).toUpperCase()
                let value = results[0][key];
                if(['ACTION_INDEX', 'BLOCK_INDEX', 'BLOCK_TIME', 'EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST', 'GIVE_OWNERSHIP', 'GET_OWNERSHIP'].includes(name))
                    value = Number(value);
                order[name] = value;
            }
        }
        // Get additional information on this order
        if(order){
            // Get updated order properties from the order_edits table
            let edit = await this.getOrderEdits(action_index);
            if(edit.expiration)
                order['EXPIRATION'] = edit.expiration;
            if(edit.allow_list)
                order['ALLOW_LIST'] = edit.allow_list;
            if(edit.block_list)
                order['BLOCK_LIST'] = edit.block_list;
            // Ownership orders carry no amount on the ownership side. Expose virtual '1'
            // so price math + match comparison work uniformly. Settlement code branches on
            // GIVE_OWNERSHIP / GET_OWNERSHIP flags rather than the synthetic amount.
            if(order['GIVE_OWNERSHIP'] == 1 && this.util.isNull(order['GIVE_AMOUNT']))
                order['GIVE_AMOUNT'] = '1';
            if(order['GET_OWNERSHIP']  == 1 && this.util.isNull(order['GET_AMOUNT']))
                order['GET_AMOUNT']  = '1';
            // Determine order get/give prices
            order['GIVE_PRICE'] = this.util.getPrice(order['GET_AMOUNT'],  order['GIVE_AMOUNT']);
            order['GET_PRICE']  = this.util.getPrice(order['GIVE_AMOUNT'], order['GET_AMOUNT']);
            // Determine order amounts remaining
            let [give_remaining, get_remaining] = await this.getOrderAmountsRemaining(action_index);
            order['GIVE_REMAINING'] = give_remaining;
            order['GET_REMAINING']  = get_remaining;
        }
        return order;
    }

    // Return order edit information for given action_index
    async getOrderEdits(action_index){
        // Define empty edit object
        let edit  = {
            expiration: false,
            allow_list: false,
            block_list: false
        };
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
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration)) edit.expiration = Number(row.expiration);
                if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list)) edit.allow_list = Number(row.allow_list);
                if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list)) edit.block_list = Number(row.block_list);
            }
        }
        return edit;
    }

    // Handle getting total amounts remaining for a given order
    async getOrderAmountsRemaining(action_index){
        // Placeholders for amount escrowed and amount matched
        let give_coin_id   = 0,
            give_tick_id   = 0,
            give_remaining = 0,
            get_coin_id    = 0,
            get_tick_id    = 0,
            get_remaining  = 0;
        // Get initial amounts from the orders table
        let query  = `SELECT
                        o.give_coin_id,
                        o.give_tick_id,
                        o.give_amount,
                        o.give_ownership,
                        o.get_coin_id,
                        o.get_tick_id,
                        o.get_amount,
                        o.get_ownership
                    FROM
                        orders o
                        INNER JOIN index_statuses s ON (s.id=o.status_id)
                    WHERE
                        o.action_index=? AND
                        s.status=?`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            let info = results[0];
            give_coin_id   = info.give_coin_id;
            give_tick_id   = info.give_tick_id;
            // Ownership orders carry no GIVE_AMOUNT/GET_AMOUNT in the schema; expose
            // virtual '1' so the matcher's bignumber math (price ratios, single-fill
            // subtraction) works uniformly with token-balance orders.
            give_remaining = (info.give_ownership == 1) ? '1' : info.give_amount;
            get_coin_id    = info.get_coin_id;
            get_tick_id    = info.get_tick_id;
            get_remaining  = (info.get_ownership  == 1) ? '1' : info.get_amount;
        }
        // Lookup amounts matched in order_matches
        query = `SELECT
                    m.give_action_index,
                    m.get_action_index,
                    m.give_amount,
                    m.get_amount
                FROM
                    order_matches m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    (m.give_action_index=? OR m.get_action_index=?) AND
                    s.status IN (?, ?)
                ORDER BY action_index ASC`;
        args = [action_index, action_index, 'valid', 'pending_coinpay'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            // Loop through each order match and deduct amount from remaining
            for(let row of results){
                let give_amount = (row.get_action_index==action_index) ? row.give_amount : row.get_amount;
                let get_amount  = (row.get_action_index==action_index) ? row.get_amount  : row.give_amount;
                give_remaining  = this.util.bcsub(give_remaining, give_amount, 64);
                get_remaining   = this.util.bcsub(get_remaining,  get_amount, 64);
            }
        }
        return [give_remaining, get_remaining];
    }

    // Create/Update record in `order_edits` table
    async createOrderEdit(data){
        data                   = this.normalizeDataValues(data);
        let memo_id            = await this.createMemo(data['MEMO']);
        let status_id          = await this.createStatus(data['STATUS']);
        let action_index       = data['ACTION_INDEX'];
        let order_action_index = data['ORDER_ACTION_INDEX'];
        let expiration         = data['EXPIRATION'];
        let allow_list         = data['ALLOW_LIST'];
        let block_list         = data['BLOCK_LIST'];
        // Check if record already exists for this order_edits
        let query  = `SELECT
                            action_index
                        FROM
                            order_edits
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
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
        args    = [expiration, allow_list, block_list, memo_id, status_id, order_action_index, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `order_cancels` table
    async createOrderCancel(data){
        data                  = this.normalizeDataValues(data);
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let order_action_index = data['ORDER_ACTION_INDEX'];
        // Check if record already exists for this swap_cancel
        let query  = `SELECT
                            action_index
                        FROM
                            order_cancels
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        order_cancels
                    SET
                        memo_id=?,
                        status_id=?,
                        order_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_cancels (memo_id, status_id, order_action_index, action_index) values (?, ?, ?, ?)`;
        }
        args    = [memo_id, status_id, order_action_index, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `order_matches` table
    async createOrderMatch(data, order, match){
        data                  = this.normalizeDataValues(data);
        let give_coin_id      = await this.createCoin(order['GIVE_COIN']);
        let give_tick_id      = await this.createTicker(order['GIVE_TICK']);
        let get_coin_id       = await this.createCoin(order['GET_COIN']);
        let get_tick_id       = await this.createTicker(order['GET_TICK']);
        let status_id         = await this.createStatus(data['STATUS']);
        let give_amount       = data['MATCH_GIVE_AMOUNT'];
        let get_amount        = data['MATCH_GET_AMOUNT'];
        let settlement_type   = data['SETTLEMENT_TYPE'] || 'instant';
        let action_index      = data['ACTION_INDEX'];
        let give_action_index = match['ACTION_INDEX']
        let get_action_index  = order['ACTION_INDEX'];
        // Check if record already exists for this order_matches
        let query  = `SELECT
                            action_index
                        FROM
                            order_matches
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        order_matches
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        give_action_index=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_action_index=?,
                        settlement_type=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO order_matches (give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, settlement_type, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, settlement_type, status_id, action_index];
        results = await this.doQuery(query, args);
    }


    //////////////////////////////////////////////////////////////////////////
    // COINPay Methods
    //////////////////////////////////////////////////////////////////////////

    // Create/Update record in `coinpay_obligations` table
    // @param {data} object COINPay obligation data
    async createCoinpayObligation(data){
        data = this.normalizeDataValues(data);
        let action_index     = data['ACTION_INDEX'];
        let payer_address_id = await this.createAddress(data['PAYER_ADDRESS']);
        let payee_address_id = await this.createAddress(data['PAYEE_ADDRESS']);
        let coin_id          = await this.createCoin(data['COIN']);
        let coin_amount      = data['COIN_AMOUNT'];
        let expiration       = data['EXPIRATION'];
        let block_index      = data['BLOCK_INDEX'];
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            coinpay_obligations
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        coinpay_obligations
                    SET
                        payer_address_id=?,
                        payee_address_id=?,
                        coin_id=?,
                        coin_amount=?,
                        expiration=?,
                        block_index=?
                    WHERE
                        action_index=?`;
            args = [payer_address_id, payee_address_id, coin_id, coin_amount, expiration, block_index, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO coinpay_obligations (action_index, payer_address_id, payee_address_id, coin_id, coin_amount, expiration, block_index) values (?, ?, ?, ?, ?, ?, ?)`;
            args = [action_index, payer_address_id, payee_address_id, coin_id, coin_amount, expiration, block_index];
        }
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `coinpay_statuses` table
    // @param {action_index}         integer Action index of action that caused this status change
    // @param {coinpay_action_index} integer Action index of the coinpay obligation (ORDER_MATCH action_index)
    // @param {status}               string  Status value (pending_coinpay/fulfilled/expired/cancelled)
    async createCoinpayStatus(action_index, coinpay_action_index, status){
        let status_id = await this.createStatus(status);
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            coinpay_statuses
                        WHERE
                            action_index=? AND
                            coinpay_action_index=?`;
        let args = [action_index, coinpay_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        coinpay_statuses
                    SET
                        status_id=?
                    WHERE
                        action_index=? AND
                        coinpay_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO coinpay_statuses (status_id, action_index, coinpay_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, coinpay_action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `coinpay_expires` table
    // @param {action_index}            integer Action index of this COINPAY_EXPIRE action
    // @param {obligation_action_index} integer Action index of the coinpay obligation (ORDER_MATCH action_index)
    // @param {status}                  string  Status of the expire (valid/invalid)
    async createCoinpayExpire(action_index, obligation_action_index, status){
        let status_id = await this.createStatus(status);
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            coinpay_expires
                        WHERE
                            action_index=? AND
                            obligation_action_index=?`;
        let args = [action_index, obligation_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        coinpay_expires
                    SET
                        status_id=?
                    WHERE
                        action_index=? AND
                        obligation_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO coinpay_expires (status_id, action_index, obligation_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, obligation_action_index];
        results = await this.doQuery(query, args);
    }

    // Get COINPay obligation info by action_index
    // @param {action_index} integer The ORDER_MATCH action_index that created the obligation
    async getCoinpayObligationInfo(action_index){
        let obligation = false;
        let query = `SELECT
                        co.action_index,
                        a1.address as payer_address,
                        a2.address as payee_address,
                        c1.coin,
                        co.coin_amount,
                        co.expiration,
                        co.block_index,
                        s2.status as coinpay_status
                    FROM
                        coinpay_obligations co
                        INNER JOIN index_addresses a1 ON (a1.id=co.payer_address_id)
                        INNER JOIN index_addresses a2 ON (a2.id=co.payee_address_id)
                        INNER JOIN index_coins     c1 ON (c1.id=co.coin_id)
                        INNER JOIN coinpay_statuses s1 ON (s1.coinpay_action_index=co.action_index)
                        INNER JOIN index_statuses   s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                coinpay_statuses s3
                            WHERE
                                s3.coinpay_action_index=co.action_index
                        ) AND
                        co.action_index=?
                    LIMIT 1`;
        let args = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            obligation = {};
            for(let key in results[0]){
                let name  = String(key).toUpperCase();
                let value = results[0][key];
                if(['ACTION_INDEX', 'BLOCK_INDEX', 'EXPIRATION'].includes(name))
                    value = Number(value);
                obligation[name] = value;
            }
        }
        return obligation;
    }

    // Get all expired COINPay obligations (status=pending_coinpay and expiration < block_time)
    // @param {block_time} integer Current block timestamp
    async getExpiredCoinpayObligations(block_time){
        let expired = [];
        let query = `SELECT
                        co.action_index,
                        co.expiration
                    FROM
                        coinpay_obligations co
                        INNER JOIN coinpay_statuses s1 ON (s1.coinpay_action_index=co.action_index)
                        INNER JOIN index_statuses   s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                coinpay_statuses s3
                            WHERE
                                s3.coinpay_action_index=co.action_index
                        ) AND
                        s2.status='pending_coinpay' AND
                        co.expiration < ?
                    ORDER BY co.action_index ASC`;
        let args = [block_time];
        let results = await this.doQuery(query, args);
        for(let row of results){
            expired.push({
                action_index: Number(row.action_index),
                expiration:   Number(row.expiration)
            });
        }
        return expired;
    }

    // Get order action_indexes from an ORDER_MATCH
    // @param {match_action_index} integer The ORDER_MATCH action_index
    // Returns {give_action_index, get_action_index} or false
    async getOrderMatchOrders(match_action_index){
        let query = `SELECT
                        give_action_index,
                        get_action_index
                    FROM
                        order_matches
                    WHERE
                        action_index=?
                    LIMIT 1`;
        let args = [match_action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            return {
                give_action_index: Number(results[0].give_action_index),
                get_action_index:  Number(results[0].get_action_index)
            };
        }
        return false;
    }

    // Get pending COINPay obligations for a given order
    // @param {order_action_index} integer Action index of the order to check
    async getPendingCoinpayObligationsByOrder(order_action_index){
        let pending = [];
        let query = `SELECT
                        co.action_index
                    FROM
                        coinpay_obligations co
                        INNER JOIN order_matches om ON (om.action_index=co.action_index)
                        INNER JOIN coinpay_statuses s1 ON (s1.coinpay_action_index=co.action_index)
                        INNER JOIN index_statuses   s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                coinpay_statuses s3
                            WHERE
                                s3.coinpay_action_index=co.action_index
                        ) AND
                        s2.status='pending_coinpay' AND
                        (om.give_action_index=? OR om.get_action_index=?)
                    ORDER BY co.action_index ASC`;
        let args = [order_action_index, order_action_index];
        let results = await this.doQuery(query, args);
        for(let row of results){
            pending.push(Number(row.action_index));
        }
        return pending;
    }

    // List this chain's OPEN cross-chain SWAP offers (give_coin != get_coin) for the
    // xchain-hub federation's matching view. Paginates by keyset on action_index.
    // @param {limit}             integer Max rows (caller clamps)
    // @param {after_action_index} integer Keyset cursor — return rows with action_index > this
    // @param {to_coin}           string  Optional filter: only offers whose GET_COIN equals this
    async getOpenCrossChainSwaps(limit, after_action_index, to_coin){
        let where = [
            `ss.action_index = (SELECT MAX(s3.action_index) FROM swap_statuses s3 WHERE s3.swap_action_index=s1.action_index)`,
            `st.status='open'`,
            `s1.give_coin_id != s1.get_coin_id`
        ];
        let args = [];
        if(!this.util.isNull(to_coin)){ where.push(`cc.coin=?`); args.push(to_coin); }
        if(Number.isFinite(Number(after_action_index))){ where.push(`s1.action_index>?`); args.push(Number(after_action_index)); }
        let query = `SELECT
                        s1.action_index,
                        gc.coin    as give_coin,
                        gt.tick    as give_tick,
                        s1.give_amount,
                        s1.give_ownership,
                        cc.coin    as get_coin,
                        rt.tick    as get_tick,
                        s1.get_amount,
                        s1.get_ownership,
                        ga.address as get_address,
                        sa.address as source,
                        s1.expiration,
                        s1.allow_list,
                        s1.block_list,
                        t1.block_index
                    FROM
                        swaps s1
                        INNER JOIN actions         a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_addresses sa ON (sa.id=a1.source_id)
                        INNER JOIN index_addresses ga ON (ga.id=s1.get_address_id)
                        INNER JOIN index_coins     gc ON (gc.id=s1.give_coin_id)
                        INNER JOIN index_coins     cc ON (cc.id=s1.get_coin_id)
                        INNER JOIN index_tickers   gt ON (gt.id=s1.give_tick_id)
                        LEFT  JOIN index_tickers   rt ON (rt.id=s1.get_tick_id)
                        INNER JOIN swap_statuses   ss ON (ss.swap_action_index=s1.action_index)
                        INNER JOIN index_statuses  st ON (st.id=ss.status_id)
                    WHERE ` + where.join(' AND ') + `
                    ORDER BY s1.action_index ASC
                    LIMIT ?`;
        args.push(Number(limit));
        let results = await this.doQuery(query, args);
        return results.map(row => ({
            kind:           'swap',
            action_index:   Number(row.action_index),
            give_coin:      row.give_coin,
            give_tick:      row.give_tick,
            // Ownership offers carry no amount — expose virtual '1' so the hub's committed
            // ledger + amount compare work uniformly (matches getOrderInfo's convention).
            give_amount:    (Number(row.give_ownership) === 1 && this.util.isNull(row.give_amount)) ? '1' : row.give_amount,
            give_ownership: Number(row.give_ownership),
            get_coin:       row.get_coin,
            get_tick:       row.get_tick,
            get_amount:     (Number(row.get_ownership) === 1 && this.util.isNull(row.get_amount)) ? '1' : row.get_amount,
            get_ownership:  Number(row.get_ownership),
            get_address:    row.get_address,
            source:         row.source,
            expiration:     Number(row.expiration),
            allow_list:     row.allow_list,
            block_list:     row.block_list,
            block_index:    Number(row.block_index)
        }));
    }

    // Open cross-chain ORDER offers (get on a different COIN network), for the hub's unified
    // book. Parallels getOpenCrossChainSwaps but carries give_remaining/get_remaining (partial
    // fills) so the hub matches against effective remaining and never over-fills escrow. The
    // "from" chain is implicit (this indexer's COIN). Keyset-paginated by action_index.
    async getOpenCrossChainOrders(limit, after_action_index, to_coin){
        let where = [
            `os.action_index = (SELECT MAX(s3.action_index) FROM order_statuses s3 WHERE s3.order_action_index=o1.action_index)`,
            `st.status='open'`,
            `o1.give_coin_id != o1.get_coin_id`
        ];
        let args = [];
        if(!this.util.isNull(to_coin)){ where.push(`cc.coin=?`); args.push(to_coin); }
        if(Number.isFinite(Number(after_action_index))){ where.push(`o1.action_index>?`); args.push(Number(after_action_index)); }
        let query = `SELECT
                        o1.action_index,
                        gc.coin    as give_coin,
                        gt.tick    as give_tick,
                        o1.give_amount,
                        o1.give_ownership,
                        cc.coin    as get_coin,
                        rt.tick    as get_tick,
                        o1.get_amount,
                        o1.get_ownership,
                        ga.address as get_address,
                        sa.address as source,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        t1.block_index
                    FROM
                        orders o1
                        INNER JOIN actions         a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_addresses sa ON (sa.id=a1.source_id)
                        INNER JOIN index_addresses ga ON (ga.id=o1.get_address_id)
                        INNER JOIN index_coins     gc ON (gc.id=o1.give_coin_id)
                        INNER JOIN index_coins     cc ON (cc.id=o1.get_coin_id)
                        LEFT  JOIN index_tickers   gt ON (gt.id=o1.give_tick_id)
                        LEFT  JOIN index_tickers   rt ON (rt.id=o1.get_tick_id)
                        INNER JOIN order_statuses  os ON (os.order_action_index=o1.action_index)
                        INNER JOIN index_statuses  st ON (st.id=os.status_id)
                    WHERE ` + where.join(' AND ') + `
                    ORDER BY o1.action_index ASC
                    LIMIT ?`;
        args.push(Number(limit));
        let results = await this.doQuery(query, args);
        let orders = [];
        for(let row of results){
            // Remaining (give/get) reflects all fills — local order_matches AND cross-chain
            // settlements (both recorded in order_matches) — so the hub's reservation is exact.
            let [give_remaining, get_remaining] = await this.getOrderAmountsRemaining(row.action_index);
            let isOwnGive = (Number(row.give_ownership) === 1 && this.util.isNull(row.give_amount));
            let isOwnGet  = (Number(row.get_ownership)  === 1 && this.util.isNull(row.get_amount));
            orders.push({
                kind:           'order',
                action_index:   Number(row.action_index),
                give_coin:      row.give_coin,
                give_tick:      row.give_tick,
                give_amount:    isOwnGive ? '1' : row.give_amount,
                give_remaining: String(give_remaining),
                give_ownership: Number(row.give_ownership),
                get_coin:       row.get_coin,
                get_tick:       row.get_tick,
                get_amount:     isOwnGet ? '1' : row.get_amount,
                get_remaining:  String(get_remaining),
                get_ownership:  Number(row.get_ownership),
                get_address:    row.get_address,
                source:         row.source,
                expiration:     Number(row.expiration),
                allow_list:     row.allow_list,
                block_list:     row.block_list,
                block_index:    Number(row.block_index)
            });
        }
        return orders;
    }

    // Record a cross-chain ORDER partial fill in order_matches so getOrderAmountsRemaining
    // deducts it — the single source of truth for an order's remaining (local fills and
    // cross-chain fills both live here, so the offer book + completion logic stay consistent).
    // The local order is the GET side of the synthetic row (get_action_index = local order),
    // so the subtract loop maps give_amount→give_remaining and get_amount→get_remaining.
    // The cross counterparty has no local order, so give_action_index = the CROSS_SETTLE
    // action_index (rollback-able: a reorg drops this row and the order's remaining restores).
    async recordCrossChainOrderFill(settlement_action_index, order_action_index, give_amount, get_amount, give_coin, give_tick, get_coin, get_tick){
        let give_coin_id = await this.createCoin(give_coin);
        let get_coin_id  = await this.createCoin(get_coin);
        let give_tick_id = this.util.isNull(give_tick) ? null : await this.createTicker(give_tick);
        let get_tick_id  = this.util.isNull(get_tick)  ? null : await this.createTicker(get_tick);
        let status_id    = await this.createStatus('valid');
        let exists = await this.doQuery(`SELECT action_index FROM order_matches WHERE action_index=?`, [settlement_action_index]);
        if(exists.length > 0) return;                          // idempotent (one fill per settlement)
        await this.doQuery(
            `INSERT INTO order_matches (give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, settlement_type, status_id, action_index)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'instant', ?, ?)`,
            [give_coin_id, give_tick_id, give_amount, settlement_action_index, get_coin_id, get_tick_id, get_amount, order_action_index, status_id, settlement_action_index]);
    }

    // Finalized cross-chain matches that involve THIS chain, are effective at/before
    // block_time, and have not yet been settled locally. Drives the settlement pass.
    // cross_chain_matches is a hub-mirrored table (read via _mirrorDb), while
    // cross_chain_settlements is a local indexer table (read via this) — so we filter in JS
    // rather than join across two databases.
    async getEffectiveUnsettledMatches(coin, block_time){
        // network filter: a match only settles on the indexer of the network it was matched
        // + signed on (also bound into the signed canonical — see cross_settle._canonical).
        let network = this.config['NETWORK'];
        let matches = await this._mirrorDb().doQuery(
            `SELECT * FROM cross_chain_matches
             WHERE status = 'finalized' AND network = ? AND effective_time <= ? AND (a_chain = ? OR b_chain = ?)
             ORDER BY id ASC`,
            [network, block_time, coin, coin]);
        if(matches.length === 0) return [];
        let ids = matches.map(m => m.match_id);
        let placeholders = ids.map(() => '?').join(',');
        let settled = await this.doQuery(
            `SELECT match_id FROM cross_chain_settlements WHERE match_id IN (${placeholders})`, ids);
        let settledSet = new Set(settled.map(r => r.match_id));
        return matches.filter(m => !settledSet.has(m.match_id));
    }

    // Record that this chain settled its leg of a cross-chain match (idempotent on
    // match_id). The action_index is rollback-able, so a reorg drops this row and the
    // match re-applies.
    async recordCrossChainSettlement(action_index, match_id, local_action_index, block_index){
        await this.doQuery(
            `INSERT IGNORE INTO cross_chain_settlements (action_index, match_id, local_action_index, block_index) VALUES (?, ?, ?, ?)`,
            [action_index, match_id, local_action_index, block_index]);
    }

    // Create/Update record in `coinpays` table (fulfilled COINPay payments)
    // @param {data} object COINPay payment data
    async createCoinpay(data){
        data = this.normalizeDataValues(data);
        let action_index            = data['ACTION_INDEX'];
        let obligation_action_index = data['OBLIGATION_ACTION_INDEX'];
        let coin_amount             = data['COIN_AMOUNT'];
        let txid                    = data['TXID'];
        let vout                    = data['VOUT'];
        let status_id               = await this.createStatus(data['STATUS']);
        let block_index             = data['BLOCK_INDEX'];
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            coinpays
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        coinpays
                    SET
                        obligation_action_index=?,
                        coin_amount=?,
                        txid=?,
                        vout=?,
                        status_id=?,
                        block_index=?
                    WHERE
                        action_index=?`;
            args = [obligation_action_index, coin_amount, txid, vout, status_id, block_index, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO coinpays (action_index, obligation_action_index, coin_amount, txid, vout, status_id, block_index) values (?, ?, ?, ?, ?, ?, ?)`;
            args = [action_index, obligation_action_index, coin_amount, txid, vout, status_id, block_index];
        }
        results = await this.doQuery(query, args);
    }

    // Get ORDER_MATCH give/get amounts
    // @param {match_action_index} integer The ORDER_MATCH action_index
    // Returns {give_action_index, get_action_index, give_amount, get_amount} or false
    async getOrderMatchAmounts(match_action_index){
        let query = `SELECT
                        give_action_index,
                        get_action_index,
                        give_amount,
                        get_amount
                    FROM
                        order_matches
                    WHERE
                        action_index=?
                    LIMIT 1`;
        let args = [match_action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            return {
                give_action_index: Number(results[0].give_action_index),
                get_action_index:  Number(results[0].get_action_index),
                give_amount:       results[0].give_amount,
                get_amount:        results[0].get_amount
            };
        }
        return false;
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
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // Create record if it does not already exist
        if(!exists){
            query   = `INSERT INTO mappings_actions (action_index, type_id, id) values (?, ?, ?)`;
            results = await this.doQuery(query, args);
        }
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
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // Create record if it does not already exist
        if(!exists){
            query   = `INSERT INTO mappings_files (action_index, type_id, id) values (?, ?, ?)`;
            results = await this.doQuery(query, args);
        }
    }

    // Get action type for a given action_index
    async getActionType(action_index){
        let type = null;
        // Lookup the ACTION based on the action_index
        let args = [action_index];
        let sql  = `SELECT 
                        a2.action
                    FROM
                        actions a1
                        INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                    WHERE
                        a1.action_index=?`;
        let results = await this.doQuery(sql, args);
        if(results && results.length)
            type = results[0].action;
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
                            INNER JOIN index_addresses    a4 ON (a4.id=a2.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=a1.memo_id)
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
                            INNER JOIN index_addresses    a4 ON (a4.id=a2.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=a1.memo_id)
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
                            INNER JOIN index_addresses    a4 ON (a4.id=a2.source_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=b1.memo_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=c1.memo_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=d1.memo_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=f1.memo_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=l1.memo_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=m1.memo_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=o1.get_address_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=o1.memo_id)
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
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        LEFT  JOIN index_memos        m2 ON (m2.id=o1.memo_id)
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
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        LEFT  JOIN index_memos        m2 ON (m2.id=o1.memo_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=s1.destination_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=s1.get_address_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
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
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
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
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=s1.destination_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
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
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        WHERE 
                            a1.action_index=?
                        LIMIT 1`;
            }
            // Run the SQL query to get the information on the action_index
            if(sql){
                let results = await this.doQuery(sql, [action_index]);
                if(results && results.length)
                    data = results[0];
            }
        }
        return data;
    }

    // Lookup items that need to be expired and return a list
    async getExpiredItems(block_time){
        let expired = [];
        let types   = ['order','swap','dispenser'];
        let query   = '';
        let args    = [];
        // Build out the query for each of the table types to get 'open' items
        for(let type of types){
            if(query!='')
                query += 'UNION ';
            query += `SELECT 
                        m.action_index, 
                        m.expiration,
                        '` + type + `' as type
                    FROM 
                        ` + type + `s m
                        INNER JOIN ` + type + `_statuses s1 ON (s1.` + type + `_action_index=m.action_index)
                        INNER JOIN index_statuses        s2 ON (s2.id=s1.status_id)
                    WHERE 
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                ` + type + `_statuses s3
                            WHERE
                                s3.` + type + `_action_index=m.action_index
                        ) AND
                        s2.status='open'`
        }
        // Process expirations in ascending global action_index order so every
        // instance derives identical AUTO_INCREMENT IDs for the same block.
        // (UNION result: order by the output column name, not a table alias.)
        query += ' ORDER BY action_index ASC';
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            // Get the current expiration for each item
            for(let info of results){
                // Get list of any `valid` edits and set expiration
                query  = `SELECT 
                            s1.expiration
                        FROM 
                            ` + info.type + `_edits s1
                            INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                        WHERE 
                            s1.` + info.type + `_action_index=? AND
                            s2.status=?
                        ORDER BY
                            s1.action_index ASC`;
                args         = [info.action_index, 'valid'];
                let results2 = await this.doQuery(query, args);
                if(results2.length > 0){
                    for(let row of results2){
                        if(!this.util.isNull(row.expiration))
                            info.expiration = row.expiration;
                    }
                }
                // If the item expiration is less than the current block_time, expire the item
                if(info.expiration < block_time){
                    expired.push({
                        type:         info.type,
                        action_index: Number(info.action_index),
                        expiration:   Number(info.expiration)
                    });
                }
            }
        }
        return expired;
    }

    // Lookup market pairs by block
    // TODO: Circle back and add support for cross-chain market data (different coin_id)
    async getMarkets(block_index, update){
        let markets    = [];
        let args       = [block_index];
        let counts     = false;
        let query      = '';
        let where      = 'b1.block_index=? AND ';
        // Get the time right now and the time 24 hours ago
        let time_now   = await this.getBlockTime(block_index),
            time_24hr  = this.util.bcsub(time_now, 86400);
        // Quickly check if we have any ORDER, ORDER_MATCH, ORDER_EXPIRE, or ORDER_CANCEL events for the given block
        query = `SELECT
                    count(*) as count,
                    a2.action as type
                FROM
                    actions a1
                    INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                WHERE
                    a1.block_index=? AND
                    a2.action IN ('ORDER','ORDER_MATCH','ORDER_EXPIRE','ORDER_CANCEL')
                GROUP BY a2.action
                ORDER BY a2.action`;
        counts = await this.doQuery(query, args);
        // Updates to find markets which have not been updated in the last 24 hours
        if(update){
            where = `(a1.block_index=? OR b1.block_time < ? ) AND `;
            let types = ['ORDER','ORDER_MATCH','ORDER_EXPIRE','ORDER_CANCEL'];
            for(let type of types){
                let found = false;
                for(let item of counts){
                    if(item.type==type)
                        found = true;
                }
                if(!found){
                    counts.push({
                        count: 1,
                        type: type
                    });
                }
            }
        }
        // Loop through order action types and get list of market pairs
        for(let info of counts){
            let pairs = [],
                query = false,
                type  = info.type,
                table = String(type).toLowerCase() + ((type.includes('_MATCH')) ? 'es' : 's');
            // Set the arguments
            if(update){
                args = [block_index, time_24hr, 'valid'];
            } else {
                args = [block_index, 'valid'];
            }
            if(['ORDER','ORDER_MATCH'].includes(type)){
                query = `SELECT 
                            o1.action_index,
                            o1.get_tick_id  as tick1_id,
                            o1.give_tick_id as tick2_id
                        FROM
                            ` + table + ` o1
                            INNER JOIN actions        a1 ON (a1.action_index=o1.action_index)
                            INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN index_coins    c1 ON (c1.id=o1.give_coin_id)
                            INNER JOIN index_statuses s1 ON (s1.id=o1.status_id)
                        WHERE
                            ` + where + `
                            o1.give_coin_id=o1.get_coin_id AND
                            s1.status=?
                        ORDER BY o1.action_index ASC`;
            } else if(['ORDER_CANCEL','ORDER_EXPIRE'].includes(type)){
                query = `SELECT 
                            o1.action_index,
                            o2.get_tick_id  as tick1_id,
                            o2.give_tick_id as tick2_id
                        FROM
                            ` + table + ` o1
                            INNER JOIN orders         o2 ON (o2.action_index=o1.order_action_index)
                            INNER JOIN actions        a1 ON (a1.action_index=o1.action_index)
                            INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN index_statuses s1 ON (s1.id=o1.status_id)
                        WHERE
                            ` + where + `
                            s1.status=?
                        ORDER BY o1.action_index ASC`;
            }
            if(query){
                let results = await this.doQuery(query, args);
                if(results.length > 0){
                    for(let row of results){
                        // Check if this pair already exists
                        let found = false;
                        for(let pair of markets){
                            if((pair.tick1_id == row.tick1_id && pair.tick2_id == row.tick2_id) || (pair.tick1_id == row.tick2_id && pair.tick2_id == row.tick1_id))
                                found = true;
                        }
                        if(!found){
                            markets.push({
                                tick1_id: Number(row.tick1_id),
                                tick2_id: Number(row.tick2_id)
                            });
                        }
                    }
                }
           }
        }
        return markets;
    }

    // Get market_id for given ticker ids
    async getMarketId(tick1_id, tick2_id){
        let id     = null;
        let query  = `SELECT
                            id
                        FROM
                            markets m
                        WHERE
                            (m.tick1_id=? AND m.tick2_id=?) OR
                            (m.tick1_id=? AND m.tick2_id=?)`;
        let args = [tick1_id, tick2_id, tick2_id, tick1_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            id = results[0].id;
        return id;
    }

    // Create record in `markets` table
    async createMarket(tick1_id, tick2_id){
        let id = await this.getMarketId(tick1_id, tick2_id);
        if(id==null){
            // ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id) makes a concurrent
            // insert of the same pair a no-op while still returning the existing
            // row's id via insertId. Combined with the UNIQUE(tick1_id, tick2_id)
            // key this prevents two rows ever being created for the same pair if
            // two inserts race past the getMarketId check above.
            let query = `INSERT INTO markets (tick1_id, tick2_id) values (?, ?)
                         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`;
            let args  = [tick1_id, tick2_id];
            let results = await this.doQuery(query, args);
            if(results.insertId)
                id = Number(results.insertId);
        }
        return id;
    }

    // Handle getting information on a given market
    async getMarketInfo(market_id, block_time){
        // Define response object
        let data = {
            tick1_price       : 0,
            tick1_bid         : 0,
            tick1_ask         : 0,
            tick1_24hr_price  : 0,
            tick1_24hr_high   : 0,
            tick1_24hr_low    : 0,
            tick1_24hr_change : 0,
            tick1_24hr_volume : 0,
            tick2_price       : 0,
            tick2_bid         : 0,
            tick2_ask         : 0,
            tick2_24hr_price  : 0,
            tick2_24hr_high   : 0,
            tick2_24hr_low    : 0,
            tick2_24hr_change : 0,
            tick2_24hr_volume : 0,
        };
        // Get the time right now and the time 24 hours ago
        let time_now  = block_time,
            time_24hr = this.util.bcsub(time_now, 86400);
        // Set the last time this info was updated to now
        data.last_updated = time_now;
        // Lookup basic information on this market (tick, tick_id, decimals)
        let query = `SELECT
                            m1.id       as market_id,
                            t3.tick     as tick1,
                            t1.tick_id  as tick1_id,
                            t1.decimals as tick1_decimals,
                            t4.tick     as tick2,
                            t2.tick_id  as tick2_id,
                            t2.decimals as tick2_decimals
                        FROM
                            markets m1
                            INNER JOIN tokens        t1 ON (t1.tick_id=m1.tick1_id)
                            INNER JOIN tokens        t2 ON (t2.tick_id=m1.tick2_id)
                            INNER JOIN index_tickers t3 ON (t3.id=t1.tick_id)
                            INNER JOIN index_tickers t4 ON (t4.id=t2.tick_id)
                        WHERE 
                            m1.id=?`;
        let args  = [market_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            let row = results[0];
            // Convert the ids from BIGINT to Number
            row.market_id = Number(row.market_id);
            row.tick1_id  = Number(row.tick1_id);
            row.tick2_id  = Number(row.tick2_id);
            Object.assign(data, row);
        }
        // Lookup last trade prices
        query = `SELECT
                m1.give_tick_id,
                m1.give_amount,
                m1.get_tick_id,
                m1.get_amount
            FROM 
                order_matches m1
                INNER JOIN index_statuses s1 ON (s1.id=m1.status_id)
            WHERE
                m1.give_coin_id=m1.get_coin_id AND 
                ((m1.give_tick_id=? AND m1.get_tick_id=?) OR (m1.give_tick_id=? AND m1.get_tick_id=?))  AND
                s1.status=?
            ORDER BY m1.action_index DESC 
            LIMIT 1`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let row = results[0];
            let give_amount = (row.give_tick_id==data.tick1_id) ? row.give_amount : row.get_amount;
            let get_amount  = (row.give_tick_id==data.tick1_id) ? row.get_amount  : row.give_amount;
            data.tick1_price = this.util.getPrice(get_amount, give_amount);
            data.tick2_price = this.util.getPrice(give_amount, get_amount);
        }
        // Lookup trade prices 24-hours ago
        query = `SELECT
                m1.give_tick_id,
                m1.give_amount,
                m1.get_tick_id,
                m1.get_amount
            FROM 
                order_matches m1
                INNER JOIN index_statuses s1 ON (s1.id=m1.status_id)
                INNER JOIN actions        a1 ON (a1.action_index=m1.action_index)
                INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
            WHERE
                m1.give_coin_id=m1.get_coin_id AND 
                ((m1.give_tick_id=? AND m1.get_tick_id=?) OR (m1.give_tick_id=? AND m1.get_tick_id=?))  AND
                s1.status=? AND
                b1.block_time <= ?
            ORDER BY m1.action_index DESC 
            LIMIT 1`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', time_24hr];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let row = results[0];
            let give_amount = (row.give_tick_id==data.tick1_id) ? row.give_amount : row.get_amount;
            let get_amount  = (row.give_tick_id==data.tick1_id) ? row.get_amount  : row.give_amount;
            data.tick1_24hr_price = this.util.getPrice(get_amount, give_amount);
            data.tick2_24hr_price = this.util.getPrice(give_amount, get_amount);
        }
        // Lookup 'bid' prices
        query = `SELECT
                o1.give_tick_id,
                o1.give_amount,
                o1.get_tick_id,
                o1.get_amount
            FROM 
                orders o1
                INNER JOIN order_statuses s1 ON (s1.order_action_index=o1.action_index)
                INNER JOIN index_statuses s2 ON (s2.id=o1.status_id)
                INNER JOIN index_statuses s3 ON (s3.id=s1.status_id)
            WHERE
                o1.give_coin_id=o1.get_coin_id AND 
                ((o1.give_tick_id=? AND o1.get_tick_id=?) OR (o1.give_tick_id=? AND o1.get_tick_id=?))  AND
                s2.status=? AND
                s3.status=? AND
                s1.action_index = (
                    SELECT
                        MAX(s4.action_index)
                    FROM
                        order_statuses s4
                    WHERE
                        s4.order_action_index = o1.action_index
                )
            ORDER BY o1.action_index DESC`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', 'open'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let tick1_bid = 0,
                tick2_bid = 0;
            for(let row of results){
                let give_amount = (row.give_tick_id==data.tick1_id) ? row.give_amount : row.get_amount;
                let get_amount  = (row.give_tick_id==data.tick1_id) ? row.get_amount : row.give_amount;
                let price1      = this.util.getPrice(get_amount, give_amount);
                let price2      = this.util.getPrice(give_amount, get_amount);
                if(price1==0||price2==0)
                    continue;
                if(tick1_bid==0) tick1_bid = price1;
                if(tick2_bid==0) tick2_bid = price2;
                if(price1 > tick1_bid) tick1_bid = price1;
                if(price2 > tick2_bid) tick2_bid = price2;
            }
            data.tick1_bid  = tick1_bid;
            data.tick2_bid  = tick2_bid;
        }
        // Lookup 'ask' prices
        query = `SELECT
                o1.give_tick_id,
                o1.give_amount,
                o1.get_tick_id,
                o1.get_amount
            FROM 
                orders o1
                INNER JOIN order_statuses s1 ON (s1.order_action_index=o1.action_index)
                INNER JOIN index_statuses s2 ON (s2.id=o1.status_id)
                INNER JOIN index_statuses s3 ON (s3.id=s1.status_id)
            WHERE
                o1.give_coin_id=o1.get_coin_id AND 
                ((o1.give_tick_id=? AND o1.get_tick_id=?) OR (o1.give_tick_id=? AND o1.get_tick_id=?))  AND
                s2.status=? AND
                s3.status=? AND
                s1.action_index = (
                    SELECT
                        MAX(s4.action_index)
                    FROM
                        order_statuses s4
                    WHERE
                        s4.order_action_index = o1.action_index
                )
            ORDER BY o1.action_index DESC`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', 'open'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let tick1_ask = 0,
                tick2_ask = 0;
            for(let row of results){
                let give_amount = (row.give_tick_id==data.tick1_id) ? row.give_amount : row.get_amount;
                let get_amount  = (row.give_tick_id==data.tick1_id) ? row.get_amount : row.give_amount;
                let price1      = this.util.getPrice(get_amount, give_amount);
                let price2      = this.util.getPrice(give_amount, get_amount);
                if(price1==0||price2==0)
                    continue;
                if(tick1_ask==0) tick1_ask = price1;
                if(tick2_ask==0) tick2_ask = price2;
                if(price1 < tick1_ask) tick1_ask = price1;
                if(price2 < tick2_ask) tick2_ask = price2;
            }
            data.tick1_ask = tick1_ask;
            data.tick2_ask = tick2_ask;
        }
        // Lookup all order matches in the last 24-hours
        query = `SELECT
                m1.give_tick_id,
                m1.give_amount,
                m1.get_tick_id,
                m1.get_amount
            FROM 
                order_matches m1
                INNER JOIN index_statuses s1 ON (s1.id=m1.status_id)
                INNER JOIN actions        a1 ON (a1.action_index=m1.action_index)
                INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
            WHERE
                m1.give_coin_id=m1.get_coin_id AND 
                ((m1.give_tick_id=? AND m1.get_tick_id=?) OR (m1.give_tick_id=? AND m1.get_tick_id=?))  AND
                s1.status=? AND
                b1.block_time >= ?
            ORDER BY m1.action_index DESC`;
        args    = [data.tick1_id, data.tick2_id, data.tick2_id, data.tick1_id, 'valid', time_24hr];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            let tick1_high   = 0,
                tick1_low    = 0,
                tick1_volume = 0,
                tick2_high   = 0,
                tick2_low    = 0,
                tick2_volume = 0;
            for(let row of results){
                let give_amount = (row.give_tick_id==data.tick1_id) ? row.give_amount : row.get_amount;
                let get_amount  = (row.give_tick_id==data.tick1_id) ? row.get_amount : row.give_amount;
                let price1      = this.util.getPrice(get_amount, give_amount);
                let price2      = this.util.getPrice(give_amount, get_amount);
                // Set tick high/low prices
                if(tick1_high==0 && tick1_low==0){
                    tick1_high = price1;
                    tick1_low  = price1;
                }
                if(tick2_high==0 && tick2_low==0){
                    tick2_high = price2;
                    tick2_low  = price2;
                }
                // 24-hour high
                if(price1 > tick1_high) tick1_high = price1;
                if(price2 > tick2_high) tick2_high = price2;
                // 24-hour low
                if(price1 < tick1_low) tick1_low = price1;
                if(price2 < tick2_low) tick2_low = price2;
                // 24-hour volumes
                tick1_volume = this.util.bcadd(tick1_volume, give_amount);
                tick2_volume = this.util.bcadd(tick2_volume, get_amount);
            }
            data.tick1_24hr_high   = tick1_high;
            data.tick1_24hr_low    = tick1_low;
            data.tick1_24hr_volume = tick1_volume;
            data.tick2_24hr_high   = tick2_high;
            data.tick2_24hr_low    = tick2_low;
            data.tick2_24hr_volume = tick2_volume;
        }
        // Calculate 24-hour price change percentage
        let tick1_change = 0.00;
        let tick2_change = 0.00;
        if(this.util.bcgt(data.tick1_price, 0) && this.util.bcgt(data.tick1_24hr_price, 0))
            tick1_change = this.util.bcmul(this.util.bcdiv(this.util.bcsub(data.tick1_price, data.tick1_24hr_price,8), data.tick1_24hr_price,8), 100, 2);
        if(this.util.bcgt(data.tick2_price, 0) && this.util.bcgt(data.tick2_24hr_price, 0))
            tick2_change = this.util.bcmul(this.util.bcdiv(this.util.bcsub(data.tick2_price, data.tick2_24hr_price,8), data.tick2_24hr_price,8), 100, 2);
        data.tick1_24hr_change = tick1_change;
        data.tick2_24hr_change = tick2_change;
        // Sort the market data object 
        data = this.util.ksort(data);
        return data;
    }

    // Update market information for a given market_id
    async updateMarketInfo(data){
        let market_id    = data.market_id;
        let tick1_price       = data.tick1_price;
        let tick1_bid         = data.tick1_bid;
        let tick1_ask         = data.tick1_ask;
        let tick1_24hr_price  = data.tick1_24hr_price;
        let tick1_24hr_high   = data.tick1_24hr_high;
        let tick1_24hr_low    = data.tick1_24hr_low;
        let tick1_24hr_change = data.tick1_24hr_change;
        let tick1_24hr_volume = data.tick1_24hr_volume;
        let tick2_price       = data.tick2_price;
        let tick2_bid         = data.tick2_bid;
        let tick2_ask         = data.tick2_ask;
        let tick2_24hr_price  = data.tick2_24hr_price;
        let tick2_24hr_high   = data.tick2_24hr_high;
        let tick2_24hr_low    = data.tick2_24hr_low;
        let tick2_24hr_change = data.tick2_24hr_change;
        let tick2_24hr_volume = data.tick2_24hr_volume;
        let last_updated      = data.last_updated;
        let query = `UPDATE 
                        markets
                    SET
                        tick1_price=?,
                        tick1_bid=?,
                        tick1_ask=?,
                        tick1_24hr_price=?,
                        tick1_24hr_high=?,
                        tick1_24hr_low=?,
                        tick1_24hr_change=?,
                        tick1_24hr_volume=?,
                        tick2_price=?,
                        tick2_bid=?,
                        tick2_ask=?,
                        tick2_24hr_price=?,
                        tick2_24hr_high=?,
                        tick2_24hr_low=?,
                        tick2_24hr_change=?,
                        tick2_24hr_volume=?,
                        last_updated=?
                    WHERE
                        id=?`;
        let args    = [tick1_price, tick1_bid, tick1_ask, tick1_24hr_price, tick1_24hr_high, tick1_24hr_low, tick1_24hr_change, tick1_24hr_volume, tick2_price, tick2_bid, tick2_ask, tick2_24hr_price, tick2_24hr_high, tick2_24hr_low, tick2_24hr_change, tick2_24hr_volume, last_updated, market_id];
        let results = await this.doQuery(query, args);
    }

    // Handle finding and updating markets
    async updateMarkets(markets, block_index){
        let block_time = await this.getBlockTime(block_index);
        await Promise.all(markets.map(async (pair) => {
            let market_id = await this.getMarketId(pair.tick1_id, pair.tick2_id);
            if(market_id){
                let data = await this.getMarketInfo(market_id, block_time);
                await this.updateMarketInfo(data);
            }
        }));
    }


    // Create/Update record in `dispenses` table
    async createDispense(data){
        data                       = this.normalizeDataValues(data);
        let give_coin_id           = await this.createCoin(data['GIVE_COIN']);
        let give_tick_id           = await this.createTicker(data['GIVE_TICK']);
        let get_coin_id            = await this.createCoin(data['GET_COIN']);
        let get_tick_id            = await this.createTicker(data['GET_TICK']);
        let destination_id         = await this.createAddress(data['DESTINATION']);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let give_amount            = data['GIVE_AMOUNT'];
        let get_amount             = data['GET_AMOUNT'];
        let dispenser_action_index = data['DISPENSER_ACTION_INDEX'];
        // Check if record already exists for this dispenser
        let query  = `SELECT
                            action_index
                        FROM
                            dispenses
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispenses
                    SET
                        dispenser_action_index=?,
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        destination_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenses (dispenser_action_index, give_coin_id, give_tick_id, give_amount, get_coin_id, get_tick_id, get_amount, destination_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [dispenser_action_index, give_coin_id, give_tick_id, give_amount, get_coin_id, get_tick_id, get_amount, destination_id, status_id, action_index];
        results = await this.doQuery(query, args);
    }    

    // Create/Update record in `dispensers` table
    async createDispenser(data){
        data                  = this.normalizeDataValues(data);
        let give_coin_id      = await this.createCoin(data['GIVE_COIN']);
        let give_tick_id      = await this.createTicker(data['GIVE_TICK']);
        let get_coin_id       = await this.createCoin(data['GET_COIN']);
        let get_tick_id       = await this.createTicker(data['GET_TICK']);
        let get_address_id    = await this.createAddress(data['GET_ADDRESS']);
        let fiat_id           = await this.createFiat(data['FIAT_CODE']);
        let oracle_address_id = (!this.util.isNull(data['ORACLE_ADDRESS'])) ? await this.createAddress(data['ORACLE_ADDRESS']) : null;
        let memo_id           = await this.createMemo(data['MEMO']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let give_amount       = data['GIVE_AMOUNT'];
        let get_amount        = data['GET_AMOUNT'];
        let give_escrow       = data['GIVE_ESCROW'];
        let give_ownership    = (data['GIVE_OWNERSHIP']==1) ? 1 : 0;
        let fiat_amount       = data['FIAT_AMOUNT'];
        let expiration        = data['EXPIRATION'];
        let allow_list        = data['ALLOW_LIST'];
        let block_list        = data['BLOCK_LIST'];
        // Check if record already exists for this dispenser
        let query  = `SELECT
                            action_index
                        FROM
                            dispensers
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispensers
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        give_escrow=?,
                        give_ownership=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_address_id=?,
                        fiat_id=?,
                        fiat_amount=?,
                        oracle_address_id=?,
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
            args = [give_coin_id, give_tick_id, give_amount, give_escrow, give_ownership, get_coin_id, get_tick_id, get_amount, get_address_id, fiat_id, fiat_amount, oracle_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO dispensers (give_coin_id, give_tick_id, give_amount, give_escrow, give_ownership, get_coin_id, get_tick_id, get_amount, get_address_id, fiat_id, fiat_amount, oracle_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [give_coin_id, give_tick_id, give_amount, give_escrow, give_ownership, get_coin_id, get_tick_id, get_amount, get_address_id, fiat_id, fiat_amount, oracle_address_id, expiration, allow_list, block_list, memo_id, status_id, action_index];
        }
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `dispenser_statuses` table
    // @param {action_index}            integer Action index of action
    // @param {dispenser_action_index}  integer Action index of dispenser
    // @param {status}                  string  Status of the referenced dispenser (open/complete/closing/cancelled/expired)
    // @param {cancelled_by}            string  (optional) Address that triggered the cancel — recorded for the 'cancelling' status so dispenser_close can route escrow correctly
    async createDispenserStatus(action_index, dispenser_action_index, status, cancelled_by){
        // Normalize data
        let status_id       = await this.createStatus(status);
        let cancelled_by_id = (!this.util.isNull(cancelled_by)) ? await this.createAddress(cancelled_by) : null;
        // Check if record already exists for this in order_statuses table
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_statuses
                        WHERE
                            action_index=? AND
                            dispenser_action_index=?`;
        let args = [action_index, dispenser_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispenser_statuses
                    SET
                        status_id=?,
                        cancelled_by_id=?
                    WHERE
                        action_index=? AND
                        dispenser_action_index=?`;
            args = [status_id, cancelled_by_id, action_index, dispenser_action_index];
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_statuses (status_id, cancelled_by_id, action_index, dispenser_action_index) values (?, ?, ?, ?)`;
            args  = [status_id, cancelled_by_id, action_index, dispenser_action_index];
        }
        results = await this.doQuery(query, args);
    }

    // Return dispenser info for given action_index
    async getDispenserInfo(coin, action_index, block_time){
        let dispenser = false;
        let query = `SELECT
                        d1.action_index,
                        t2.tick as give_tick,
                        d1.give_amount,
                        d1.give_ownership,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        d1.get_amount,
                        d1.give_escrow,
                        a2.address as source,
                        a3.address as get_address,
                        d1.expiration,
                        d1.allow_list,
                        d1.block_list,
                        f1.code as fiat,
                        d1.fiat_amount,
                        a4.address as oracle_address,
                        m1.memo,
                        s2.status,
                        s3.status as dispenser_status,
                        b1.block_index,
                        b1.block_time
                    FROM
                        dispensers d1
                        INNER JOIN actions             a1 ON (a1.action_index=d1.action_index)
                        INNER JOIN transactions        t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks              b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses     a2 ON (a2.id=a1.source_id)
                        INNER JOIN index_addresses     a3 ON (a3.id=d1.get_address_id)
                        LEFT  JOIN index_addresses     a4 ON (a4.id=d1.oracle_address_id)
                        INNER JOIN index_tickers       t2 ON (t2.id=d1.give_tick_id)
                        LEFT  JOIN index_tickers       t3 ON (t3.id=d1.get_tick_id)
                        INNER JOIN index_coins         c1 ON (c1.id=d1.get_coin_id)
                        LEFT  JOIN index_memos         m1 ON (m1.id=d1.memo_id)
                        LEFT  JOIN index_fiats         f1 ON (f1.id=d1.fiat_id)
                        INNER JOIN dispenser_statuses  s1 ON (s1.dispenser_action_index=d1.action_index)
                        INNER JOIN index_statuses      s2 ON (s2.id=d1.status_id)
                        INNER JOIN index_statuses      s3 ON (s3.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s4.action_index)
                            FROM
                                dispenser_statuses s4
                            WHERE
                                s4.dispenser_action_index=d1.action_index
                        ) AND
                        c1.coin=? AND
                        d1.action_index=?
                    LIMIT 1`;
        let args  = [coin, action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            dispenser = {};
            dispenser['GIVE_COIN'] = this.config['COIN'];
            for(let key in results[0]){
                let name  = String(key).toUpperCase()
                let value = results[0][key];
                if(['ACTION_INDEX', 'BLOCK_INDEX', 'BLOCK_TIME', 'EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST', 'GIVE_OWNERSHIP'].includes(name))
                    value = Number(value);
                dispenser[name] = value;
            }
        }
        // Get additional information on this order
        if(dispenser){
            // Get updated dispenser properties from the dispenser_edits table
            let edit = await this.getDispenserEdits(action_index, block_time);
            if(edit.expiration)
                dispenser['EXPIRATION'] = edit.expiration;
            if(edit.allow_list)
                dispenser['ALLOW_LIST'] = edit.allow_list;
            if(edit.block_list)
                dispenser['BLOCK_LIST'] = edit.block_list;
            // Ownership dispensers expose virtual '1' for GIVE_AMOUNT / GIVE_ESCROW so the
            // matching engine and dispense flow can compare amounts uniformly. Settlement
            // code branches on GIVE_OWNERSHIP rather than the synthetic amount.
            if(dispenser['GIVE_OWNERSHIP'] == 1){
                if(this.util.isNull(dispenser['GIVE_AMOUNT']))  dispenser['GIVE_AMOUNT']  = '1';
                if(this.util.isNull(dispenser['GIVE_ESCROW'])) dispenser['GIVE_ESCROW'] = '1';
                // Virtual remaining: 1 if no dispense yet, 0 once dispensed (single-shot).
                // getDispenserAmountRemaining returns 0 for a fresh ownership dispenser
                // (give_escrow is null in the DB) and goes negative after a successful
                // DISPENSE has been recorded with give_amount='1'.
                let dispensed = await this.getDispenserAmountRemaining(action_index);
                dispenser['GIVE_REMAINING'] = this.util.bclt(dispensed, 0) ? '0' : '1';
            } else {
                // Determine dispenser amounts remaining
                dispenser['GIVE_REMAINING'] = await this.getDispenserAmountRemaining(action_index);
            }
        }
        return dispenser;
    }

    // Create/Update record in `dispenser_edits` table
    async createDispenserEdit(data){
        data                       = this.normalizeDataValues(data);
        let memo_id                = await this.createMemo(data['MEMO']);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let dispenser_action_index = data['DISPENSER_ACTION_INDEX'];
        let give_escrow            = data['GIVE_ESCROW'];
        let expiration             = data['EXPIRATION'];
        let allow_list             = data['ALLOW_LIST'];
        let block_list             = data['BLOCK_LIST'];
        // Check if record already exists for this dispenser_edits
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_edits
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispenser_edits
                    SET
                        give_escrow=?,
                        expiration=?,
                        allow_list=?,
                        block_list=?,
                        memo_id=?,
                        status_id=?,
                        dispenser_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_edits (give_escrow, expiration, allow_list, block_list, memo_id, status_id, dispenser_action_index, action_index) values (?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [give_escrow, expiration, allow_list, block_list, memo_id, status_id, dispenser_action_index, action_index];
        results = await this.doQuery(query, args);
    }

    // Return dispenser edit information for given action_index
    async getDispenserEdits(action_index, block_time){
        // Define empty edit object
        let edit  = {
            give_escrow: 0,
            expiration: false,
            allow_list: false,
            block_list: false
        };
        let query  = `SELECT 
                        e1.give_escrow,
                        e1.expiration,
                        e1.allow_list,
                        e1.block_list,
                        b1.block_time
                    FROM 
                        dispenser_edits e1
                        INNER JOIN actions        a1 ON (a1.action_index=e1.action_index)
                        INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN index_statuses s1 ON (s1.id=e1.status_id)
                    WHERE 
                        e1.dispenser_action_index=? AND
                        s1.status=?
                    ORDER BY
                        e1.action_index ASC`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                // refilling dispensers and updating expiration are immediately active
                if(!this.util.isNull(row.give_escrow)) 
                    edit.give_escrow = this.util.bcadd(edit.give_escrow, row.give_escrow);
                if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration))   
                    edit.expiration  = Number(row.expiration);
                // Determine if the list edits are active or not
                let active = this.util.bcgt(block_time, this.util.bcadd(row.block_time, this.config['DISPENSER_LIST_DELAY']));
                if(active){
                    if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list))   
                        edit.allow_list  = Number(row.allow_list);
                    if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list))   
                        edit.block_list  = Number(row.block_list);
                }
            }
        }
        return edit;
    }

    // Create/Update record in `dispenser_closes` table
    async createDispenserClose(data){
        data                       = this.normalizeDataValues(data);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let dispenser_action_index = data['DISPENSER_ACTION_INDEX'];
        // Check if record already exists for this in dispenser_closes
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_closes
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispenser_closes
                    SET
                        status_id=?,
                        dispenser_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_closes (status_id, dispenser_action_index, action_index) values (?, ?, ?)`;
        }
        args    = [status_id, dispenser_action_index, action_index];
        results = await this.doQuery(query, args);
    }

    // Create/Update record in `dispenser_cancels` table
    async createDispenserCancel(data){
        data                       = this.normalizeDataValues(data);
        let memo_id                = await this.createMemo(data['MEMO']);
        let status_id              = await this.createStatus(data['STATUS']);
        let action_index           = data['ACTION_INDEX'];
        let dispenser_action_index = data['DISPENSER_ACTION_INDEX'];
        // Check if record already exists for this in dispenser_cancels
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_cancels
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispenser_cancels
                    SET
                        memo_id=?,
                        status_id=?,
                        dispenser_action_index=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_cancels (memo_id, status_id, dispenser_action_index, action_index) values (?, ?, ?, ?)`;
        }
        args    = [memo_id, status_id, dispenser_action_index, action_index];
        results = await this.doQuery(query, args);
    }

    // Handle getting total escrowed and available in a dispenser for a given action_index
    async getDispenserAmountRemaining(action_index){
        let remaining = 0;
        // Get initial amounts from the dispensers table
        let query  = `SELECT 
                        d.give_escrow
                    FROM 
                        dispensers d
                        INNER JOIN index_statuses s ON (s.id=d.status_id)
                    WHERE 
                        d.action_index=? AND
                        s.status=?`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            remaining = results[0].give_escrow;
        // Get any amounts added to escrow via edits and add to remaining
        query = `SELECT 
                    d.give_escrow
                FROM 
                    dispenser_edits d
                    INNER JOIN index_statuses s ON (s.id=d.status_id)
                WHERE 
                    d.dispenser_action_index=? AND
                    s.status=?
                ORDER BY
                    d.action_index ASC`;
        results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.give_escrow))
                    remaining = this.util.bcadd(remaining, row.give_escrow, 64);
            }
        }
        // Lookup amounts paid out already from dispenses table
        query = `SELECT
                    d.give_amount
                FROM
                    dispenses d
                    INNER JOIN index_statuses s ON (s.id=d.status_id)
                WHERE
                    d.dispenser_action_index=?  AND
                    s.status=?
                ORDER BY action_index ASC`;
        args = [action_index, 'valid'];
        results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.give_amount))
                    remaining = this.util.bcsub(remaining, row.give_amount, 64);
            }
        }
        return remaining;
    }

    // Lookup items that need to be cancelled and return a list
    async findCancelledDispensers(block_time){
        let cancels = [];
        // Find dispensers where latest status is 'cancelling`
        let args  = [];
        let query = `SELECT 
                        m.action_index,
                        b1.block_time
                    FROM 
                        dispensers m
                        INNER JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=m.action_index)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    WHERE 
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                dispenser_statuses s3
                            WHERE
                                s3.dispenser_action_index=m.action_index
                        ) AND
                        s2.status='cancelling'
                    ORDER BY m.action_index ASC`
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results)
                if(this.util.bcgt(block_time, this.util.bcadd(row.block_time, this.config['DISPENSER_CLOSE_DELAY'])))
                    cancels.push(Number(row.action_index));
        }
        return cancels;
    }

    // Create/Update record in `order_expires` table
    // @param {action_index}          integer Action index of action
    // @param {dispenser_action_tick} integer Action index of dispenser
    // @param {status}                string  Status of the expire (valid/invalid)
    async createDispenserExpire(action_index, dispenser_action_index, status){
        // Normalize data
        let status_id = await this.createStatus(status);
        // Check if record already exists for this in order_expires table
        let query  = `SELECT
                            action_index
                        FROM
                            dispenser_expires
                        WHERE
                            action_index=? AND
                            dispenser_action_index=?`;
        let args = [action_index, dispenser_action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        dispenser_expires
                    SET
                        status_id=?
                    WHERE 
                        action_index=? AND
                        dispenser_action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO dispenser_expires (status_id, action_index, dispenser_action_index) values (?, ?, ?)`;
        }
        args    = [status_id, action_index, dispenser_action_index];
        results = await this.doQuery(query, args);
    }

    // Handle finding any sends to an address with active dispenser(s)
    async findDispenserSends(action_index){
        let sends = [];
        let query  = `SELECT
                            a2.address as source,
                            a3.address as destination,
                            c1.coin,
                            t2.tick,
                            s1.amount
                        FROM
                            sends s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN dispensers         d1 ON (d1.get_address_id=s1.destination_id)
                            INNER JOIN dispenser_statuses s2 ON (s2.dispenser_action_index=d1.action_index)
                            INNER JOIN index_statuses     s3 ON (s3.id=s1.status_id)
                            INNER JOIN index_statuses     s4 ON (s4.id=s2.status_id)
                            INNER JOIN index_addresses    a2 ON (a2.id=a1.source_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=s1.destination_id)
                            INNER JOIN index_tickers      t2 ON (t2.id=s1.tick_id)
                            INNER JOIN index_coins        c1 ON (c1.id=d1.get_coin_id)
                        WHERE
                            s2.action_index = (
                                SELECT
                                    MAX(s5.action_index)
                                FROM
                                    dispenser_statuses s5
                                WHERE
                                    s5.dispenser_action_index=d1.action_index
                            ) AND
                            s3.status='valid' AND 
                            s4.status IN ('open', 'cancelling') AND 
                            s1.tick_id=d1.get_tick_id AND
                            s1.amount >= d1.get_amount AND
                            s1.action_index=?
                        GROUP BY s1.action_index`;
        let args = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            sends = results;
        return sends;
    }

    // Handle finding any open dispensers for a given coin/tick/amount/destination combination
    async findMatchingDispensers(data){
        let dispensers = [];
        // Normalize data
        let coin_id        = await this.createCoin(data['COIN']);
        let tick_id        = await this.createTicker(data['COIN_TICK']);
        let destination_id = await this.createAddress(data['COIN_DESTINATION']);
        let coin_amount    = this.util.bcnum(data['COIN_AMOUNT']);
        let args           = [coin_id, destination_id];
        let where          = '';
        let dispenses      = [];
        // Include the ticker in the query if we have one
        if(!this.util.isNull(tick_id)){
            where = ' AND d1.get_tick_id=?';
            args.push(tick_id);
        }
        let query  = `SELECT
                            d1.action_index,
                            d1.get_amount,
                            d1.fiat_id
                        FROM
                            dispensers d1
                            INNER JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=d1.action_index)
                            INNER JOIN index_statuses     s2 ON (s2.id=d1.status_id)
                            INNER JOIN index_statuses     s3 ON (s3.id=s1.status_id)
                        WHERE
                            s1.action_index = (
                                SELECT
                                    MAX(s4.action_index)
                                FROM
                                    dispenser_statuses s4
                                WHERE
                                    s4.dispenser_action_index=s1.action_index
                            ) AND
                            s2.status='valid' AND
                            s3.status IN ('open', 'cancelling') AND
                            d1.get_coin_id=? AND
                            d1.get_address_id=?` + where + `
                        ORDER BY d1.action_index ASC`;
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                // FIAT dispensers: include regardless of coin_amount (matching happens in dispense.js via reverse price lookup)
                // Non-FIAT dispensers: only include if coin_amount >= get_amount
                if(!this.util.isNull(row.fiat_id) || this.util.bcgte(coin_amount, row.get_amount))
                    dispensers.push(Number(row.action_index));
            }
        }
        return dispensers;
    }


    // Return the address recorded as the canceller for a dispenser's most recent
    // 'cancelling' status row, or null if there isn't one. Used by dispenser_close
    // to route escrow per DISPENSER.md (canceller == GET_ADDRESS → escrow to GET_ADDRESS;
    // canceller == SOURCE → escrow to SOURCE).
    async getDispenserCanceller(action_index){
        let address = null;
        let query = `SELECT
                        a1.address
                    FROM
                        dispenser_statuses s1
                        INNER JOIN index_addresses a1 ON (a1.id=s1.cancelled_by_id)
                    WHERE
                        s1.dispenser_action_index=? AND
                        s1.cancelled_by_id IS NOT NULL
                    ORDER BY
                        s1.action_index DESC
                    LIMIT 1`;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0)
            address = results[0].address;
        return address;
    }

    // Return the SWEEP DESTINATION address if the most recent 'cancelling' status
    // row on the given order_action_index was triggered by a SWEEP, else null.
    // Used by coinpay.js / coinpay_expire.js to route residual escrow (or ownership)
    // to the sweeper's DESTINATION rather than the order's original SOURCE.
    async getOrderSweepDestination(order_action_index){
        let address = null;
        let query = `SELECT
                        a1.address
                    FROM
                        order_statuses    s1
                        INNER JOIN index_statuses   s2 ON (s2.id=s1.status_id)
                        INNER JOIN sweeps           sw ON (sw.action_index=s1.action_index)
                        INNER JOIN index_statuses   s3 ON (s3.id=sw.status_id)
                        INNER JOIN index_addresses  a1 ON (a1.id=sw.destination_id)
                    WHERE
                        s1.order_action_index=? AND
                        s2.status='cancelling' AND
                        s3.status='valid'
                    ORDER BY
                        s1.action_index DESC
                    LIMIT 1`;
        let results = await this.doQuery(query, [order_action_index]);
        if(results.length > 0)
            address = results[0].address;
        return address;
    }

    // Handle getting the sweep destination address for a given dispenser action_index
    async getSweepDestination(action_index){
        let address = null;
        // Normalize data
        let query  = `SELECT
                            a1.address
                        FROM
                            dispensers d1
                            INNER JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=d1.action_index)
                            LEFT  JOIN sweeps             s2 ON (s2.action_index=s1.action_index)
                            LEFT  JOIN index_addresses    a1 ON (a1.id=s2.destination_id)
                            LEFT  JOIN index_statuses     s3 ON (s3.id=s2.status_id)
                        WHERE
                            s1.action_index = (
                                SELECT
                                    MAX(s4.action_index)
                                FROM
                                    dispenser_statuses s4
                                WHERE
                                    s4.dispenser_action_index=d1.action_index
                            ) AND
                            d1.action_index=? AND
                            s3.status='valid'
                        ORDER BY 
                            d1.action_index ASC
                        LIMIT 1`;
        let args = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results)
                address = row.address;
        }
        return address;
    }

    /*
     * Pubkeys table methods (address → pubkey mapping)
     */

    // Store an address_id → pubkey mapping in the pubkeys table (idempotent)
    async createPubkey(address_id, pubkey){
        if(!address_id || !pubkey) return;
        let query = "INSERT IGNORE INTO pubkeys (address_id, pubkey) VALUES (?, ?)";
        await this.doQuery(query, [address_id, String(pubkey)]);
    }

    /*
     * Pubkey index methods (index_pubkeys table)
     */

    // Get pubkey id from index_pubkeys table
    async getPubkeyId(pubkey){
        let id    = null;
        let query = "SELECT id FROM index_pubkeys WHERE `pubkey`=? LIMIT 1";
        let results = await this.doQuery(query, [pubkey]);
        if(results.length > 0)
            id = Number(results[0].id);
        return id;
    }

    // Create record in index_pubkeys table and return record id
    async getOrCreatePubkeyId(pubkey){
        // Ignore empty pubkey and return NULL
        if(this.util.isNull(pubkey))
            return null;
        // Normalize to lowercase hex
        pubkey = String(pubkey).toLowerCase().substring(0, 64);
        let id = await this.getPubkeyId(pubkey);
        // Create pubkey if it does not already exist
        if(id === null){
            // INSERT IGNORE + refetch is race-safe against the UNIQUE index.
            let query   = "INSERT IGNORE INTO index_pubkeys (`pubkey`) values (?)";
            await this.doQuery(query, [pubkey]);
            id = await this.getPubkeyId(pubkey);
        }
        return id;
    }

    /*
     * Staking action methods
     */

    // Create/Update record in `stakes` table.
    // Capability model: each STAKE action (v1 create or v2 top-up) gets its own row.
    // Active stake amount for a pubkey is SUM(amount) across all valid rows.
    async createStake(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let action_index      = data['ACTION_INDEX'];
        let version           = data['VERSION'] || 1;
        let amount            = data['AMOUNT'] || '0';
        let block_index       = data['BLOCK_INDEX'];
        let activation_block  = data['ACTIVATION_BLOCK'] || 0;
        // Check if record already exists
        let query  = "SELECT action_index FROM stakes WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE stakes SET
                        source_id=?, version=?, signing_pubkey_id=?,
                        amount=?, status_id=?, block_index=?, activation_block=?
                    WHERE action_index=?`;
            args = [source_id, version, signing_pubkey_id, amount, status_id, block_index, activation_block, action_index];
        } else {
            query = `INSERT INTO stakes
                        (source_id, version, signing_pubkey_id, amount, status_id, block_index, activation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, version, signing_pubkey_id, amount, status_id, block_index, activation_block, action_index];
        }
        await this.doQuery(query, args);
    }

    // Set deactivation_block for ALL active stake rows owned by the given pubkey.
    // Used by createUnstake to mark when all of a pubkey's stake (original + top-ups) should be removed from the active set.
    async setStakeDeactivationByPubkey(pubkey, deactivationBlock){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return false;
        let valid_id = await this.getStatusId('valid');
        let query = `UPDATE stakes SET deactivation_block=?
                     WHERE signing_pubkey_id=? AND status_id=? AND deactivation_block IS NULL`;
        await this.doQuery(query, [deactivationBlock, pubkey_id, valid_id]);
        return true;
    }

    // Create/Update record in `unstakes` table
    async createUnstake(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let action_index      = data['ACTION_INDEX'];
        let cooldown_end_block = data['COOLDOWN_END_BLOCK'];
        let amount            = data['AMOUNT'] || '0';
        let block_index       = data['BLOCK_INDEX'];
        // Check if record already exists
        let query  = "SELECT action_index FROM unstakes WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE unstakes SET
                        source_id=?, signing_pubkey_id=?, cooldown_end_block=?,
                        amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, cooldown_end_block, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO unstakes
                        (source_id, signing_pubkey_id, cooldown_end_block, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, cooldown_end_block, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    }

    // Create/Update record in `delegations` table
    async createDelegation(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let action_index      = data['ACTION_INDEX'];
        let block_index       = data['BLOCK_INDEX'];
        let activation_block  = data['ACTIVATION_BLOCK'] || 0;
        // Check if record already exists
        let query  = "SELECT action_index FROM delegations WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE delegations SET
                        source_id=?, signing_pubkey_id=?, status_id=?, block_index=?, activation_block=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, status_id, block_index, activation_block, action_index];
        } else {
            query = `INSERT INTO delegations
                        (source_id, signing_pubkey_id, status_id, block_index, activation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, status_id, block_index, activation_block, action_index];
        }
        await this.doQuery(query, args);
    }

    // Create record in `delegations` table with 'revoked' status
    async createRevokeDelegation(data){
        // Set status to reflect revocation intent, then create as normal delegation record
        await this.createDelegation(data);
    }

    // Set the deactivation_block for an active delegation
    // Used by createRevokeDelegation flow to mark when the delegation should be removed
    async setDelegationDeactivation(source, pubkey, deactivationBlock){
        let source_id = await this.getAddressId(source);
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(source_id === null || pubkey_id === null) return false;
        let valid_id = await this.getStatusId('valid');
        let query = `UPDATE delegations SET deactivation_block=?
                     WHERE source_id=? AND signing_pubkey_id=? AND status_id=? AND deactivation_block IS NULL`;
        await this.doQuery(query, [deactivationBlock, source_id, pubkey_id, valid_id]);
        return true;
    }

    // Create record in `reward_claims` table
    // Create a validator reward record (called when hub pushes rewards to indexer)
    // pubkeyHex: 64-char hex Ed25519 signing pubkey of the validator that earned the reward
    // roundReference: round number (oracle_round) or attestation index
    // rewardType: 'oracle_round' or 'cross_chain_attestation'
    // amount: reward amount as decimal string
    // blockIndex: block height when the reward was earned
    async createValidatorReward(pubkeyHex, roundReference, rewardType, amount, blockIndex){
        // Look up the source address that owns this signing pubkey via the stakes table
        let pubkey_id = await this.getPubkeyId(String(pubkeyHex).toLowerCase());
        if(pubkey_id === null){
            console.warn('createValidatorReward: unknown pubkey ' + pubkeyHex);
            return false;
        }
        // Find the most recent active stake using this pubkey to determine source_id
        let query = `SELECT source_id FROM stakes WHERE signing_pubkey_id=? ORDER BY action_index DESC LIMIT 1`;
        let results = await this.doQuery(query, [pubkey_id]);
        if(results.length === 0){
            console.warn('createValidatorReward: no stake found for pubkey ' + pubkeyHex);
            return false;
        }
        let source_id = results[0].source_id;
        // Insert the reward (idempotent via UNIQUE INDEX on source_id+signing_pubkey_id+reward_type+round_reference)
        query = `INSERT IGNORE INTO validator_rewards
                    (source_id, signing_pubkey_id, reward_type, round_reference, amount, block_index)
                 VALUES (?, ?, ?, ?, ?, ?)`;
        let args = [source_id, pubkey_id, rewardType, roundReference, amount, blockIndex];
        await this.doQuery(query, args);
        return true;
    }

    async createRewardClaim(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let source_id    = await this.getAddressId(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        let amount       = data['AMOUNT'] || '0';
        let block_index  = data['BLOCK_INDEX'];
        // Check if record already exists
        let query  = "SELECT action_index FROM reward_claims WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE reward_claims SET
                        source_id=?, amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [source_id, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO reward_claims
                        (source_id, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?)`;
            args = [source_id, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    }

    /*
     * Staking query methods
     */

    // Get active stake for a source address (existence/source check; returns any one of the source's active stake rows).
    // blockIndex enforces the 6-block activation/deactivation delay for BTC reorg safety.
    async getActiveStakeBySource(source, blockIndex){
        let source_id = await this.getAddressId(source);
        if(source_id === null)
            return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT
                        s.*, ip.pubkey as signing_pubkey
                    FROM stakes s
                        LEFT JOIN index_pubkeys ip ON (ip.id=s.signing_pubkey_id)
                    WHERE s.source_id=? AND s.status_id=?`;
        let args = [source_id, valid_id];
        if(blockIndex !== undefined && blockIndex !== null){
            query += ' AND s.activation_block <= ? AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)';
            args.push(blockIndex);
            args.push(blockIndex);
        }
        query += ' ORDER BY s.action_index DESC LIMIT 1';
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            return results[0];
        return null;
    }

    // Count distinct active validators (by pubkey) qualified for the given capability.
    // Used for PBFT quorum calculation: quorum = 2 * floor((N - 1) / 3) + 1.
    async getActiveCapabilityCount(capability, blockIndex, minStakeOverride){
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        let capConfig = caps[capability];
        if(!capConfig) return 0;
        // A caller-supplied threshold takes precedence over this indexer's local
        // config (see getValidatorsByCapability). Internal block-processing callers
        // omit it and get the local fallback unchanged.
        let minStake = (minStakeOverride !== undefined && minStakeOverride !== null)
            ? String(minStakeOverride)
            : (capConfig['MIN_STAKE'] || '0');
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT COUNT(*) AS cnt FROM (
                        SELECT signing_pubkey_id, SUM(CAST(amount AS DECIMAL(30,8))) AS total
                        FROM stakes
                        WHERE status_id=?`;
        let args = [valid_id];
        if(blockIndex !== undefined && blockIndex !== null){
            query += ' AND activation_block <= ? AND (deactivation_block IS NULL OR deactivation_block > ?)';
            args.push(blockIndex);
            args.push(blockIndex);
        }
        query += `   GROUP BY signing_pubkey_id
                     HAVING total >= ?
                  ) AS qualified`;
        args.push(minStake);
        let results = await this.doQuery(query, args);
        return results.length > 0 ? Number(results[0].cnt) : 0;
    }

    // Create/Update record in `prices` table (PRICE action log)
    // Stores the raw on-chain PRICE action data; the hub aggregates these into price_snapshots/oracle_prices
    async createPrice(data){
        data                = this.normalizeDataValues(data);
        let status_id       = await this.createStatus(data['STATUS']);
        let source_id       = await this.getAddressId(data['SOURCE']);
        let action_index    = data['ACTION_INDEX'];
        let version         = data['VERSION'];
        let validation      = data['VALIDATION_STATUS'] || 'pending';
        // v0 fields
        let round_number    = data['ROUND'] || null;
        let round_timestamp = data['TIMESTAMP'] || null;
        let pair_count      = data['PAIR_COUNT'] || null;
        let pairs_json      = data['PAIRS_JSON'] || null;
        let sig_count       = data['SIG_COUNT'] || null;
        let sigs_json       = data['SIGS_JSON'] || null;
        // v1 fields
        let coin_id         = (data['V1_COIN'])  ? await this.createCoin(data['V1_COIN'])     : null;
        let tick_id         = (data['V1_TICK'])  ? await this.createTicker(data['V1_TICK'])   : null;
        let fiat_id         = (data['V1_FIAT'])  ? await this.createFiat(data['V1_FIAT'])     : null;
        let value           = data['V1_VALUE'] || null;
        let fee             = data['V1_FEE']   || null;
        let memo_id         = (data['MEMO'])     ? await this.createMemo(data['MEMO'])         : null;
        // Check if record exists (idempotent for retries)
        let query   = "SELECT action_index FROM prices WHERE action_index=? LIMIT 1";
        let args    = [action_index];
        let exists  = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE prices SET
                        version=?, source_id=?, round_number=?, round_timestamp=?,
                        pair_count=?, pairs_json=?, sig_count=?, sigs_json=?,
                        coin_id=?, tick_id=?, fiat_id=?, value=?, fee=?, memo_id=?,
                        validation_status=?, status_id=?
                    WHERE action_index=?`;
            args = [version, source_id, round_number, round_timestamp,
                    pair_count, pairs_json, sig_count, sigs_json,
                    coin_id, tick_id, fiat_id, value, fee, memo_id,
                    validation, status_id, action_index];
        } else {
            query = `INSERT INTO prices
                        (version, source_id, round_number, round_timestamp,
                         pair_count, pairs_json, sig_count, sigs_json,
                         coin_id, tick_id, fiat_id, value, fee, memo_id,
                         validation_status, status_id, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [version, source_id, round_number, round_timestamp,
                    pair_count, pairs_json, sig_count, sigs_json,
                    coin_id, tick_id, fiat_id, value, fee, memo_id,
                    validation, status_id, action_index];
        }
        await this.doQuery(query, args);
    }

    /*
     * Hub push retry queue (`pending_hub_pushes`)
     *
     * Durable backing for best-effort hub pushes (PRICE v0 round / PRICE v1
     * oracle price). When a live push fails, the payload is parked here and the
     * HubPushQueue poller drains it later with exponential backoff.
     *
     * These methods deliberately bypass doQuery()/getConnection(): the poller
     * runs concurrently with block processing on this same `indexerDb` instance,
     * and getConnection() returns the open block's `transactionConnection` while
     * a block is being processed. Routing queue writes through it would attach
     * operational queue I/O to the block's ACID transaction (committed/rolled
     * back with the block) and risk two statements sharing one physical
     * connection. _poolQuery() always draws an independent pooled connection.
     */

    // Run a query on a fresh pooled connection, isolated from any in-progress
    // block transaction. Always releases the connection.
    async _poolQuery(query, args){
        let conn = await this.pool.getConnection();
        try {
            return await conn.query(query, args);
        } finally {
            await conn.release();
        }
    }

    // Park a failed hub push for later retry. `payload` is the exact argument
    // object the HubClient method expects; it is serialized to JSON. The source
    // action_index is lifted out into its own column so a reorg can purge queued
    // pushes for orphaned actions via the rollback dataTables loop.
    async enqueueHubPush(pushType, payload){
        let actionIndex = (payload && payload.action_index != null) ? payload.action_index : 0;
        let query = `INSERT INTO pending_hub_pushes (push_type, action_index, payload, status, attempts, created_at)
                     VALUES (?, ?, ?, 'pending', 0, NOW())`;
        await this._poolQuery(query, [pushType, actionIndex, JSON.stringify(payload)]);
    }

    // Fetch the oldest pending rows for the poller to consider (it applies the
    // per-row backoff gate in JS). `failed` rows are excluded — they are
    // terminal.
    async getPendingHubPushes(limit){
        let max = Number(limit);
        if(!Number.isFinite(max) || max <= 0) max = 50;
        let query = `SELECT id, push_type, payload, attempts, last_attempted_at, status
                     FROM pending_hub_pushes
                     WHERE status='pending'
                     ORDER BY id ASC
                     LIMIT ?`;
        return await this._poolQuery(query, [max]);
    }

    // Drop a row once the hub has accepted it (delivered rows aren't retained).
    async markHubPushDelivered(id){
        await this._poolQuery('DELETE FROM pending_hub_pushes WHERE id=?', [id]);
    }

    // Record a failed delivery attempt: bump the counter, stamp the time, keep
    // the last error, and retire the row to `failed` once it hits maxAttempts so
    // the queue stays bounded.
    async recordHubPushAttempt(id, errMsg, maxAttempts){
        let max = Number(maxAttempts);
        if(!Number.isFinite(max) || max <= 0) max = 10;
        let query = `UPDATE pending_hub_pushes
                     SET attempts = attempts + 1,
                         last_attempted_at = NOW(),
                         last_error = ?,
                         status = IF(attempts + 1 >= ?, 'failed', 'pending')
                     WHERE id = ?`;
        await this._poolQuery(query, [errMsg, max, id]);
    }

    // Get aggregate active stake info for a pubkey (SUM of amount across all active rows).
    // Returns { source_id, signing_pubkey_id, signing_pubkey, amount, activation_block, ... } or null.
    // blockIndex enforces the 6-block activation/deactivation delay for BTC reorg safety.
    async getActiveStakeByPubkey(pubkey, blockIndex){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null)
            return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT
                        MIN(s.source_id)                       AS source_id,
                        s.signing_pubkey_id                    AS signing_pubkey_id,
                        SUM(CAST(s.amount AS DECIMAL(30,8)))   AS amount,
                        MIN(s.activation_block)                AS activation_block,
                        MIN(s.block_index)                     AS block_index,
                        MIN(s.status_id)                       AS status_id,
                        ip.pubkey                              AS signing_pubkey
                     FROM stakes s
                         LEFT JOIN index_pubkeys ip ON (ip.id = s.signing_pubkey_id)
                     WHERE s.signing_pubkey_id=? AND s.status_id=?`;
        let args = [pubkey_id, valid_id];
        if(blockIndex !== undefined && blockIndex !== null){
            query += ' AND s.activation_block <= ? AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)';
            args.push(blockIndex);
            args.push(blockIndex);
        }
        query += ' GROUP BY s.signing_pubkey_id, ip.pubkey LIMIT 1';
        let results = await this.doQuery(query, args);
        if(results.length === 0) return null;
        let row = results[0];
        return {
            source_id:         row.source_id,
            signing_pubkey_id: row.signing_pubkey_id,
            signing_pubkey:    row.signing_pubkey,
            amount:            (row.amount === null || row.amount === undefined) ? '0' : String(row.amount),
            activation_block:  row.activation_block,
            block_index:       row.block_index,
            status_id:         row.status_id
        };
    }

    // Latest parsed block index (highest entry in blocks table), or 0 if none.
    async getLatestBlockIndex(){
        let results = await this.doQuery('SELECT MAX(block_index) AS max_block FROM blocks');
        if(!results || results.length === 0) return 0;
        let max = results[0].max_block;
        return (max === null || max === undefined) ? 0 : Number(max);
    }

    // Return all pubkeys with ANY active stake at `blockIndex`, regardless
    // of capability. Used by xchain-hub's Consensus (config-change PBFT) to
    // snapshot the whole-federation validator set at a block boundary —
    // governance/config quorum is over every staker, not just a capability
    // subset (OracleConsensus uses getValidatorsByCapability('price', ...)
    // when the quorum is capability-scoped).
    async getActiveValidators(blockIndex){
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return [];
        // Safety cap on the result set. This query runs on every cache miss
        // (and in-process, uncached, inside block processing), so an unbounded
        // result on an unexpectedly large validator set is a latency/liveness
        // risk. The cap is generous relative to any realistic federation size;
        // hitting it is logged so operators get early warning that the set is
        // outgrowing the assumption. Override via VALIDATOR_QUERY_LIMIT.
        let limit = parseInt(process.env.VALIDATOR_QUERY_LIMIT) || 1000;
        let query = `SELECT ip.pubkey AS pubkey,
                            SUM(CAST(s.amount AS DECIMAL(30,8))) AS total
                     FROM stakes s
                     JOIN index_pubkeys ip ON ip.id = s.signing_pubkey_id
                     WHERE s.status_id = ?
                       AND s.activation_block <= ?
                       AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)
                     GROUP BY ip.pubkey
                     LIMIT ?`;
        let rows = await this.doQuery(query, [valid_id, blockIndex, blockIndex, limit]);
        if(rows.length >= limit)
            console.warn('getActiveValidators hit the result cap of ' + limit + ' rows at block ' + blockIndex + ' — validator set may be truncated. Raise VALIDATOR_QUERY_LIMIT if the federation has grown.');
        return rows.map(r => ({
            pubkey: String(r.pubkey),
            amount: (r.total === null || r.total === undefined) ? '0' : String(r.total)
        }));
    }

    // Return all pubkeys whose SUM(active stake) at `blockIndex` meets the
    // capability's MIN_STAKE. Used by xchain-hub's CapabilitySnapshot to lock
    // the validator set at a block boundary for PBFT quorum calculations —
    // every hub independently calling this against the same blockIndex must
    // arrive at the same set, so consensus on quorum N is deterministic.
    // Spec: claude/reports/specs/2026-05-24_capability-staking-model.md §6
    async getValidatorsByCapability(capability, blockIndex, minStakeOverride){
        // Off-BTC chains have no local capability stakes (capability staking is BTC-only),
        // so resolve the qualifying set from the hub-mirrored capability_snapshots at the
        // (BTC-anchored) block. Scoped to `cross_chain` — the only capability verified on a
        // non-BTC chain (for cross-chain match settlement); other capabilities keep the
        // existing local-stakes path (which is empty off BTC, exactly as before).
        if(this.config['COIN'] !== 'BTC' && capability === 'cross_chain')
            return await this.getCapabilitySnapshotValidators(capability, blockIndex);
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        let capConfig = caps[capability];
        if(!capConfig) return [];
        // A caller-supplied threshold (the hub passes its own authoritative
        // MIN_STAKE) takes precedence over this indexer's local config. The local
        // config can drift between independently-operated indexers, so honouring
        // the caller's value keeps every hub computing the same validator set for
        // the same block. Non-hub callers omit it and get the local fallback.
        let minStake = (minStakeOverride !== undefined && minStakeOverride !== null)
            ? String(minStakeOverride)
            : (capConfig['MIN_STAKE'] || '0');
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return [];
        // Safety cap — see getActiveValidators. Bounds the result set so a
        // cache miss (or the uncached in-process call during block processing)
        // can't return an unbounded set on a large federation. Override via
        // VALIDATOR_QUERY_LIMIT.
        let limit = parseInt(process.env.VALIDATOR_QUERY_LIMIT) || 1000;
        let query = `SELECT ip.pubkey AS pubkey,
                            SUM(CAST(s.amount AS DECIMAL(30,8))) AS total
                     FROM stakes s
                     JOIN index_pubkeys ip ON ip.id = s.signing_pubkey_id
                     WHERE s.status_id = ?
                       AND s.activation_block <= ?
                       AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)
                     GROUP BY ip.pubkey
                     HAVING total >= CAST(? AS DECIMAL(30,8))
                     LIMIT ?`;
        let rows = await this.doQuery(query, [valid_id, blockIndex, blockIndex, minStake, limit]);
        if(rows.length >= limit)
            console.warn('getValidatorsByCapability(' + capability + ') hit the result cap of ' + limit + ' rows at block ' + blockIndex + ' — validator set may be truncated. Raise VALIDATOR_QUERY_LIMIT if the federation has grown.');
        return rows.map(r => ({
            pubkey: String(r.pubkey),
            amount: (r.total === null || r.total === undefined) ? '0' : String(r.total)
        }));
    }

    // Whether `capability` is present in this indexer's STAKING.CAPABILITIES config.
    // Lets the hub-facing getcapabilityvalidators RPC distinguish a genuinely empty
    // validator set from a capability this indexer doesn't know about — the latter
    // signals config drift during a capability rollout and must surface as an error
    // rather than an empty set that looks identical to "no qualified validators".
    isCapabilityConfigured(capability){
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        return !!caps[capability];
    }

    // Check whether a pubkey's active stake qualifies for a capability.
    // Returns true if SUM(active stake amount for pubkey) >= governance.min_stake[capability].
    async hasCapability(pubkey, capability, blockIndex, minStakeOverride){
        // Off-BTC chains verify cross_chain against the hub-mirrored capability snapshot
        // (presence = qualified) since capability stakes live only on BTC. Scoped to
        // cross_chain; other capabilities keep the local-stakes path. See getValidatorsByCapability.
        if(this.config['COIN'] !== 'BTC' && capability === 'cross_chain')
            return await this.isPubkeyInCapabilitySnapshot(pubkey, capability, blockIndex);
        let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
        let capConfig = caps[capability];
        if(!capConfig) return false;
        // A caller-supplied threshold takes precedence over this indexer's local
        // config (see getValidatorsByCapability). Internal block-processing callers
        // omit it and get the local fallback unchanged.
        let minStake = (minStakeOverride !== undefined && minStakeOverride !== null)
            ? String(minStakeOverride)
            : (capConfig['MIN_STAKE'] || '0');
        let stake = await this.getActiveStakeByPubkey(pubkey, blockIndex);
        if(!stake) return false;
        return this.util.bcgte(stake.amount, minStake);
    }

    // Connection for hub-mirrored tables (price_snapshots, oracle_prices,
    // cross_chain_matches, capability_snapshots). In distributed deployments these live in
    // the local hub-DB copy; single-host falls back to this indexer DB. Mirrors the
    // `(this.actions.hubDb || this.indexerDb)` idiom used at the oracle read sites.
    _mirrorDb(){
        return (this.indexer && this.indexer.hubDb) ? this.indexer.hubDb : this;
    }

    // Read the hub-mirrored qualifying validator set for a capability at a BTC-anchored
    // snapshot block. Presence in capability_snapshots = qualified (the hub only mirrors
    // pubkeys already past min_stake). Lets a non-BTC indexer resolve the cross_chain set.
    async getCapabilitySnapshotValidators(capability, snapshotBlock){
        let query = `SELECT signing_pubkey AS pubkey, amount
                     FROM capability_snapshots
                     WHERE capability = ? AND snapshot_block = ?`;
        let rows = await this._mirrorDb().doQuery(query, [capability, snapshotBlock]);
        return rows.map(r => ({ pubkey: String(r.pubkey), amount: String(r.amount) }));
    }

    // Whether a pubkey is in the mirrored capability snapshot at a block (qualified).
    async isPubkeyInCapabilitySnapshot(pubkey, capability, snapshotBlock){
        let query = `SELECT 1 FROM capability_snapshots
                     WHERE capability = ? AND snapshot_block = ? AND signing_pubkey = ? LIMIT 1`;
        let rows = await this._mirrorDb().doQuery(query, [capability, snapshotBlock, String(pubkey).toLowerCase()]);
        return rows.length > 0;
    }

    /*
     * Contract-targeted staking methods (STAKE v3 / UNSTAKE v1 / DELEGATE v1)
     * Parallel to the capability staking system; tracked in separate tables to keep
     * capability-staking queries unchanged. See claude/reports/specs/contract-staking-model.md
     */

    // Create/Update record in `contract_stakes` table.
    // Each STAKE v3 action gets its own row; active stake for (target, pubkey, tick)
    // is SUM(amount) across all valid rows. Top-up vs. new is determined by caller.
    async createContractStake(data){
        data                    = this.normalizeDataValues(data);
        let status_id           = await this.createStatus(data['STATUS']);
        let source_id           = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id   = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let tick_id             = await this.createTicker(data['TICK']);
        let action_index        = data['ACTION_INDEX'];
        let version             = data['VERSION'] || 3;
        let target_contract_index = Number(data['TARGET_CONTRACT_INDEX']);
        let amount              = data['AMOUNT'] || '0';
        let block_index         = data['BLOCK_INDEX'];
        let activation_block    = data['ACTIVATION_BLOCK'] || 0;
        let query  = "SELECT action_index FROM contract_stakes WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_stakes SET
                        source_id=?, version=?, signing_pubkey_id=?, target_contract_index=?, tick_id=?,
                        amount=?, status_id=?, block_index=?, activation_block=?
                    WHERE action_index=?`;
            args = [source_id, version, signing_pubkey_id, target_contract_index, tick_id,
                    amount, status_id, block_index, activation_block, action_index];
        } else {
            query = `INSERT INTO contract_stakes
                        (source_id, version, signing_pubkey_id, target_contract_index, tick_id,
                         amount, status_id, block_index, activation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, version, signing_pubkey_id, target_contract_index, tick_id,
                    amount, status_id, block_index, activation_block, action_index];
        }
        await this.doQuery(query, args);
    }

    // Set deactivation_block for ALL active contract_stakes rows matching (target, pubkey, tick).
    // Used by createContractUnstake to start the cooldown on all of a staker's (target, tick) rows.
    async setContractStakeDeactivationByPubkey(targetContractIndex, pubkey, tick, deactivationBlock){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return false;
        let tick_id = await this.getTickerId(tick);
        if(tick_id === null) return false;
        let valid_id = await this.getStatusId('valid');
        let query = `UPDATE contract_stakes SET deactivation_block=?
                     WHERE target_contract_index=? AND signing_pubkey_id=? AND tick_id=?
                       AND status_id=? AND deactivation_block IS NULL`;
        await this.doQuery(query, [deactivationBlock, Number(targetContractIndex), pubkey_id, tick_id, valid_id]);
        return true;
    }

    // Get aggregate active contract-stake for (target, pubkey, tick).
    // Returns { source_id, signing_pubkey_id, signing_pubkey, tick_id, tick, amount, activation_block } or null.
    async getActiveContractStakeByPubkey(targetContractIndex, pubkey, tick, blockIndex){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return null;
        let tick_id = await this.getTickerId(tick);
        if(tick_id === null) return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT
                        MIN(cs.source_id)                       AS source_id,
                        cs.signing_pubkey_id                    AS signing_pubkey_id,
                        cs.tick_id                              AS tick_id,
                        SUM(CAST(cs.amount AS DECIMAL(30,8)))   AS amount,
                        MIN(cs.activation_block)                AS activation_block,
                        MIN(cs.block_index)                     AS block_index,
                        ip.pubkey                               AS signing_pubkey,
                        t.tick                                  AS tick
                     FROM contract_stakes cs
                         LEFT JOIN index_pubkeys ip ON (ip.id = cs.signing_pubkey_id)
                         LEFT JOIN index_tickers t  ON (t.id  = cs.tick_id)
                     WHERE cs.target_contract_index=? AND cs.signing_pubkey_id=? AND cs.tick_id=? AND cs.status_id=?`;
        let args = [Number(targetContractIndex), pubkey_id, tick_id, valid_id];
        if(blockIndex !== undefined && blockIndex !== null){
            query += ' AND cs.activation_block <= ? AND (cs.deactivation_block IS NULL OR cs.deactivation_block > ?)';
            args.push(blockIndex);
            args.push(blockIndex);
        }
        query += ' GROUP BY cs.signing_pubkey_id, cs.tick_id, ip.pubkey, t.tick LIMIT 1';
        let results = await this.doQuery(query, args);
        if(results.length === 0) return null;
        let row = results[0];
        return {
            source_id:         row.source_id,
            signing_pubkey_id: row.signing_pubkey_id,
            signing_pubkey:    row.signing_pubkey,
            tick_id:           row.tick_id,
            tick:              row.tick,
            amount:            (row.amount === null || row.amount === undefined) ? '0' : String(row.amount),
            activation_block:  row.activation_block,
            block_index:       row.block_index
        };
    }

    // Check whether the (target, source) combination already owns an active stake for (pubkey, tick).
    // Used by STAKE v3 to detect "new vs. top-up" — top-up requires the existing stake be owned by the same source.
    async getContractStakeOwner(targetContractIndex, pubkey, tick){
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(pubkey_id === null) return null;
        let tick_id = await this.getTickerId(tick);
        if(tick_id === null) return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT source_id FROM contract_stakes
                     WHERE target_contract_index=? AND signing_pubkey_id=? AND tick_id=? AND status_id=?
                     ORDER BY action_index ASC LIMIT 1`;
        let results = await this.doQuery(query, [Number(targetContractIndex), pubkey_id, tick_id, valid_id]);
        if(results.length === 0) return null;
        return Number(results[0].source_id);
    }

    // Create/Update record in `contract_unstakes` table
    async createContractUnstake(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let tick_id           = await this.createTicker(data['TICK']);
        let target_contract_index = Number(data['TARGET_CONTRACT_INDEX']);
        let action_index      = data['ACTION_INDEX'];
        let cooldown_end_block = data['COOLDOWN_END_BLOCK'];
        let amount            = data['AMOUNT'] || '0';
        let block_index       = data['BLOCK_INDEX'];
        let query  = "SELECT action_index FROM contract_unstakes WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_unstakes SET
                        source_id=?, signing_pubkey_id=?, target_contract_index=?, tick_id=?,
                        cooldown_end_block=?, amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, target_contract_index, tick_id,
                    cooldown_end_block, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO contract_unstakes
                        (source_id, signing_pubkey_id, target_contract_index, tick_id,
                         cooldown_end_block, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, target_contract_index, tick_id,
                    cooldown_end_block, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    }

    // Create/Update record in `contract_delegations` table
    async createContractDelegation(data){
        data                  = this.normalizeDataValues(data);
        let status_id         = await this.createStatus(data['STATUS']);
        let source_id         = await this.getAddressId(data['SOURCE']);
        let signing_pubkey_id = await this.getOrCreatePubkeyId(data['SIGNING_PUBKEY']);
        let tick_id           = await this.createTicker(data['TICK']);
        let target_contract_index = Number(data['TARGET_CONTRACT_INDEX']);
        let action_index      = data['ACTION_INDEX'];
        let block_index       = data['BLOCK_INDEX'];
        let activation_block  = data['ACTIVATION_BLOCK'] || 0;
        let query  = "SELECT action_index FROM contract_delegations WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_delegations SET
                        source_id=?, signing_pubkey_id=?, target_contract_index=?, tick_id=?,
                        status_id=?, block_index=?, activation_block=?
                    WHERE action_index=?`;
            args = [source_id, signing_pubkey_id, target_contract_index, tick_id,
                    status_id, block_index, activation_block, action_index];
        } else {
            query = `INSERT INTO contract_delegations
                        (source_id, signing_pubkey_id, target_contract_index, tick_id,
                         status_id, block_index, activation_block, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, signing_pubkey_id, target_contract_index, tick_id,
                    status_id, block_index, activation_block, action_index];
        }
        await this.doQuery(query, args);
    }

    // Snapshot the contract's stake state at blockIndex into an in-memory accessor
    // returned to the VM execution context. Methods on the returned object are
    // synchronous since they query the pre-loaded snapshot only.
    //
    // The snapshot is scoped to THIS contract (targetContractIndex) — a contract
    // calling xchain.contract.* cannot see other contracts' stakes through this
    // accessor (implicit slash authorization). The 1000-staker cap on getStakers
    // is applied here at query time (LIMIT clause).
    async getContractStakeDataForVM(targetContractIndex, blockIndex){
        let valid_id = await this.getStatusId('valid');
        let stakes = [];
        if(valid_id !== null){
            let query = `SELECT cs.signing_pubkey_id, ip.pubkey AS pubkey, cs.tick_id, t.tick AS tick, cs.amount,
                                cs.activation_block, cs.deactivation_block
                         FROM contract_stakes cs
                             LEFT JOIN index_pubkeys ip ON (ip.id = cs.signing_pubkey_id)
                             LEFT JOIN index_tickers t  ON (t.id  = cs.tick_id)
                         WHERE cs.target_contract_index=? AND cs.status_id=?
                           AND cs.activation_block <= ?
                           AND (cs.deactivation_block IS NULL OR cs.deactivation_block > ?)`;
            stakes = await this.doQuery(query, [Number(targetContractIndex), valid_id, blockIndex, blockIndex]);
        }
        // Aggregate (pubkey, tick) → amount; also build per-tick stakers map for getStakers/getTotalStaked.
        let perPubkeyTick = new Map();      // key: pubkey + '|' + tick → string amount
        let perTickStakers = new Map();     // key: tick → Map(pubkey → string amount)
        let util = this.util;
        for(let row of stakes){
            let pubkey = String(row.pubkey || '').toLowerCase();
            let tick   = String(row.tick || '');
            if(!pubkey || !tick) continue;
            let key = pubkey + '|' + tick;
            perPubkeyTick.set(key, util.bcadd((perPubkeyTick.get(key) || '0'), row.amount, 8));
            if(!perTickStakers.has(tick)) perTickStakers.set(tick, new Map());
            let m = perTickStakers.get(tick);
            m.set(pubkey, util.bcadd((m.get(pubkey) || '0'), row.amount, 8));
        }
        // Return a SERIALIZABLE snapshot (plain data), not closures: the VM runs
        // in a forked worker and the read-only data must cross the IPC boundary.
        // xchain-vm/src/readonly-accessors.js rebuilds the sync getStake/
        // getTotalStaked/getStakers accessors from this shape inside the worker.
        let stakeByPubkeyTick = {};
        for(let [key, amt] of perPubkeyTick.entries()) stakeByPubkeyTick[key] = amt;

        let totalByTick   = {};
        let stakersByTick = {};
        for(let [tick, stakers] of perTickStakers.entries()){
            let total = '0';
            let arr = [];
            for(let [pk, amt] of stakers.entries()){
                total = util.bcadd(total, amt, 8);
                arr.push({ pubkey: pk, amount: amt });
            }
            arr.sort((a, b) => (util.bcgt(b.amount, a.amount) ? 1 : (util.bcgt(a.amount, b.amount) ? -1 : 0)));
            totalByTick[tick]   = total;
            stakersByTick[tick] = arr.slice(0, 1000);
        }
        return { stakeByPubkeyTick, totalByTick, stakersByTick };
    }

    // Slash a staker. Deducts `amount` from active contract_stakes rows first (LIFO by
    // activation_block / action_index), then from contract_unstakes rows if any remainder.
    // Returns the actual amount slashed (may be less than `amount` if available balance is lower).
    // Does NOT credit the destination or emit the slash_events row — caller (_processSlashEmission)
    // wires those side effects.
    async slashContractStake(targetContractIndex, pubkeyId, tickId, amount){
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return '0';
        let remaining = String(amount);
        let totalSlashed = '0';
        // Pass 1: deduct from active contract_stakes rows (LIFO — highest action_index first)
        let stakesQ = `SELECT action_index, amount FROM contract_stakes
                       WHERE target_contract_index=? AND signing_pubkey_id=? AND tick_id=? AND status_id=?
                         AND CAST(amount AS DECIMAL(30,8)) > 0
                       ORDER BY action_index DESC`;
        let stakeRows = await this.doQuery(stakesQ, [Number(targetContractIndex), pubkeyId, tickId, valid_id]);
        for(let row of stakeRows){
            if(!this.util.bcgt(remaining, '0')) break;
            let rowAmt = String(row.amount);
            let take = this.util.bcgte(rowAmt, remaining) ? remaining : rowAmt;
            let newAmt = this.util.bcsub(rowAmt, take, 8);
            await this.doQuery('UPDATE contract_stakes SET amount=? WHERE action_index=?', [newAmt, row.action_index]);
            remaining = this.util.bcsub(remaining, take, 8);
            totalSlashed = this.util.bcadd(totalSlashed, take, 8);
        }
        if(!this.util.bcgt(remaining, '0')) return totalSlashed;
        // Pass 2: deduct from contract_unstakes rows (cooldown-locked but still slashable)
        let pendingId = await this.getStatusId('pending');
        let unstakeStatusIds = [valid_id];
        if(pendingId !== null) unstakeStatusIds.push(pendingId);
        let placeholders = unstakeStatusIds.map(() => '?').join(',');
        let unstakesQ = `SELECT action_index, amount FROM contract_unstakes
                         WHERE target_contract_index=? AND signing_pubkey_id=? AND tick_id=?
                           AND status_id IN (${placeholders})
                           AND CAST(amount AS DECIMAL(30,8)) > 0
                         ORDER BY action_index DESC`;
        let unstakeRows = await this.doQuery(unstakesQ, [Number(targetContractIndex), pubkeyId, tickId, ...unstakeStatusIds]);
        for(let row of unstakeRows){
            if(!this.util.bcgt(remaining, '0')) break;
            let rowAmt = String(row.amount);
            let take = this.util.bcgte(rowAmt, remaining) ? remaining : rowAmt;
            let newAmt = this.util.bcsub(rowAmt, take, 8);
            await this.doQuery('UPDATE contract_unstakes SET amount=? WHERE action_index=?', [newAmt, row.action_index]);
            remaining = this.util.bcsub(remaining, take, 8);
            totalSlashed = this.util.bcadd(totalSlashed, take, 8);
        }
        return totalSlashed;
    }

    // Record a slash event row. Caller has already deducted from contract_stakes/contract_unstakes
    // (via slashContractStake) and credited the destination address.
    async createSlashEvent(data){
        data                  = this.normalizeDataValues(data);
        let execution_index   = data['EXECUTION_INDEX'];
        let target_contract_index = Number(data['TARGET_CONTRACT_INDEX']);
        let signing_pubkey_id = data['SIGNING_PUBKEY_ID'];
        let tick_id           = data['TICK_ID'];
        let amount            = data['AMOUNT'];
        let destination_id    = data['DESTINATION_ID'];
        let block_index       = data['BLOCK_INDEX'];
        let query = `INSERT INTO slash_events
                        (execution_index, target_contract_index, signing_pubkey_id, tick_id,
                         amount, destination_id, block_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [execution_index, target_contract_index, signing_pubkey_id, tick_id,
                                   amount, destination_id, block_index]);
    }

    // Process cooldown completions at the end of a block.
    // Sweeps BOTH capability `unstakes` AND `contract_unstakes` tables: any row where
    // cooldown_end_block <= currentBlock and status='pending' (or 'valid') gets its
    // remaining amount credited back to the source, and the row is marked 'completed'.
    // Returns array of credit tuples [tick, amount, address] for processTransactionLedgerChanges,
    // plus the rowids that were finalized so they can be updated to 'completed' status.
    async sweepCompletedCooldowns(currentBlock){
        let credits = [];
        let pendingId = await this.getStatusId('pending');
        let validId = await this.getStatusId('valid');
        let completedId = await this.createStatus('completed');
        // Status filter — most existing unstakes carry 'valid' since createStatus normalizes that way.
        let statusIds = [];
        if(pendingId !== null) statusIds.push(pendingId);
        if(validId !== null) statusIds.push(validId);
        if(statusIds.length === 0) return { credits, capabilityRows: [], contractRows: [] };
        let placeholders = statusIds.map(() => '?').join(',');
        let gas = this.config['GAS'];
        // Capability unstakes (XCHAIN only)
        let capQ = `SELECT u.action_index, u.amount, a.address AS source_address
                    FROM unstakes u
                        LEFT JOIN index_addresses a ON (a.id = u.source_id)
                    WHERE u.cooldown_end_block <= ?
                      AND u.status_id IN (${placeholders})
                      AND CAST(u.amount AS DECIMAL(30,8)) > 0
                    ORDER BY u.action_index ASC`;
        let capRows = await this.doQuery(capQ, [currentBlock, ...statusIds]);
        let capabilityRows = [];
        for(let row of capRows){
            credits.push([gas, String(row.amount), row.source_address]);
            capabilityRows.push(row.action_index);
        }
        // Contract unstakes (any tick)
        let conQ = `SELECT cu.action_index, cu.amount, a.address AS source_address, t.tick AS tick
                    FROM contract_unstakes cu
                        LEFT JOIN index_addresses a ON (a.id = cu.source_id)
                        LEFT JOIN index_tickers   t ON (t.id = cu.tick_id)
                    WHERE cu.cooldown_end_block <= ?
                      AND cu.status_id IN (${placeholders})
                      AND CAST(cu.amount AS DECIMAL(30,8)) > 0
                    ORDER BY cu.action_index ASC`;
        let conRows = await this.doQuery(conQ, [currentBlock, ...statusIds]);
        let contractRows = [];
        for(let row of conRows){
            credits.push([row.tick, String(row.amount), row.source_address]);
            contractRows.push(row.action_index);
        }
        return { credits, capabilityRows, contractRows, completedId };
    }

    // Mark unstake / contract_unstake rows as completed after their funds have been credited.
    async markCooldownsCompleted(capabilityRowIds, contractRowIds, completedStatusId){
        if(capabilityRowIds && capabilityRowIds.length > 0){
            let placeholders = capabilityRowIds.map(() => '?').join(',');
            await this.doQuery(
                `UPDATE unstakes SET status_id=? WHERE action_index IN (${placeholders})`,
                [completedStatusId, ...capabilityRowIds]
            );
        }
        if(contractRowIds && contractRowIds.length > 0){
            let placeholders = contractRowIds.map(() => '?').join(',');
            await this.doQuery(
                `UPDATE contract_unstakes SET status_id=? WHERE action_index IN (${placeholders})`,
                [completedStatusId, ...contractRowIds]
            );
        }
    }

    /*
     * External attestation framework — see specs/2026-05-24_external-attestation-framework.md
     */

    // Create/Update an ATTEST v0 (request) row in the consolidated `attests` table
    async createAttestationRequest(data){
        data                 = this.normalizeDataValues(data);
        let status_id        = await this.createStatus(data['STATUS']);
        let fee_payer_id     = await this.getAddressId(data['FEE_PAYER']);
        let action_index     = data['ACTION_INDEX'];
        let request_id       = String(data['REQUEST_ID'] || '').toLowerCase();
        let contract_index   = data['CONTRACT_INDEX'];
        let provider_id      = data['PROVIDER_ID'];
        let payload          = data['REQUEST_PAYLOAD'] || null;
        let callback_method  = data['CALLBACK_METHOD'];
        let callback_params  = data['CALLBACK_PARAMS'] || null;
        let redundancy       = Number(data['REDUNDANCY']) || 0;
        let deadline_block   = data['DEADLINE_BLOCK'] || 0;
        let gas_escrow       = data['GAS_ESCROW'] || '0';
        let request_status   = data['REQUEST_STATUS'] || 'pending';
        let block_index      = data['BLOCK_INDEX'];

        let query  = "SELECT action_index FROM attests WHERE action_index=? LIMIT 1";
        let exists = false;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0) exists = true;
        if(exists){
            query = `UPDATE attests SET
                        version=0, request_id=?, contract_index=?, fee_payer_id=?, provider_id=?, payload=?,
                        callback_method=?, callback_params_json=?, redundancy=?, deadline_block=?,
                        gas_escrow=?, request_status=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            await this.doQuery(query, [
                request_id, contract_index, fee_payer_id, provider_id, payload,
                callback_method, callback_params, redundancy, deadline_block,
                gas_escrow, request_status, status_id, block_index, action_index
            ]);
        } else {
            query = `INSERT INTO attests
                        (action_index, version, request_id, contract_index, fee_payer_id, provider_id, payload,
                         callback_method, callback_params_json, redundancy, deadline_block,
                         gas_escrow, request_status, status_id, block_index)
                    VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            await this.doQuery(query, [
                action_index, request_id, contract_index, fee_payer_id, provider_id, payload,
                callback_method, callback_params, redundancy, deadline_block,
                gas_escrow, request_status, status_id, block_index
            ]);
        }
    }

    // Create/Update an ATTEST v1 (response) row in the consolidated `attests` table.
    // The verified federation signatures ride in the validator_signatures JSON
    // column (data['VALIDATOR_SIGNATURES'] — a JSON array string, or null) rather
    // than in a separate child table.
    async createAttestationResponse(data){
        data                 = this.normalizeDataValues(data);
        let status_id        = await this.createStatus(data['STATUS']);
        let action_index     = data['ACTION_INDEX'];
        let request_id       = String(data['REQUEST_ID'] || '').toLowerCase();
        let provider_id      = data['PROVIDER_ID'];
        let response_hash    = String(data['RESPONSE_HASH'] || '').toLowerCase();
        let response_payload = data['RESPONSE_PAYLOAD'] || null;
        let response_status  = data['RESPONSE_STATUS'];
        let meta             = data['META'] || null;
        let signatures       = data['VALIDATOR_SIGNATURES'] || null;
        let block_index      = data['BLOCK_INDEX'];

        let query  = "SELECT action_index FROM attests WHERE action_index=? LIMIT 1";
        let exists = false;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0) exists = true;
        if(exists){
            query = `UPDATE attests SET
                        version=1, request_id=?, provider_id=?, response_hash=?, response_payload=?,
                        response_status=?, meta=?, validator_signatures=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            await this.doQuery(query, [
                request_id, provider_id, response_hash, response_payload,
                response_status, meta, signatures, status_id, block_index, action_index
            ]);
        } else {
            query = `INSERT INTO attests
                        (action_index, version, request_id, provider_id, response_hash, response_payload,
                         response_status, meta, validator_signatures, status_id, block_index)
                    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            await this.doQuery(query, [
                action_index, request_id, provider_id, response_hash, response_payload,
                response_status, meta, signatures, status_id, block_index
            ]);
        }
    }

    // Increment a counter column on attest_validator_stats. Upserts the
    // (validator_pubkey, provider_id) row on first sight. `field` is whitelisted
    // to the counter columns so callers can't inject arbitrary SQL.
    //
    // Reorg note: the table is append-monotone (counters only), so the standard
    // `DELETE WHERE block_index >= ?` pattern can't roll it back — a row's
    // earlier, surviving increments live alongside the orphaned ones. Rollback
    // therefore recomputes affected pairs from the surviving ledger rather than
    // deleting by index: Rollback._recomputeAttestationValidatorStats() drops the
    // rows last touched in the orphaned range and rebuilds them from surviving
    // signatures (fulfilled) + expired requests (missed), matching a from-genesis
    // replay. This keeps the counters consensus-safe across reorgs so Phase 4
    // slashing can consume them. See src/rollback.js.
    //
    // Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md §10
    async incrementAttestationValidatorStat(validatorPubkey, providerId, field, blockIndex){
        const allowed = { fulfilled_count: 1, missed_count: 1, slashed_count: 1 };
        if(!allowed[field]) throw new Error('incrementAttestationValidatorStat: unsupported field ' + field);
        let pk  = String(validatorPubkey || '').toLowerCase();
        let pid = String(providerId || '');
        if(!pk || !pid) return;
        let query = `INSERT INTO attest_validator_stats
                        (validator_pubkey, provider_id, ${field}, last_updated_block)
                     VALUES (?, ?, 1, ?)
                     ON DUPLICATE KEY UPDATE
                        ${field} = ${field} + 1,
                        last_updated_block = VALUES(last_updated_block)`;
        await this.doQuery(query, [pk, pid, blockIndex || 0]);
    }

    // Look up an ATTEST v0 (request) row by its request_id (64-hex hash)
    async getAttestationRequestById(requestId){
        let query = `SELECT ar.*, ia.address AS fee_payer
                     FROM attests ar
                     LEFT JOIN index_addresses ia ON ia.id = ar.fee_payer_id
                     WHERE ar.request_id = ? AND ar.version = 0
                     LIMIT 1`;
        let rows = await this.doQuery(query, [String(requestId || '').toLowerCase()]);
        return rows.length > 0 ? rows[0] : null;
    }

    // Update the request_status field on an ATTEST v0 (request) row
    async updateAttestationRequestStatus(requestId, newStatus){
        let query = `UPDATE attests
                     SET request_status = ?
                     WHERE request_id = ? AND version = 0`;
        await this.doQuery(query, [newStatus, String(requestId || '').toLowerCase()]);
    }

    // List ATTEST v0 (request) rows currently in 'pending' status, ordered by
    // creation. xchain-hub's AttestationRound polls this to discover work.
    // Optional providerId filter lets a validator only see requests for
    // providers it serves.
    async getPendingAttestationRequests(providerId, limit, cursor){
        let where = "request_status = 'pending'";
        let args  = [];
        if(providerId){
            where += ' AND provider_id = ?';
            args.push(String(providerId));
        }
        where += ' AND version = 0';
        // Keyset/cursor pagination. When the caller passes the last
        // (block_index, action_index) it has already consumed, return only rows
        // strictly after it. This lets a poller page through more than `limit`
        // pending requests across successive calls instead of being permanently
        // pinned to the oldest `limit` rows — without a cursor, a backlog larger
        // than `limit` starves every newer request until the oldest ones drain.
        let afterBlock  = cursor ? Number(cursor.after_block_index)  : NaN;
        let afterAction = cursor ? Number(cursor.after_action_index) : NaN;
        if(Number.isFinite(afterBlock) && Number.isFinite(afterAction)){
            where += ' AND (block_index > ? OR (block_index = ? AND action_index > ?))';
            args.push(afterBlock, afterBlock, afterAction);
        }
        let max = Number(limit) > 0 ? Number(limit) : 100;
        let query = `SELECT action_index, request_id, contract_index, fee_payer_id, provider_id,
                            payload, callback_method, callback_params_json,
                            redundancy, deadline_block, gas_escrow, request_status,
                            status_id, block_index
                     FROM attests
                     WHERE ` + where + `
                     ORDER BY block_index ASC, action_index ASC
                     LIMIT ` + max;
        let rows = await this.doQuery(query, args);
        // Convert BigInt columns to Number so the express JSON serializer
        // doesn't throw `TypeError: Do not know how to serialize a BigInt`.
        // Bounded chain values (block heights, action indexes) stay well
        // within Number.MAX_SAFE_INTEGER on a regtest or production network.
        return rows.map(r => ({
            ...r,
            action_index:   typeof r.action_index   === 'bigint' ? Number(r.action_index)   : r.action_index,
            contract_index: typeof r.contract_index === 'bigint' ? Number(r.contract_index) : r.contract_index,
            fee_payer_id:   typeof r.fee_payer_id   === 'bigint' ? Number(r.fee_payer_id)   : r.fee_payer_id,
            deadline_block: typeof r.deadline_block === 'bigint' ? Number(r.deadline_block) : r.deadline_block,
            status_id:      typeof r.status_id      === 'bigint' ? Number(r.status_id)      : r.status_id,
            block_index:    typeof r.block_index    === 'bigint' ? Number(r.block_index)    : r.block_index
        }));
    }

    // Find ATTEST v0 (request) rows whose deadline_block has passed without a response.
    // Returns full rows so the expiry handler doesn't have to refetch.
    async getExpiredAttestationRequests(blockIndex){
        let query = `SELECT ar.*, ia.address AS fee_payer
                     FROM attests ar
                     LEFT JOIN index_addresses ia ON ia.id = ar.fee_payer_id
                     WHERE ar.version = 0
                       AND ar.request_status = 'pending'
                       AND ar.deadline_block < ?
                     ORDER BY ar.deadline_block ASC, ar.action_index ASC`;
        return await this.doQuery(query, [blockIndex]);
    }

    // Set callback_execute_action_index on an ATTEST v1 (response) row (after the system EXECUTE is injected)
    async setAttestationResponseCallbackIndex(responseActionIndex, callbackExecuteActionIndex){
        let query = `UPDATE attests
                     SET callback_execute_action_index = ?
                     WHERE action_index = ? AND version = 1`;
        await this.doQuery(query, [callbackExecuteActionIndex, responseActionIndex]);
    }

    // Get active delegation for a source + pubkey (gated by activation/deactivation delay)
    async getActiveDelegation(source, pubkey, blockIndex){
        let source_id = await this.getAddressId(source);
        let pubkey_id = await this.getPubkeyId(String(pubkey).toLowerCase());
        if(source_id === null || pubkey_id === null)
            return null;
        let valid_id = await this.getStatusId('valid');
        let query = `SELECT * FROM delegations WHERE source_id=? AND signing_pubkey_id=? AND status_id=?`;
        let args = [source_id, pubkey_id, valid_id];
        if(blockIndex !== undefined && blockIndex !== null){
            query += ' AND activation_block <= ? AND (deactivation_block IS NULL OR deactivation_block > ?)';
            args.push(blockIndex);
            args.push(blockIndex);
        }
        query += ' ORDER BY action_index DESC LIMIT 1';
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            return results[0];
        return null;
    }

    /*
     * VM action methods
     */

    // Create/Update record in `contracts` table
    async createContract(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let source_id    = await this.getAddressId(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        let code         = data['CODE'];
        let code_hash    = data['CODE_HASH'];
        let api_version  = data['API_VERSION'] || 1;
        let block_index  = data['BLOCK_INDEX'];
        // DEPLOY v1+ staking config (NULL when contract is not opted into contract-staking)
        let cooldown_blocks = (this.util.isNull(data['COOLDOWN_BLOCKS'])) ? null : Number(data['COOLDOWN_BLOCKS']);
        let slash_destination_id = null;
        if(!this.util.isNull(data['SLASH_DESTINATION'])){
            slash_destination_id = await this.createAddress(data['SLASH_DESTINATION']);
        }
        let query  = "SELECT action_index FROM contracts WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contracts SET
                        source_id=?, code=?, code_hash=?, api_version=?, status_id=?, block_index=?,
                        cooldown_blocks=?, slash_destination_id=?
                    WHERE action_index=?`;
            args = [source_id, code, code_hash, api_version, status_id, block_index,
                    cooldown_blocks, slash_destination_id, action_index];
        } else {
            query = `INSERT INTO contracts
                        (source_id, code, code_hash, api_version, status_id, block_index,
                         cooldown_blocks, slash_destination_id, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [source_id, code, code_hash, api_version, status_id, block_index,
                    cooldown_blocks, slash_destination_id, action_index];
        }
        await this.doQuery(query, args);
    }

    // Get contract by action_index
    async getContract(action_index){
        let query = `SELECT * FROM contracts WHERE action_index=? LIMIT 1`;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0)
            return results[0];
        return null;
    }

    // Get status string by status_id
    async getStatusString(status_id){
        if(this.util.isNull(status_id))
            return null;
        let query = `SELECT status FROM index_statuses WHERE id=? LIMIT 1`;
        let results = await this.doQuery(query, [status_id]);
        if(results.length > 0)
            return results[0].status;
        return null;
    }

    // Create record in `contract_executions` table
    async createContractExecution(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let caller_id    = await this.getAddressId(data['CALLER']);
        let action_index = data['ACTION_INDEX'];
        let contract_index = data['CONTRACT_INDEX'];
        let method_name  = data['METHOD_NAME'];
        let input_params = data['INPUT_PARAMS'];
        let gas_used     = data['GAS_USED'];
        let gas_limit    = data['GAS_LIMIT'];
        let error_message = data['ERROR_MESSAGE'];
        let emitted_count = data['EMITTED_COUNT'] || 0;
        let block_index  = data['BLOCK_INDEX'];
        let query  = "SELECT action_index FROM contract_executions WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE contract_executions SET
                        contract_index=?, caller_id=?, method_name=?, input_params=?,
                        gas_used=?, gas_limit=?, status_id=?, error_message=?,
                        emitted_count=?, block_index=?
                    WHERE action_index=?`;
            args = [contract_index, caller_id, method_name, input_params,
                    gas_used, gas_limit, status_id, error_message,
                    emitted_count, block_index, action_index];
        } else {
            query = `INSERT INTO contract_executions
                        (contract_index, caller_id, method_name, input_params,
                         gas_used, gas_limit, status_id, error_message,
                         emitted_count, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args = [contract_index, caller_id, method_name, input_params,
                    gas_used, gas_limit, status_id, error_message,
                    emitted_count, block_index, action_index];
        }
        await this.doQuery(query, args);
    }

    // Create record in `deposits` table
    async createDeposit(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let source_id    = await this.getAddressId(data['SOURCE']);
        let tick_id      = await this.createTicker(data['TICK']);
        let action_index = data['ACTION_INDEX'];
        let contract_index = data['CONTRACT_ACTION_INDEX'];
        let amount       = data['AMOUNT'];
        let block_index  = data['BLOCK_INDEX'];
        let query  = "SELECT action_index FROM deposits WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE deposits SET
                        contract_index=?, source_id=?, tick_id=?, amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [contract_index, source_id, tick_id, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO deposits
                        (contract_index, source_id, tick_id, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`;
            args = [contract_index, source_id, tick_id, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    }

    // Create record in `withdrawals` table
    async createWithdrawal(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let source_id    = await this.getAddressId(data['SOURCE']);
        let tick_id      = await this.createTicker(data['TICK']);
        let action_index = data['ACTION_INDEX'];
        let contract_index = data['CONTRACT_ACTION_INDEX'];
        let amount       = data['AMOUNT'];
        let block_index  = data['BLOCK_INDEX'];
        let query  = "SELECT action_index FROM withdrawals WHERE action_index=? LIMIT 1";
        let args   = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            query = `UPDATE withdrawals SET
                        contract_index=?, source_id=?, tick_id=?, amount=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            args = [contract_index, source_id, tick_id, amount, status_id, block_index, action_index];
        } else {
            query = `INSERT INTO withdrawals
                        (contract_index, source_id, tick_id, amount, status_id, block_index, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`;
            args = [contract_index, source_id, tick_id, amount, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    }

    // Update contract custody balance (add or subtract)
    async updateContractBalance(contract_index, tick_id, amount, operation){
        // Get current balance
        let query = `SELECT amount FROM contract_balances WHERE contract_index=? AND tick_id=? LIMIT 1`;
        let results = await this.doQuery(query, [contract_index, tick_id]);
        let currentBalance = (results.length > 0) ? results[0].amount : '0';
        let newBalance;
        if(operation === 'add')
            newBalance = this.util.bcadd(currentBalance, amount, 18);
        else
            newBalance = this.util.bcsub(currentBalance, amount, 18);
        if(results.length > 0){
            query = `UPDATE contract_balances SET amount=? WHERE contract_index=? AND tick_id=?`;
            await this.doQuery(query, [newBalance, contract_index, tick_id]);
        } else {
            query = `INSERT INTO contract_balances (contract_index, tick_id, amount) VALUES (?, ?, ?)`;
            await this.doQuery(query, [contract_index, tick_id, newBalance]);
        }
    }

    // Get contract custody balance for a specific tick
    async getContractBalance(contract_index, tick_id){
        let query = `SELECT amount FROM contract_balances WHERE contract_index=? AND tick_id=? LIMIT 1`;
        let results = await this.doQuery(query, [contract_index, tick_id]);
        if(results.length > 0)
            return results[0].amount;
        return '0';
    }

    // Recalculate contract balances from deposits/withdrawals for touched pairs
    async updateContractBalances(touchedPairs){
        for(let pair of touchedPairs){
            let { contract_index, tick_id } = pair;
            // Sum valid deposits
            let validId = await this.getStatusId('valid');
            let query = `SELECT COALESCE(SUM(CAST(amount AS DECIMAL(65,18))), 0) as total
                        FROM deposits WHERE contract_index=? AND tick_id=? AND status_id=?`;
            let results = await this.doQuery(query, [contract_index, tick_id, validId]);
            let totalDeposits = (results.length > 0) ? String(results[0].total) : '0';
            // Sum valid withdrawals
            query = `SELECT COALESCE(SUM(CAST(amount AS DECIMAL(65,18))), 0) as total
                    FROM withdrawals WHERE contract_index=? AND tick_id=? AND status_id=?`;
            results = await this.doQuery(query, [contract_index, tick_id, validId]);
            let totalWithdrawals = (results.length > 0) ? String(results[0].total) : '0';
            // Calculate balance
            let balance = this.util.bcsub(totalDeposits, totalWithdrawals, 18);
            // Update or insert
            query = `SELECT contract_index FROM contract_balances WHERE contract_index=? AND tick_id=? LIMIT 1`;
            results = await this.doQuery(query, [contract_index, tick_id]);
            if(results.length > 0){
                query = `UPDATE contract_balances SET amount=? WHERE contract_index=? AND tick_id=?`;
                await this.doQuery(query, [balance, contract_index, tick_id]);
            } else if(this.util.bcgt(balance, 0)){
                query = `INSERT INTO contract_balances (contract_index, tick_id, amount) VALUES (?, ?, ?)`;
                await this.doQuery(query, [contract_index, tick_id, balance]);
            }
        }
    }

    /*****************************************************************
     * VM Integration — Savepoints
     ****************************************************************/

    // Create a savepoint within the current transaction
    async createSavepoint(name){
        if(!this.transactionConnection)
            throw new Error('createSavepoint requires an active transaction');
        await this.transactionConnection.query('SAVEPOINT ' + name);
        return name;
    }

    // Release a savepoint
    async releaseSavepoint(name){
        if(!this.transactionConnection)
            throw new Error('releaseSavepoint requires an active transaction');
        await this.transactionConnection.query('RELEASE SAVEPOINT ' + name);
    }

    // Rollback to a savepoint
    async rollbackToSavepoint(name){
        if(!this.transactionConnection)
            throw new Error('rollbackToSavepoint requires an active transaction');
        await this.transactionConnection.query('ROLLBACK TO SAVEPOINT ' + name);
    }

    /*****************************************************************
     * VM Integration — Contract State
     ****************************************************************/

    // Get the current state of a contract as a { key: value } object
    async getContractState(contractIndex){
        // Get the latest row per key using MAX(id)
        // The idx_latest index (contract_index, state_key, id DESC) makes this efficient
        let query = `SELECT cs.state_key, cs.state_value
                     FROM contract_state cs
                     INNER JOIN (
                         SELECT MAX(id) as max_id
                         FROM contract_state
                         WHERE contract_index = ?
                         GROUP BY state_key
                     ) latest ON cs.id = latest.max_id
                     WHERE cs.state_value IS NOT NULL`;
        let results = await this.doQuery(query, [contractIndex]);
        // Null-prototype object so adversarial keys round-trip faithfully. A
        // plain {} would route state['__proto__'] = value through the __proto__
        // setter — a no-op for non-object values (silently dropping the key) or
        // a prototype reassignment for object values. The VM's StateManager
        // already uses Object.create(null) and lets contracts state.set('__proto__'),
        // so the reload path must preserve it too, else that key vanishes on the
        // next EXECUTE.
        let state = Object.create(null);
        for(let row of results){
            try {
                state[row.state_key] = JSON.parse(row.state_value);
            } catch(e){
                state[row.state_key] = row.state_value;
            }
        }
        return state;
    }

    // Append a new state row (append-only — rollback via DELETE WHERE block_index >= ?)
    async createContractState(data){
        let query = `INSERT INTO contract_state
                        (contract_index, state_key, state_value, block_index, action_index)
                     VALUES (?, ?, ?, ?, ?)`;
        let args = [
            data['CONTRACT_INDEX'],
            data['STATE_KEY'],
            data['STATE_VALUE'],
            data['BLOCK_INDEX'],
            data['ACTION_INDEX']
        ];
        await this.doQuery(query, args);
    }

    // Create a record in contract_emissions
    async createContractEmission(data){
        let query = `INSERT INTO contract_emissions
                        (execution_index, emitted_action, action_index, position)
                     VALUES (?, ?, ?, ?)`;
        let args = [
            data['EXECUTION_INDEX'],
            data['EMITTED_ACTION'],
            data['ACTION_INDEX'],
            data['POSITION']
        ];
        await this.doQuery(query, args);
    }

    // Delete a contract record (for constructor failure rollback)
    async deleteContract(actionIndex){
        let query = `DELETE FROM contracts WHERE action_index=?`;
        await this.doQuery(query, [actionIndex]);
    }

    /*****************************************************************
     * VM Integration — Oracle / Cross-Chain Stubs
     ****************************************************************/

    // Oracle data accessor — reads from price_snapshots table
    // Returns an accessor object that the VM gateway uses for xchain.oracle.*
    //
    // blockTime is the unix-second timestamp of the block being processed; together with
    // maxAgeSeconds it gates getPrice against stale snapshots. Staleness is measured
    // deterministically as (blockTime − snapshot.block_timestamp), both chain-derived
    // unix seconds, so every node replaying the block computes the same result and
    // historical backfill is never falsely flagged stale. maxAgeSeconds <= 0 disables the guard.
    async getOracleDataForVM(blockIndex, blockTime, maxAgeSeconds){
        let self = this;
        let refTime = parseInt(blockTime);
        let maxAge  = parseInt(maxAgeSeconds);

        // Pre-load the latest finalized snapshot age (blocks since last snapshot)
        let ageQuery = "SELECT MAX(reference_block) AS latest_block FROM price_snapshots WHERE status = 'finalized'";
        let ageRows = await this.doQuery(ageQuery);
        let latestBlock = (ageRows.length > 0 && ageRows[0].latest_block !== null) ? ageRows[0].latest_block : 0;
        let snapshotAge = (blockIndex && latestBlock > 0) ? Math.max(0, blockIndex - latestBlock) : Number.MAX_SAFE_INTEGER;

        // True when a snapshot is older than the configured max age relative to the
        // block being processed (stale ⇒ treated as no price).
        let isStale = (snapshotTimestamp) => {
            if(!(maxAge > 0) || !Number.isFinite(refTime)) return false;
            if(!(snapshotTimestamp > 0)) return false;
            return (refTime - snapshotTimestamp) > maxAge;
        };

        // ── Build a SERIALIZABLE oracle snapshot (plain data) ───────────────
        // The VM runs in a forked worker; read-only data must cross the IPC
        // boundary, so we PRE-LOAD here and let xchain-vm/src/readonly-accessors.js
        // rebuild the synchronous getPrice/getPriceAtRound/getSnapshotAge accessors
        // inside the worker. (These were previously async DB closures — incompatible
        // with the VM's synchronous applySync bridge, so oracle reads silently
        // resolved a Promise. This conversion also fixes that latent bug.)
        let blockCap = blockIndex || 999999999;

        // getPrice(): latest finalized price per coin_pair at/<= block, one row
        // per pair (GROUP BY guarantees correctness), staleness-applied.
        let prices = {};
        let latestQuery = `SELECT t.coin_pair AS coin_pair, t.price AS price,
                                  t.round_number AS round_number, t.block_timestamp AS block_timestamp
                           FROM price_snapshots t
                           INNER JOIN (
                               SELECT coin_pair, MAX(round_number) AS mr
                               FROM price_snapshots
                               WHERE status = 'finalized' AND price IS NOT NULL AND reference_block <= ?
                               GROUP BY coin_pair
                           ) m ON t.coin_pair = m.coin_pair AND t.round_number = m.mr
                           WHERE t.status = 'finalized' AND t.price IS NOT NULL`;
        let latestRows = await this.doQuery(latestQuery, [blockCap]);
        for(let r of latestRows){
            // Stale prices surface as no-price (null), as before; contracts can
            // still read getSnapshotAge() for the staleness signal.
            if(isStale(Number(r.block_timestamp))) continue;
            prices[String(r.coin_pair)] = {
                price:       r.price,
                roundNumber: Number(r.round_number),
                timestamp:   Number(r.block_timestamp)
            };
        }

        // getPriceAtRound(): historical finalized rounds at/<= block. NOTE: this
        // now respects block causality (reference_block <= block) — an improvement
        // over the old unfiltered query (which was non-functional anyway). Capped
        // for safety; a hit is LOGGED, never silently truncated.
        let rounds = {};
        const MAX_ORACLE_ROUNDS = 50000;
        let roundQuery = `SELECT coin_pair, price, round_number, block_timestamp
                          FROM price_snapshots
                          WHERE status = 'finalized' AND price IS NOT NULL AND reference_block <= ?
                          ORDER BY round_number DESC
                          LIMIT ${MAX_ORACLE_ROUNDS}`;
        let roundRows = await this.doQuery(roundQuery, [blockCap]);
        if(roundRows.length >= MAX_ORACLE_ROUNDS)
            console.error('[oracle snapshot] round set capped at ' + MAX_ORACLE_ROUNDS +
                ' rows for block ' + blockIndex + ' — getPriceAtRound may miss older rounds');
        for(let r of roundRows){
            let cp = String(r.coin_pair);
            if(!rounds[cp]) rounds[cp] = {};
            rounds[cp][String(r.round_number)] = {
                price:       r.price,
                roundNumber: Number(r.round_number),
                timestamp:   Number(r.block_timestamp)
            };
        }

        return { snapshotAge, prices, rounds };
    }

    // Get the latest finalized price for a coin pair at or before a given block height
    // blockHeight gates the query so two nodes processing the same block always see the same price
    //
    // opts (optional) enables a staleness guard: { blockTime, maxAgeSeconds }. When both
    // are supplied and maxAgeSeconds > 0, a snapshot whose block_timestamp is older than
    // maxAgeSeconds relative to blockTime is treated as no price (returns null) rather than
    // a silently outdated value. Age is measured as (blockTime − snapshot.block_timestamp),
    // both chain-derived unix seconds, so the check is deterministic across nodes and does
    // not false-trigger during historical backfill.
    async getLatestPrice(coinPair, blockHeight, opts){
        let query, args;
        if(blockHeight !== undefined && blockHeight !== null){
            query = `SELECT price, round_number, block_timestamp
                     FROM price_snapshots
                     WHERE coin_pair = ? AND status = 'finalized' AND price IS NOT NULL
                       AND reference_block <= ?
                     ORDER BY round_number DESC LIMIT 1`;
            args = [coinPair, blockHeight];
        } else {
            query = `SELECT price, round_number, block_timestamp
                     FROM price_snapshots
                     WHERE coin_pair = ? AND status = 'finalized' AND price IS NOT NULL
                     ORDER BY round_number DESC LIMIT 1`;
            args = [coinPair];
        }
        let rows = await this.doQuery(query, args);
        if(rows.length === 0) return null;

        // Staleness guard (opt-in via opts) — see method comment.
        if(opts){
            let refTime = parseInt(opts.blockTime);
            let maxAge  = parseInt(opts.maxAgeSeconds);
            let snapTs  = Number(rows[0].block_timestamp);
            if(maxAge > 0 && Number.isFinite(refTime) && snapTs > 0 && (refTime - snapTs) > maxAge){
                return null;
            }
        }

        return {
            price:       rows[0].price,
            roundNumber: Number(rows[0].round_number),
            timestamp:   Number(rows[0].block_timestamp)
        };
    }

    // Get the latest effective oracle price for a (sourceAddress, coin, tick, fiat) combination
    // gated by blockTime so two nodes processing the same block see the same price.
    // The 24-hour lock window is enforced by `effective_at` — only prices whose effective_at <= blockTime are returned.
    async getOraclePrice(sourceAddress, coin, tick, fiat, blockTime){
        let query = `SELECT id, source_address, source_chain, coin, tick, fiat, value, fee, memo,
                            block_time, effective_at, action_index
                     FROM oracle_prices
                     WHERE source_address = ? AND coin = ? AND tick = ? AND fiat = ?`;
        let args = [sourceAddress, coin, tick, fiat];
        if(blockTime !== undefined && blockTime !== null){
            query += ' AND effective_at <= ?';
            args.push(blockTime);
        }
        query += ' ORDER BY effective_at DESC, id DESC LIMIT 1';
        let rows = await this.doQuery(query, args);
        if(rows.length === 0) return null;
        return {
            sourceAddress: rows[0].source_address,
            sourceChain:   rows[0].source_chain,
            coin:          rows[0].coin,
            tick:          rows[0].tick,
            fiat:          rows[0].fiat,
            value:         rows[0].value,
            fee:           rows[0].fee,
            memo:          rows[0].memo,
            blockTime:     Number(rows[0].block_time),
            effectiveAt:   Number(rows[0].effective_at),
            actionIndex:   Number(rows[0].action_index)
        };
    }

    // Get oracle prices for a (sourceAddress, coin, tick, fiat) within a time range (newest-first)
    // Used by reverseOraclePriceMatch for FIAT dispenser settlement.
    async getOraclePricesInTimeRange(sourceAddress, coin, tick, fiat, startTime, endTime){
        let query = `SELECT value, block_time, effective_at, action_index
                     FROM oracle_prices
                     WHERE source_address = ? AND coin = ? AND tick = ? AND fiat = ?
                       AND effective_at BETWEEN ? AND ?
                     ORDER BY effective_at DESC, id DESC`;
        let rows = await this.doQuery(query, [sourceAddress, coin, tick, fiat, startTime, endTime]);
        return rows.map(row => ({
            price:        row.value,
            blockTime:    Number(row.block_time),
            effectiveAt:  Number(row.effective_at),
            actionIndex:  Number(row.action_index)
        }));
    }

    // Get finalized prices for a coin pair within a time range (newest-first)
    async getPricesInTimeRange(coinPair, startTime, endTime){
        let query = `SELECT price, round_number, block_timestamp
                     FROM price_snapshots
                     WHERE coin_pair = ? AND status = 'finalized' AND price IS NOT NULL
                       AND block_timestamp BETWEEN ? AND ?
                     ORDER BY block_timestamp DESC`;
        let rows = await this.doQuery(query, [coinPair, startTime, endTime]);
        return rows.map(row => ({
            price:       row.price,
            roundNumber: Number(row.round_number),
            timestamp:   Number(row.block_timestamp)
        }));
    }

    // Cross-chain data stub — returns no-data accessors until Phase 4
    async getCrossChainDataForVM(){
        // Serializable snapshot (plain data) — the VM worker rebuilds the
        // getAttestation/isSettled accessors. Cross-chain reads are not yet wired,
        // so the snapshot is empty (getAttestation→null, isSettled→false).
        return { attestations: {}, settled: {} };
    }

    // Get total unclaimed rewards for a source address
    async getUnclaimedRewardTotal(source){
        let source_id = await this.getAddressId(source);
        if(source_id === null)
            return '0';
        // Sum all rewards minus all claimed amounts
        let query = `SELECT
                        COALESCE(SUM(CAST(vr.amount AS DECIMAL(65,18))), 0) as total_rewards
                    FROM validator_rewards vr
                    WHERE vr.source_id=?`;
        let args = [source_id];
        let results = await this.doQuery(query, args);
        let totalRewards = (results.length > 0) ? String(results[0].total_rewards) : '0';

        query = `SELECT
                    COALESCE(SUM(CAST(rc.amount AS DECIMAL(65,18))), 0) as total_claimed
                FROM reward_claims rc
                    INNER JOIN index_statuses s ON (s.id=rc.status_id)
                WHERE rc.source_id=? AND s.status='valid'`;
        args = [source_id];
        results = await this.doQuery(query, args);
        let totalClaimed = (results.length > 0) ? String(results[0].total_claimed) : '0';

        let unclaimed = this.util.bcsub(totalRewards, totalClaimed, 18);
        return unclaimed;
    }
}
module.exports = Database