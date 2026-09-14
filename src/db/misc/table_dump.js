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
 * XChain Indexer - Database mixin part: misc / table_dump
 *
 * The table-parameterized schema reads and row copies the genesis dump walks the
 * whole schema with.
 * Merged into the misc mixin by db/misc.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

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
