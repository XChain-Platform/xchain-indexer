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
 * action log. A part of the prices mixin: src/db/prices.js merges it into the one method
 * set that db/index.js installs onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

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
        let version         = data['VERSION'];
        let validation      = data['VALIDATION_STATUS'] || 'pending';
        // v0 fields (round_number holds FIRST_ROUND on a batch row; see prices.sql)
        let round_number    = data['ROUND'] || null;
        let round_timestamp = data['TIMESTAMP'] || null;
        let pair_count      = data['PAIR_COUNT'] || null;
        let pairs_json      = data['PAIRS_JSON'] || null;
        let sig_count       = data['SIG_COUNT'] || null;
        let sigs_json       = data['SIGS_JSON'] || null;
        // v2 fields (BATCH window; NULL on a v0/v1 row)
        let batch_first_round = data['BATCH_FIRST_ROUND'] || null;
        let batch_last_round  = data['BATCH_LAST_ROUND'] || null;
        let round_count       = data['ROUND_COUNT'] || null;
        let rounds_json       = data['ROUNDS_JSON'] || null;
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
    // it received.
    async getPriceBatchesOverlappingRange(validationStatus, lastRound, firstRound, limit){
        let query = 'SELECT action_index, batch_first_round, batch_last_round, round_count ' +
                    'FROM prices ' +
                    'WHERE version = 0 AND validation_status = ? ' +
                    'AND batch_first_round IS NOT NULL AND batch_last_round IS NOT NULL ' +
                    'AND batch_first_round <= ? AND batch_last_round >= ? ' +
                    'ORDER BY batch_first_round ASC, action_index ASC ' +
                    'LIMIT ?';
        return await this.doQuery(query, [validationStatus, lastRound, firstRound, limit]);
    },

};
