/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The utf8mb4 widen set for the columns that ingest RAW wire fields.
 *
 * WHY THIS EXISTS
 * ---------------
 * An action that fails validation is still persisted: every action family calls its
 * create* writer AFTER computing the status string, with the wire fields exactly as they
 * arrived. So a field the grammar constrains (a contract's source code, a method name, a
 * quorum fraction, a COIN tag) reaches its column holding whatever bytes the sender put on
 * chain. If that column is utf8mb3 (three bytes per character, the tables' legacy
 * DEFAULT CHARSET=utf8), a 4-byte character fails the INSERT with errno 1366 under
 * STRICT_TRANS_TABLES, the block loop retries the block forever, and every indexer on the
 * chain halts at the same height. That is a liveness wedge any sender can arm for the
 * price of one transaction. Probed against the real writers, the columns that carry a raw
 * 4-byte character all the way to the INSERT today are contracts.code,
 * deploy_chunks.code_part, messages.coin, contract_executions.method_name / input_params /
 * error_message, polls.quorum / min_vote_balance / decide_threshold, votes.share / memo,
 * gated_files.gate_ticker / gate_min_amount, and the ATTEST / XCALL payload and callback
 * fields.
 *
 * THE NUMERIC FIELDS ARE HERE AS DEFENCE IN DEPTH, NOT AS LIVE WEDGES.
 * db.normalizeDataValues nulls any NUMBER_FIELDS / LOCK_FIELDS entry that is not numeric
 * before the INSERT, so an AMOUNT / VALUE / FEE of "<emoji>" currently stores as NULL
 * rather than halting. That list is the ONLY thing standing between those columns and the
 * same errno 1366, it is hand-maintained, and it has already failed once in exactly this
 * way: CONTRACT_ACTION_INDEX was missing from it until a `DEPOSIT|0|null|...` broadcast
 * wedged the LTC-regtest venue on 2026-07-05 (see the entry's comment in src/config.js).
 * A column that cannot hold the bytes is a schema property; a column that never receives
 * them is a property of one list somebody has to remember to edit. Widen the columns and
 * the wedge stops depending on the list.
 *
 * The 2026-08-19 utf8mb4 pass widened the FREE-FORM text columns and deliberately left two
 * groups behind: contracts.code (in the contract_hash preimage) and the grammar-constrained
 * raw fields. Both were still wedge-capable. This module is the widen set for those two
 * groups, and the ONE definition the three paths share:
 *
 *   DEFINITION   src/sql/<table>.sql declares the column CHARACTER SET utf8mb4 (fresh
 *                installs; xchain-indexer only).
 *   LEDGER       a dated migration MODIFYs it (aged origin DBs; xchain-indexer only).
 *   REPLICA      xchain-sync widens the same columns at startup, because sync runs no
 *                migrations: a replica's tables are copied from the source's SHOW CREATE
 *                TABLE at bootstrap and addMissingColumns only ever ADDs columns, never
 *                retypes one. Without the replica pass, the origin accepts the character
 *                and every aged follower halts applying that block.
 *
 * NOT CONSENSUS-VISIBLE. Of the tables here only contracts, contract_executions, deposits
 * and withdrawals enter a block-hash preimage (db.getBlockHashes), and none of the columns
 * below is SELECTed into one except deposits.amount / withdrawals.amount, which the
 * preimage orders WITHOUT an explicit COLLATE. utf8mb4_general_ci orders every BMP
 * character exactly as utf8_general_ci does, and a 4-byte character cannot be present in
 * any existing row (it would have halted the indexer that wrote it), so the ordering over
 * every row that can exist today is unchanged. contracts is hashed on code_hash, never on
 * code. Widening rewrites no stored value: utf8mb3 is a strict subset of utf8mb4.
 *
 * STILL EXCLUDED, each for a reason that is not "we forgot":
 *   * index_addresses.address - a raw DESTINATION reaches it through createAddress, so it
 *     IS a halt vector, but the consensus preimages ORDER BY it with an explicit
 *     `COLLATE utf8_bin`, which becomes illegal (errno 1253) the moment the column is
 *     utf8mb4. Retiring that pin has to move in lockstep across the indexer and sync
 *     preimage queries and the stake-weight collation guard, so it is its own ruling and
 *     its own change, the way state_key already is.
 *   * contract_state.state_key / state_key_bin / state_value - the state_key collation is
 *     a height-gated consensus flag-day (src/state_key_collation_activation.js).
 *   * polls.callback_params - its ADD COLUMN migration (2026-07-05) is checksum-immutable
 *     and declares plain MEDIUMTEXT, so a charset on the definition would break the
 *     ADD-COLUMN parity gate with no legal way to converge the two paths.
 *   * index_statuses.status, index_actions.action - the indexer writes those strings
 *     itself (status text, action names); no wire byte reaches them.
 *   * the ledger amount columns (balances / credits / debits / escrows) and the derived
 *     projections (order_matches, dispenses, fees) - only a validated, canonical decimal
 *     string is ever written there, so they are not a halt vector.
 *
 * BYTE-ALIGNED TWIN: copied verbatim into xchain-sync/src/utf8mb4Columns.js (sync has no
 * dependency on this package by design; same convention as tableLifecycle.js /
 * stateHash.js). Edit here, then `cp` to the twin; the sync suite asserts byte-identity.
 *
 * Entry fields:
 *   table    table name (src/sql/<table>.sql)
 *   column   column name
 *   type     the column type EXACTLY as the definition file declares it
 *   tail     what follows the charset clause in the definition ('' | 'NULL' | 'NOT NULL')
 *   mode     'auto'   - the widen ships in the mode=auto migration and applies unattended
 *            'manual' - the column is NOT NULL, and a MODIFY carrying NOT NULL is
 *                       indistinguishable from a narrowing to the auto-apply
 *                       destructive-DDL classifier (db._destructiveAutoStatement), so it
 *                       ships in the paired mode=manual file. Dropping NOT NULL is not an
 *                       option: MODIFY restates the whole column, so it would silently
 *                       relax the column and diverge the two schema paths.
 ********************************************************************/

'use strict';

// The charset every entry below is widened to. utf8mb4_general_ci is the collation the
// 2026-08-19 pass used, and it orders BMP characters identically to utf8_general_ci.
const UTF8MB4_CHARSET_CLAUSE = 'CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci';

const UTF8MB4_RAW_FIELD_COLUMNS = [
    // ---- contract source code (DEPLOY / DEPLOY_CHUNK carry it verbatim) --------------
    { table: 'contracts',           column: 'code',                 type: 'MEDIUMTEXT',   tail: 'NOT NULL', mode: 'manual' },
    { table: 'deploy_chunks',       column: 'code_part',            type: 'MEDIUMTEXT',   tail: 'NOT NULL', mode: 'manual' },

    // ---- BROADCAST ------------------------------------------------------------------
    { table: 'broadcasts',          column: 'value',                type: 'VARCHAR(25)',  tail: '',         mode: 'auto' },
    { table: 'broadcasts',          column: 'fee',                  type: 'VARCHAR(11)',  tail: '',         mode: 'auto' },

    // ---- token movement -------------------------------------------------------------
    { table: 'sends',               column: 'amount',               type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'mints',               column: 'amount',               type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'destroys',            column: 'amount',               type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'dividends',           column: 'amount',               type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'callbacks',           column: 'callback_amount',      type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'airdrops',            column: 'amount',               type: 'VARCHAR(250)', tail: '',         mode: 'auto' },

    // ---- ISSUE ----------------------------------------------------------------------
    { table: 'issues',              column: 'max_supply',           type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'max_mint',             type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'decimals',             type: 'VARCHAR(2)',   tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'mint_supply',          type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'lock_max_supply',      type: 'VARCHAR(1)',   tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'lock_mint',            type: 'VARCHAR(1)',   tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'lock_mint_supply',     type: 'VARCHAR(1)',   tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'lock_max_mint',        type: 'VARCHAR(1)',   tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'lock_description',     type: 'VARCHAR(1)',   tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'lock_sleep',           type: 'VARCHAR(1)',   tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'lock_callback',        type: 'VARCHAR(1)',   tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'callback_block',       type: 'VARCHAR(15)',  tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'callback_amount',      type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'mint_address_max',     type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'mint_start_block',     type: 'VARCHAR(15)',  tail: '',         mode: 'auto' },
    { table: 'issues',              column: 'mint_stop_block',      type: 'VARCHAR(15)',  tail: '',         mode: 'auto' },

    // ---- markets (ORDER / SWAP / DISPENSER / BET) ------------------------------------
    { table: 'orders',              column: 'give_amount',          type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'orders',              column: 'get_amount',           type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'swaps',               column: 'give_amount',          type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'swaps',               column: 'get_amount',           type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'dispensers',          column: 'give_amount',          type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'dispensers',          column: 'give_escrow',          type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'dispensers',          column: 'get_amount',           type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'dispensers',          column: 'fiat_amount',          type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'dispenser_edits',     column: 'give_escrow',          type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'bets',                column: 'amount',               type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'bet_feeds',           column: 'fee',                  type: 'VARCHAR(11)',  tail: '',         mode: 'auto' },
    { table: 'bet_feeds',           column: 'min_amount',           type: 'VARCHAR(250)', tail: '',         mode: 'auto' },

    // ---- SLEEP / LIST / MESSAGE envelope fields --------------------------------------
    { table: 'sleeps',              column: 'resume_block',         type: 'VARCHAR(25)',  tail: '',         mode: 'auto' },
    { table: 'lists',               column: 'type',                 type: 'VARCHAR(1)',   tail: '',         mode: 'auto' },
    { table: 'lists',               column: 'edit',                 type: 'VARCHAR(1)',   tail: '',         mode: 'auto' },
    { table: 'messages',            column: 'coin',                 type: 'VARCHAR(4)',   tail: '',         mode: 'auto' },
    { table: 'messages',            column: 'encryption_method',    type: 'VARCHAR(1)',   tail: '',         mode: 'auto' },

    // ---- VOTE -----------------------------------------------------------------------
    { table: 'votes',               column: 'share',                type: 'VARCHAR(60)',  tail: '',         mode: 'auto' },
    { table: 'votes',               column: 'memo',                 type: 'MEDIUMTEXT',   tail: '',         mode: 'auto' },
    { table: 'polls',               column: 'quorum',               type: 'VARCHAR(60)',  tail: '',         mode: 'auto' },
    { table: 'polls',               column: 'min_vote_balance',     type: 'VARCHAR(60)',  tail: '',         mode: 'auto' },
    { table: 'polls',               column: 'decide_threshold',     type: 'VARCHAR(60)',  tail: '',         mode: 'auto' },
    { table: 'polls',               column: 'deposit_amount',       type: 'VARCHAR(60)',  tail: '',         mode: 'auto' },
    { table: 'polls',               column: 'gas_escrow',           type: 'VARCHAR(60)',  tail: '',         mode: 'auto' },
    { table: 'polls',               column: 'callback_method',      type: 'VARCHAR(64)',  tail: '',         mode: 'auto' },

    // ---- EXECUTE / PRICE / FILE ------------------------------------------------------
    { table: 'contract_executions', column: 'method_name',          type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'contract_executions', column: 'input_params',         type: 'TEXT',         tail: '',         mode: 'auto' },
    { table: 'contract_executions', column: 'error_message',        type: 'TEXT',         tail: '',         mode: 'auto' },
    { table: 'prices',              column: 'value',                type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'prices',              column: 'fee',                  type: 'VARCHAR(250)', tail: '',         mode: 'auto' },
    { table: 'gated_files',         column: 'gate_min_amount',      type: 'VARCHAR(40)',  tail: 'NULL',     mode: 'auto' },

    // ---- ATTEST / XCALL --------------------------------------------------------------
    { table: 'attests',             column: 'payload',              type: 'MEDIUMTEXT',   tail: '',         mode: 'auto' },
    { table: 'attests',             column: 'callback_method',      type: 'VARCHAR(64)',  tail: '',         mode: 'auto' },
    { table: 'attests',             column: 'callback_params_json', type: 'TEXT',         tail: '',         mode: 'auto' },
    { table: 'attests',             column: 'gas_escrow',           type: 'VARCHAR(60)',  tail: '',         mode: 'auto' },
    { table: 'attests',             column: 'fee_amount',           type: 'VARCHAR(60)',  tail: '',         mode: 'auto' },
    { table: 'attests',             column: 'response_payload',     type: 'MEDIUMTEXT',   tail: '',         mode: 'auto' },
    { table: 'attests',             column: 'meta',                 type: 'VARCHAR(256)', tail: '',         mode: 'auto' },
    { table: 'xcalls',              column: 'method',               type: 'VARCHAR(64)',  tail: '',         mode: 'auto' },
    { table: 'xcalls',              column: 'params_json',          type: 'TEXT',         tail: '',         mode: 'auto' },
    { table: 'xcalls',              column: 'callback_method',      type: 'VARCHAR(64)',  tail: '',         mode: 'auto' },
    { table: 'xcalls',              column: 'callback_params_json', type: 'TEXT',         tail: '',         mode: 'auto' },

    // ---- NOT NULL raw fields (paired mode=manual file) -------------------------------
    { table: 'deposits',            column: 'amount',               type: 'VARCHAR(250)', tail: 'NOT NULL', mode: 'manual' },
    { table: 'withdrawals',         column: 'amount',               type: 'VARCHAR(250)', tail: 'NOT NULL', mode: 'manual' },
    { table: 'stakes',              column: 'amount',               type: 'VARCHAR(250)', tail: 'NOT NULL', mode: 'manual' },
    { table: 'unstakes',            column: 'amount',               type: 'VARCHAR(250)', tail: 'NOT NULL', mode: 'manual' },
    { table: 'contract_stakes',     column: 'amount',               type: 'VARCHAR(250)', tail: 'NOT NULL', mode: 'manual' },
    { table: 'contract_unstakes',   column: 'amount',               type: 'VARCHAR(250)', tail: 'NOT NULL', mode: 'manual' },
    { table: 'reward_claims',       column: 'amount',               type: 'VARCHAR(250)', tail: 'NOT NULL', mode: 'manual' },
    { table: 'gated_files',         column: 'gate_ticker',          type: 'VARCHAR(250)', tail: 'NOT NULL', mode: 'manual' },
    { table: 'attests',             column: 'provider_id',          type: 'VARCHAR(32)',  tail: 'NOT NULL', mode: 'manual' },
];

// The column spec as both the definition file and the migration MODIFY must state it.
// One producer, so the two paths cannot word it differently (the schema-parity gate
// compares them normalized, and a reordered charset clause reads as a divergence).
function columnSpec(entry){
    return [entry.type, UTF8MB4_CHARSET_CLAUSE, entry.tail].filter(Boolean).join(' ');
}

// `MODIFY \`col\` <spec>` - the clause body of an ALTER TABLE, used by the migrations and
// by the xchain-sync replica widen.
function modifyClause(entry){
    return 'MODIFY `' + entry.column + '` ' + columnSpec(entry);
}

// The whole statement for one entry, for callers that widen a single column at a time.
function alterStatement(entry){
    return 'ALTER TABLE `' + entry.table + '` ' + modifyClause(entry);
}

// Entries grouped by table, preserving declaration order, so a migration or a replica
// pass can issue one ALTER per table instead of one per column (each ALTER is a COPY
// rebuild under a metadata lock, so batching matters on a large table).
function byTable(entries){
    const out = new Map();
    for(const entry of (entries || UTF8MB4_RAW_FIELD_COLUMNS)){
        if(!out.has(entry.table)) out.set(entry.table, []);
        out.get(entry.table).push(entry);
    }
    return out;
}

const forMode = (mode) => UTF8MB4_RAW_FIELD_COLUMNS.filter(e => e.mode === mode);

// True when an information_schema.columns row already reports the column as utf8mb4, so
// the widen is a no-op. MariaDB 10.6 renamed utf8 to utf8mb3, so this reads the positive
// (already wide) case rather than comparing against a legacy charset spelling.
function isAlreadyUtf8mb4(row){
    if(!row) return false;
    const charset = String(row.CHARACTER_SET_NAME || row.character_set_name || '').toLowerCase();
    return charset === 'utf8mb4';
}

module.exports = {
    UTF8MB4_CHARSET_CLAUSE,
    UTF8MB4_RAW_FIELD_COLUMNS,
    columnSpec,
    modifyClause,
    alterStatement,
    byTable,
    forMode,
    isAlreadyUtf8mb4,
};
