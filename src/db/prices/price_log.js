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
 * XChain Indexer - Database mixin part: prices (PRICE action log)
 *
 * The writer and the batch-window read over the `prices` table, the raw on-chain PRICE
 * action log. A part of the prices mixin: src/db/prices/index.js merges it into the one method
 * set that db/index.js installs onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const { fitColumnText } = require('../column_text.js');

// Integer and TEXT columns a refused row fills from the wire with no rule bounding them
// (src/sql/prices.sql): version TINYINT UNSIGNED NOT NULL, round_number, batch_first_round and
// batch_last_round BIGINT UNSIGNED, round_count SMALLINT UNSIGNED, and rounds_json and sigs_json
// TEXT (65,535 bytes). A PRICE whose VERSION is not a number recorded VERSION NULL (errno 1048)
// and one of '-1' recorded -1 (errno 1264); a v0 batch refused for its window header still
// records the FIRST_ROUND, LAST_ROUND and ROUND_COUNT it claimed ('-5', 23 digits, 70000:
// errno 1264); and a batch refused after its body parsed (a failed quorum) records its round
// and signature lists, which an envelope-sized wire carries past the TEXT column (errno 1406).
// Each failed the write and retried the block forever. On a refused row a version the column
// cannot hold binds 255, which no PRICE version uses; a round bound binds its nearest column
// bound; and a list past the column stores NULL, the value a batch whose body did not parse
// already stores. Every value that fits binds unchanged. A valid row binds what its handler
// set: version 0 or 1, and a window the header rules admitted and a quorum signed. Every reader
// of these columns selects valid rows (getPriceBatchesOverlappingRange through its only caller,
// findValidPriceBatchPayload, the rollback batch-window read) or version 1 (the v1 mapping
// backfill), and the table is in no hash beyond the action status its row already carries.
const U8_MAX          = '255';
const U16_MAX         = '65535';
const U64_MAX         = '18446744073709551615';
const UNKNOWN_VERSION = 255;
const TEXT_MAX_BYTES  = 65535;

// The version and v0 batch columns as createPrice binds them.
function batchColumns(util, data){
    let cols = {
        version:           data['VERSION'],
        round_number:      data['ROUND'] || null,
        batch_first_round: data['BATCH_FIRST_ROUND'] || null,
        batch_last_round:  data['BATCH_LAST_ROUND'] || null,
        round_count:       data['ROUND_COUNT'] || null,
        rounds_json:       data['ROUNDS_JSON'] || null,
        sigs_json:         data['SIGS_JSON'] || null
    };
    if(data['STATUS'] === 'valid') return cols;
    let fitInt  = (v, max) => util.fitIntegerColumn(v, '0', max) ?? null;
    let fitText = (v) => (v !== null && Buffer.byteLength(String(v), 'utf8') > TEXT_MAX_BYTES) ? null : v;
    return {
        version:           util.storesInIntegerColumn(cols.version, '0', U8_MAX) ? cols.version : UNKNOWN_VERSION,
        round_number:      fitInt(cols.round_number, U64_MAX),
        batch_first_round: fitInt(cols.batch_first_round, U64_MAX),
        batch_last_round:  fitInt(cols.batch_last_round, U64_MAX),
        round_count:       fitInt(cols.round_count, U16_MAX),
        rounds_json:       fitText(cols.rounds_json),
        sigs_json:         fitText(cols.sigs_json)
    };
}

// The two halves of createPrice's upsert, keyed by action_index. Their column lists alone
// would carry the method past the function limit, so the statements live here, text unchanged.
const PRICE_UPDATE_SQL = `UPDATE prices SET
                        version=?, source_id=?, round_number=?, round_timestamp=?,
                        pair_count=?, pairs_json=?, sig_count=?, sigs_json=?,
                        batch_first_round=?, batch_last_round=?, round_count=?, rounds_json=?,
                        coin_id=?, tick_id=?, fiat_id=?, value=?, fee=?, memo_id=?,
                        validation_status=?, status_id=?
                    WHERE action_index=?`;
const PRICE_INSERT_SQL = `INSERT INTO prices
                        (version, source_id, round_number, round_timestamp,
                         pair_count, pairs_json, sig_count, sigs_json,
                         batch_first_round, batch_last_round, round_count, rounds_json,
                         coin_id, tick_id, fiat_id, value, fee, memo_id,
                         validation_status, status_id, action_index)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

module.exports = {

    // Create/Update record in `prices` table (PRICE action log)
    // Stores the raw on-chain PRICE action data; the hub aggregates these into price_snapshots/oracle_prices
    async createPrice(data){
        data                = this.normalizeDataValues(data);
        let status_id       = await this.createStatus(data['STATUS']);
        let source_id       = await this.getAddressId(data['SOURCE']);
        let action_index    = data['ACTION_INDEX'];
        let validation      = data['VALIDATION_STATUS'] || 'pending';
        // v0 fields (round_number holds FIRST_ROUND on a batch row; see prices.sql), the v2
        // BATCH window (NULL on a v0/v1 row) and the version, fitted on a refused row
        let { version, round_number, sigs_json, batch_first_round, batch_last_round,
              round_count, rounds_json } = batchColumns(this.util, data);
        let round_timestamp = data['TIMESTAMP'] || null;
        let pair_count      = data['PAIR_COUNT'] || null;
        let pairs_json      = data['PAIRS_JSON'] || null;
        let sig_count       = data['SIG_COUNT'] || null;
        // v1 fields
        let coin_id         = (data['V1_COIN'])  ? await this.createCoin(data['V1_COIN'])     : null;
        let tick_id         = (data['V1_TICK'])  ? await this.createTicker(data['V1_TICK'])   : null;
        let fiat_id         = (data['V1_FIAT'])  ? await this.createFiat(data['V1_FIAT'])     : null;
        // A refused v1 stores VALUE and FEE as carried, with no width rule, so they are
        // clipped to their VARCHAR(250) columns; a valid row is bounded by the handler.
        let refused         = data['STATUS'] !== 'valid';
        let value           = refused ? fitColumnText(data['V1_VALUE'] || null, 250, false) : (data['V1_VALUE'] || null);
        let fee             = refused ? fitColumnText(data['V1_FEE']   || null, 250, false) : (data['V1_FEE']   || null);
        let memo_id         = (data['MEMO'])     ? await this.createMemo(data['MEMO'])         : null;
        // Check if record exists (idempotent for retries)
        let query   = "SELECT action_index FROM prices WHERE action_index=? LIMIT 1";
        let args    = [action_index];
        let exists  = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // Both halves bind the same list, action_index last, so one array serves either.
        query = exists ? PRICE_UPDATE_SQL : PRICE_INSERT_SQL;
        args = [version, source_id, round_number, round_timestamp,
                pair_count, pairs_json, sig_count, sigs_json,
                batch_first_round, batch_last_round, round_count, rounds_json,
                coin_id, tick_id, fiat_id, value, fee, memo_id,
                validation, status_id, action_index];
        await this.doQuery(query, args);
    },

    // Valid batch rows overlapping the closed round range the caller asked for. A batch
    // overlaps when it starts at or before the range's end AND ends at or after its start,
    // which is why the two round arguments read in the opposite order to the range itself.
    // round_number carries the batch's FIRST_ROUND on a batch row (prices.sql), so the
    // indexed column drives the scan while batch_first_round stays the authoritative field
    // and is what comes back. The caller pages by advancing first_round past the last batch
    // it received. block_index is the landing block from the batch's actions row, so the
    // caller can resolve the landing clock a pushpricebatch carried for it.
    async getPriceBatchesOverlappingRange(validationStatus, lastRound, firstRound, limit){
        let query = 'SELECT p.action_index, p.batch_first_round, p.batch_last_round, p.round_count, ' +
                    'a.block_index ' +
                    'FROM prices p LEFT JOIN actions a ON a.action_index = p.action_index ' +
                    'WHERE p.version = 0 AND p.validation_status = ? ' +
                    'AND p.batch_first_round IS NOT NULL AND p.batch_last_round IS NOT NULL ' +
                    'AND p.batch_first_round <= ? AND p.batch_last_round >= ? ' +
                    'ORDER BY p.batch_first_round ASC, p.action_index ASC ' +
                    'LIMIT ?';
        return await this.doQuery(query, [validationStatus, lastRound, firstRound, limit]);
    },

    // One active-chain PRICE v0 batch with the stored body needed to rebuild the
    // pushpricebatch payload. The INNER JOIN excludes a price row whose action no
    // longer belongs to the committed chain after rollback.
    async findValidPriceBatchPayload(actionIndex){
        let query = 'SELECT p.action_index, p.batch_first_round, p.batch_last_round, p.round_count, ' +
                    'p.rounds_json, p.sigs_json, a.block_index ' +
                    'FROM prices p INNER JOIN actions a ON a.action_index = p.action_index ' +
                    'WHERE p.action_index = ? AND p.version = 0 AND p.validation_status = \'valid\' ' +
                    'AND p.batch_first_round IS NOT NULL AND p.batch_last_round IS NOT NULL ' +
                    'AND p.rounds_json IS NOT NULL AND p.sigs_json IS NOT NULL LIMIT 1';
        let rows = await this.doQuery(query, [actionIndex]);
        return rows.length > 0 ? rows[0] : null;
    },

};
