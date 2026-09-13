/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - Database mixin: misc
 * 
 * The queries whose table is a caller-supplied parameter, so they belong to no one
 * DDL family. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const ledgerPrecision = require('../ledger_amount_precision_activation');

// A table or column name cannot be a bound parameter, so every method below that splices
// one into its statement asserts its shape first. Anything outside [A-Za-z0-9_] is refused
// rather than quoted, because a backtick-quoted identifier containing a backtick still
// escapes the quoting.
function assertSqlIdentifier(name){
    if(typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name))
        throw new Error('Refusing a table-parameterized query with an invalid SQL identifier: ' +
            JSON.stringify(name));
}

module.exports = {

    // Create / Update ledger change records (credits / debits / escrows)
    async createLedgerChangeRecord(table, action_index, tick, amount, address){
        // Whitelist valid ledger table names to prevent SQL injection
        const VALID_LEDGER_TABLES = ['credits', 'debits', 'escrows'];
        if(!VALID_LEDGER_TABLES.includes(table))
            throw new Error('Invalid ledger table: ' + table);
        let tick_id    = await this.createTicker(tick);
        let address_id = await this.createAddress(address);
        // Light-client SMT touched-key accumulation (SPV spec §4). Record the
        // (address, CANONICAL tick name) identity actually mutated this block so
        // stateCommitment updates the right balance leaf. The `tick` argument may
        // be a NAME or a "^TICK_ID" reference, and NAME refs resolve case-
        // insensitively, but the SMT balance leaf is keyed by the canonical stored
        // name: capturing the raw, unresolved tick let ^id / case-variant sends
        // silently miss their leaf (incremental balances_root drift). Resolve
        // through tick_id first. Capturing at this single ledger choke point is
        // robust to backdated cooldown-refund credits (which reuse an EARLIER
        // block's action_index, so a block-range query would miss them). Active
        // only while the indexer has installed a per-block set.
        // BOTH axes must be canonical, and for a long time only the tick one was
        // The address argument has the SAME hazards the tick argument
        // has: getAddressId accepts a wire "^<id>" reference and resolves it to a
        // row whose stored `address` is the real address, so a handler passing
        // "^123" wrote a correct credit row and then recorded the touched key as
        // the literal "^123".
        //
        // What that costs is not a wrong leaf, it is NO leaf and no error:
        // getNetBalance('^123', tick) joins index_addresses.address = '^123',
        // matches nothing, returns 0, and _leafOrNull turns 0 into null, which
        // makes stateCommitment DELETE a key that never existed. The update is a
        // no-op, balances_root does not move for that block, and the real
        // address's leaf is simply never written. On BTC regtest that presented
        // as 15 of 1531 ledger-changing blocks committing a byte-identical
        // balances_root to their predecessor, and a key was lost permanently
        // only when no later block happened to touch it again.
        if(this._smtTouched && address != null && tick_id != null && address_id != null){
            let canonTick = await this._smtTickName(tick_id);
            let canonAddr = await this._smtAddressName(address_id);
            if(canonTick != null && canonTick !== '' && canonAddr != null && canonAddr !== '')
                this._smtTouched.add(canonAddr + '\t' + canonTick);
        }
        // Quantize the amount before storing.
        //
        // LEGACY rule: round to the TICK's own decimal precision. That kept the
        // stored row on the same grid the supply projections rounded to, which is
        // why it stopped the SanityError, but it also OVERCHARGED every fee finer
        // than the gas tick can express: fees are computed at 8 dp, so a 0.5 XCHAIN
        // fee against a decimals=0 XCHAIN was recorded as 0.5 in `fees` and debited
        // as 1, and a 51-sub-command batch spent 51 rather than 25.5.
        //
        // EXACT rule (flag-day, ledger_amount_precision_activation.js): store the
        // amount at 18 dp, i.e. exactly, and let the projections round ONCE. The
        // aggregation sites below (getTokenSupply / getHolders / sanityCheck /
        // getAddressCreditDebit) sum at 18 dp and round once at the tick's scale,
        // so ledger, balances+escrows and tokens.supply still agree; see that
        // module for why round(C)-round(D)+round(E) != round(C-D+E) is the whole
        // reason the legacy write-side rounding was load-bearing.
        let decimals = ledgerPrecision.ledgerWriteScale(
            await this.getTokenDecimalPrecision(tick_id),
            this.blockIndex, this.config['NETWORK'], this.config['COIN']);
        amount = this.util.bcadd(amount, 0, decimals);
        // Convert any BigNumber amount to a plain decimal string before inserting.
        // Must be normal notation: String() renders sub-1e-7 amounts exponentially
        // ("3e-8"), which the SMT leaf encoder rejects at parse time (block wedge).
        amount = this.util.bcstr(amount);
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
    },

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
                    // Accumulate at the exact ledger scale, NOT the tick's own
                    // decimals. Rounding the RUNNING TOTAL per row is
                    // what made a 0.5-XCHAIN fee meter as a whole unit against a
                    // decimals=0 gas tick, and it compounds: 51 rows of 0.5 came
                    // out as 51, not 25.5. Rows written before the exact-ledger
                    // flag-day are already exact multiples of 10^-decimals, so
                    // this is value-identical for them.
                    data[row.tick_id] = this.util.bcadd(
                        data[row.tick_id], row.amount, ledgerPrecision.LEDGER_AMOUNT_PRECISION);
                }
            }
        }
        return data;
    },

    // Latest controller event for (keyValue, action_class), bounded for a deterministic forward read
    // (events at/before atBlock, and - for same-block ordering - strictly before atActionIndex).
    // Returns the raw row (bind or unbind) or null. Apply controllerEventIfGating() to resolve the
    // read-time cooldown into an effective controller.
    async readLatestControllerEvent(table, keyColumn, keyValue, action_class, atBlock, atActionIndex){
        let sql  = '';
        let args = [keyValue, action_class];
        if(!this.util.isNull(atActionIndex) && this.util.isNumeric(atActionIndex)){
            sql += ' AND action_index < ?'; args.push(atActionIndex);
        }
        if(!this.util.isNull(atBlock) && this.util.isNumeric(atBlock)){
            sql += ' AND block_index <= ?'; args.push(atBlock);
        }
        let query = `SELECT action_index, contract_index, is_unbind, cooldown_blocks, cooldown_end_block
                     FROM ${table}
                     WHERE ${keyColumn}=? AND action_class=?` + sql + `
                     ORDER BY action_index DESC LIMIT 1`;
        let results = await this.doQuery(query, args);
        return (results.length > 0) ? results[0] : null;
    },

    async readEffectiveControllerMap(table, keyColumn, keyValue, atBlock, atActionIndex){
        let map  = new Map();
        let sql  = '';
        let args = [keyValue];
        if(!this.util.isNull(atActionIndex) && this.util.isNumeric(atActionIndex)){
            sql += ' AND action_index < ?'; args.push(atActionIndex);
        }
        if(!this.util.isNull(atBlock) && this.util.isNumeric(atBlock)){
            sql += ' AND block_index <= ?'; args.push(atBlock);
        }
        let query = `SELECT action_class, action_index, contract_index, is_unbind, cooldown_end_block
                     FROM ${table}
                     WHERE ${keyColumn}=?` + sql + `
                     ORDER BY action_index ASC`;
        let results = await this.doQuery(query, args);
        let latest = new Map();
        for(let row of results)
            latest.set(row.action_class, row); // highest action_index wins
        for(let [cls, row] of latest){
            let gating = this.controllerEventIfGating(row, atBlock);
            if(gating) map.set(cls, Number(gating.contract_index));
        }
        return map;
    },


    // A persisted admission watermark from the HUB's configs table: the floor height the hub
    // has published for one module and parameter. Strict, for the same reason the coverage
    // read above is: an empty answer and a hub fault must not look alike to a barrier.
    async getHubConfigParam(coin, network, module, paramName){
        return await this.doQueryStrict(
            "SELECT param_value FROM configs " +
            "WHERE coin = ? AND network = ? AND module = ? AND param_name = ?",
            [coin, network, module, paramName]);
    },

    // Does the decoder's schema_migrations ledger exist in this schema? A missing ledger
    // means the decoder has never finished a first boot, which otherwise surfaces only as
    // opaque per-block JOIN errors.
    async countDecoderSchemaMigrationsTable(schemaName){
        return await this.doQuery(
            "SELECT COUNT(*) AS cnt FROM information_schema.tables " +
            "WHERE table_schema = ? AND table_name = 'schema_migrations'",
            [schemaName]);
    },

    // The same probe for the decoder's transactions table, which is the one every block
    // JOIN needs. Present schema_migrations with an absent transactions table is the
    // signature of a partially applied decoder schema.
    async countDecoderTransactionsTable(schemaName){
        return await this.doQuery(
            "SELECT COUNT(*) AS cnt FROM information_schema.tables " +
            "WHERE table_schema = ? AND table_name = 'transactions'",
            [schemaName]);
    },

    // Every table name in this schema. The genesis dump walks the whole schema rather than
    // a fixed list so a table added by a migration is carried without editing the dumper.
    async listTableNames(){
        return (await this.doQuery('SHOW TABLES')).map(r => Object.values(r)[0]);
    },

    // One table's column names in declaration order. The dump records that order and
    // replays it verbatim on import, so the artifact's bytes depend on it.
    async listTableColumnNames(table){
        assertSqlIdentifier(table);
        return (await this.doQuery('SHOW COLUMNS FROM `' + table + '`')).map(r => r.Field);
    },

    // How many rows one table holds. The dump uses this to skip empty tables, which is what
    // keeps an artifact from carrying a table header with no rows under it.
    async countRowsInTable(table){
        assertSqlIdentifier(table);
        let c = await this.doQuery('SELECT COUNT(*) AS c FROM `' + table + '`');
        return (c.length > 0) ? Number(c[0].c) : 0;
    },

    // Every row of one table, ordered by its first column and then by every remaining
    // column. The first column is each table's natural key (id / action_index / tx_index),
    // but that key is NOT unique on all of them: one action writes many credits, debits,
    // sends and escrows rows under a single action_index, and the rollcall_* tables key on
    // (epoch_height, pubkey). Ranking on the first column alone therefore leaves ties whose
    // order the engine picks freely, and the dump's byte stream moves with it. Ordering on
    // the FULL column list breaks every such tie on row CONTENT, so rows that still tie are
    // equal in each dumped column and serialize to identical bytes; that is what makes the
    // artifact's sha256 the same on every machine that generates it.
    async readAllRowsByFirstColumn(table, cols){
        assertSqlIdentifier(table);
        for(let c of cols)
            assertSqlIdentifier(c);
        let colList = cols.map(c => '`' + c + '`').join(',');
        // Ordinals rather than names: they point at the select list built right above, so the
        // order clause cannot drift away from the columns actually dumped. Term 1 stays
        // literal in the SQL text so the source-static ORDER BY audit can still read this
        // clause rather than losing sight of it behind an assembled string.
        let ties = cols.slice(1).map((c, i) => ', ' + (i + 2) + ' ASC').join('');
        return await this.doQuery('SELECT ' + colList + ' FROM `' + table + '` ORDER BY 1 ASC' + ties);
    },

    // One multi-row INSERT into a caller-named table. Values are bound; only the table and
    // column identifiers are spliced, and those are shape-asserted above. Rows arrive as
    // arrays already ordered to match `cols`.
    async insertRowsIntoTable(table, cols, rows){
        assertSqlIdentifier(table);
        for(let c of cols)
            assertSqlIdentifier(c);
        let colList = cols.map(c => '`' + c + '`').join(',');
        let one     = '(' + cols.map(() => '?').join(',') + ')';
        let sql     = 'INSERT INTO `' + table + '` (' + colList + ') VALUES ' + rows.map(() => one).join(',');
        let args    = [];
        for(let r of rows)
            for(let v of r)
                args.push(v);
        return await this.doQuery(sql, args);
    },

};
