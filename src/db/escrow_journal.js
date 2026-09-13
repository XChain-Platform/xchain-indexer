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
 * XChain Indexer - Database mixin: escrow_journal
 *
 * The statements the escrow-leaf journal writer issues: the escrow ledger reads it
 * attributes, the per-family lookups that re-key a recipient-keyed release row back
 * to its locker, the index-id resolution, the prior-total read and the journal
 * INSERT. Installed onto Database.prototype by db/index.js, so call sites stay
 * this.db.<method>().
 *
 * The attribution RULES stay in src/escrowJournalWriter.js, which is the frozen
 * part; what lives here is only the SQL each rule reads through. Every "exactly one
 * row or halt" judgement stays with the rule, because the halt message names the
 * action and the attribution that could not be made.
 *
 ********************************************************************/

// A table or column name cannot be a bound parameter. The dispenser-family lookup
// splices both from the frozen DISPENSER_FAMILY map in escrowJournalWriter.js, never
// from row content, and this assertion is what keeps that true if a caller ever
// passes something else.
function assertSqlIdentifier(name){
    if(typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name))
        throw new Error('escrowJournal: refusing a query with an invalid SQL identifier: ' +
            JSON.stringify(name));
}

// Split a list into fixed-size chunks, so an IN list or a VALUES list stays inside
// the driver's placeholder limit and max_allowed_packet on the arming replay.
const KEY_CHUNK = 500;
function chunked(list, size){
    const out = [];
    for(let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}
function placeholders(list){ return list.map(() => '?').join(','); }

module.exports = {

    // The two order legs of one ORDER_MATCH. CROSSED mapping: order_matches ticks are the
    // standing order's give/get, and give_action_index is the incoming match's action_index.
    async getOrderMatchLegs(actionIndex){
        return await this.doQuery(
            'SELECT give_action_index, get_action_index, give_tick_id, get_tick_id ' +
            'FROM order_matches WHERE action_index = ?', [actionIndex]);
    },

    // The two legs of one SWAP_MATCH. STRAIGHT mapping: swap_matches ticks are the incoming
    // match's give/get.
    async getSwapMatchLegs(actionIndex){
        return await this.doQuery(
            'SELECT give_action_index, get_action_index, give_tick_id, get_tick_id ' +
            'FROM swap_matches WHERE action_index = ?', [actionIndex]);
    },

    // The local leg a CROSS_SETTLE settled, which is the action that locked the escrow.
    async getCrossChainSettlementLocalAction(actionIndex){
        return await this.doQuery(
            'SELECT local_action_index FROM cross_chain_settlements WHERE action_index = ?', [actionIndex]);
    },

    // Does this execution hold a contract-slash debit against this owner and tick? The
    // EXECUTE resolver verifies its one escrow site against a debit the same execution
    // wrote, rather than permitting the VM's generic entry point wholesale: a blanket
    // permit would absorb a future escrow site silently.
    async getContractSlashReleaseMatch(executionIndex, address, tickId){
        return await this.doQuery(
            'SELECT 1 AS ok FROM contract_slash_debits d ' +
            "LEFT JOIN contract_stakes   cs ON (d.target_table = 'contract_stakes'   AND cs.action_index = d.stake_action_index) " +
            "LEFT JOIN contract_unstakes cu ON (d.target_table = 'contract_unstakes' AND cu.action_index = d.stake_action_index) " +
            'INNER JOIN index_addresses a ON a.id = COALESCE(cs.source_id, cu.source_id) ' +
            'WHERE d.execution_index = ? AND a.address = ? AND COALESCE(cs.tick_id, cu.tick_id) = ? LIMIT 1',
            [executionIndex, address, tickId]);
    },

    // The dispenser one DISPENSER-family action points at. The create carries the dispenser
    // on its OWN action_index; the rest carry a foreign key to it, which is why the column
    // and the table both vary by action.
    async getDispenserFamilyReference(table, fkColumn, actionIndex){
        assertSqlIdentifier(table);
        assertSqlIdentifier(fkColumn);
        return await this.doQuery(
            'SELECT ' + fkColumn + ' AS dispenser_action_index FROM ' + table + ' WHERE action_index = ?',
            [actionIndex]);
    },

    // SOURCE address of the action that created a lock row. actions.source_id is the
    // authoritative source (see actions.sql); a lock whose creating action has none is not
    // attributable, and the caller halts rather than guesses.
    async getActionSourceAddress(actionIndex){
        return await this.doQuery(
            'SELECT addr.address AS address FROM actions a ' +
            'INNER JOIN index_addresses addr ON addr.id = a.source_id ' +
            'WHERE a.action_index = ?', [actionIndex]);
    },

    // The escrow ledger rows to attribute: one block's (incremental) or the whole table's
    // (arming replay). The INNER JOINs would silently DROP a row whose address/tick/action
    // refs do not resolve, so callers must pair this with countEscrowLedgerRows and treat any
    // difference as a halt, not a curiosity.
    async getEscrowLedgerRows(blockIndex){
        const scoped = (blockIndex !== undefined && blockIndex !== null);
        return (await this.doQuery(
            'SELECT e.action_index AS action_index, ia.action AS action_name, ' +
            '       addr.address AS address, t.tick AS tick, e.tick_id AS tick_id, e.amount AS amount ' +
            'FROM escrows e ' +
            'INNER JOIN actions a          ON a.action_index = e.action_index ' +
            'INNER JOIN index_actions ia   ON ia.id = a.action_id ' +
            'INNER JOIN index_addresses addr ON addr.id = e.address_id ' +
            'INNER JOIN index_tickers t    ON t.id = e.tick_id ' +
            (scoped ? 'WHERE a.block_index = ? ' : '') +
            'ORDER BY e.action_index',
            scoped ? [blockIndex] : [])) || [];
    },

    // The same set counted WITHOUT the joins, which is the whole point: it is the control
    // against which a row dropped by a join shows up as a difference.
    async countEscrowLedgerRows(blockIndex){
        const scoped = (blockIndex !== undefined && blockIndex !== null);
        const rows = await this.doQuery(
            'SELECT COUNT(*) AS n FROM escrows e ' +
            'INNER JOIN actions a ON a.action_index = e.action_index' +
            (scoped ? ' WHERE a.block_index = ?' : ''),
            scoped ? [blockIndex] : []);
        return Number(rows && rows.length ? rows[0].n : 0);
    },

    // Resolve a set of address and tick STRINGS to their index-table ids, in two set queries
    // rather than one per key. Shared by the prior-total read and the INSERT.
    //
    // The INSERT needs it for a correctness reason, not a speed one. An id bound as a
    // `(SELECT id FROM index_addresses WHERE address = ?)` sub-select leans on the NOT NULL
    // column to throw when it resolves to nothing, and that guarantee does not survive
    // batching: on a server without STRICT_ALL_TABLES a MULTI-row INSERT downgrades a NULL
    // into a NOT NULL column from an error to a warning and writes the implicit default 0, so
    // a consensus journal row would be silently attributed to whichever address holds id 0,
    // while the single-row form errored on the identical value. Resolving here and letting
    // the caller throw BY NAME keeps the writer fail-loud under every sql_mode.
    async resolveEscrowJournalIndexIds(addresses, ticks){
        const addrIds = new Map();
        for(const chunk of chunked(Array.from(new Set(addresses)), KEY_CHUNK)){
            const rows = await this.doQuery(
                'SELECT a.id AS id, a.address AS address FROM index_addresses a WHERE a.address IN (' + placeholders(chunk) + ')',
                chunk);
            for(const r of (rows || [])) addrIds.set(String(r.address), r.id);
        }
        const tickIds = new Map();
        for(const chunk of chunked(Array.from(new Set(ticks)), KEY_CHUNK)){
            const rows = await this.doQuery(
                'SELECT t.id AS id, t.tick AS tick FROM index_tickers t WHERE t.tick IN (' + placeholders(chunk) + ')',
                chunk);
            for(const r of (rows || [])) tickIds.set(String(r.tick), r.id);
        }
        return { addrIds, tickIds };
    },

    // The newest journal row per (address_id, tick_id) within one chunk pair.
    //
    // The read is unbounded in height because the writer runs before this block's rows are
    // inserted, so the latest row for a key is necessarily from a prior block. MAX(id) is the
    // same row a per-key `ORDER BY j.id DESC LIMIT 1` returns: id is the AUTO_INCREMENT
    // primary key, so it orders the append-only journal exactly.
    //
    // Set-based rather than one SELECT per key, because the arming replay attributes the
    // WHOLE ledger and a per-key tail would scale with ledger size inside the block
    // transaction. The id lookups narrow the grouped scan to the keys in play; that filter is
    // an address x tick SUPERSET of the real key set, which is harmless because every value
    // is read back by exact key and a key the grouped result never mentions reads '0' just as
    // an empty single-key JOIN did.
    async getLatestEscrowJournalRows(addressIdChunk, tickIdChunk){
        return await this.doQuery(
            'SELECT j.address_id AS address_id, j.tick_id AS tick_id, j.locked_amount AS locked_amount ' +
            'FROM escrow_leaf_journal j ' +
            'INNER JOIN (SELECT address_id, tick_id, MAX(id) AS id FROM escrow_leaf_journal ' +
            '            WHERE address_id IN (' + placeholders(addressIdChunk) + ') AND tick_id IN (' + placeholders(tickIdChunk) + ') ' +
            '            GROUP BY address_id, tick_id) m ON m.id = j.id',
            addressIdChunk.concat(tickIdChunk));
    },

    // Per-tick totals straight from the escrows ledger, for the arming replay's cross-check.
    // This is the second, independent computation of a figure the replay also derives by
    // attribution; a disagreement halts the arming block.
    async getEscrowLedgerTotalsByTick(){
        return await this.doQuery(
            'SELECT t.tick AS tick, CAST(SUM(CAST(e.amount AS DECIMAL(60,18))) AS CHAR) AS total ' +
            'FROM escrows e INNER JOIN index_tickers t ON t.id = e.tick_id GROUP BY e.tick_id', []);
    },

    // One multi-row INSERT of journal rows rather than one per key. The VALUES list keeps the
    // caller's order, so the AUTO_INCREMENT ids that idx_latest walks backwards are assigned
    // exactly as per-key inserts assigned them. A released key arrives with locked null, the
    // reader's tombstone.
    async insertEscrowJournalRows(rows, blockIndex){
        const args = [];
        for(const p of rows) args.push(p.address_id, p.tick_id, p.locked, blockIndex);
        await this.doQuery(
            'INSERT INTO escrow_leaf_journal (address_id, tick_id, locked_amount, block_index) VALUES ' +
            rows.map(() => '(?, ?, ?, ?)').join(', '),
            args);
    },

};
