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
 * XChain Indexer - Reader-side per-output fan-out collapse
 *
 * getDecoderBlockData (db.js) LEFT JOINs transaction_outputs and emits ONE row
 * per stored native-coin output, each row carrying the SAME transaction `data`.
 * The block loop (XChainIndexer.processTransaction) then runs once per row, and
 * createActionIndex dedupes on a per-row tx_vout — so a data-bearing action whose
 * transaction also pays a dispenser and/or a native fee-destination output would
 * be executed once per output row, producing duplicate credits/debits for a
 * single on-chain transaction.
 *
 * Per-output processing is intended ONLY for COINPAY payment settlement and for
 * empty-data DISPENSE settlement triggers. This helper collapses the extra rows
 * of every OTHER (data-bearing) transaction down to exactly one, so its action
 * executes once.
 *
 * Consensus-affecting: the caller gates `enabled` on the FIX_OUTPUT_FANOUT
 * activation (protocol_changes.js). Below activation (`enabled === false`) the
 * historical per-row behaviour is preserved UNCHANGED, except that a data-bearing
 * non-COINPAY transaction that fanned out to more than one row is treated as a
 * consensus-critical fault and throws — converting any live or historical
 * occurrence of the double-execution bug into a visible, deterministic block halt
 * (the watchdog/rollback path retries the block) instead of a silent doubled
 * ledger effect.
 *
 ********************************************************************/

'use strict';

// A row is a legitimate per-output settlement row (never collapsed) when it
// carries no action data (empty => DISPENSE settlement trigger) or its action is
// COINPAY (payment fan-out). Every other row is a data-bearing action that must
// execute exactly once per transaction. Classification mirrors the ACTION
// extraction in actions.processTransaction: split on '|', take the first field,
// trim, upper-case (empty data => the DISPENSE branch there).
function isPerOutputSettlementRow(row){
    let data = (row && row.data != null) ? String(row.data).trim() : '';
    if(data === '')
        return true;
    let action = String(data.split('|')[0]).trim().toUpperCase();
    return action === 'COINPAY';
}

// Collapse the per-output fan-out of `blockTransactions` (the rows returned by
// getDecoderBlockData, ordered by tx_index then vout).
//
// @param {Array}    blockTransactions  decoder rows for one block
// @param {boolean}  enabled            FIX_OUTPUT_FANOUT active for this block?
// @param {Function} [logError]         optional sink for the pre-throw fault log
// @returns {Array}  collapsed rows (source order preserved)
// @throws when `enabled` is false and a data-bearing non-COINPAY tx has >1 row
function collapseOutputFanout(blockTransactions, enabled, logError){
    if(!Array.isArray(blockTransactions) || blockTransactions.length < 2)
        return blockTransactions;
    // Group rows by tx_hash while preserving first-appearance order (which follows
    // the query's tx_index ASC ordering, so overall block order is unchanged).
    let order = [];
    let byTx  = Object.create(null);
    for(let row of blockTransactions){
        let key = String(row.tx_hash);
        if(!(key in byTx)){ byTx[key] = []; order.push(key); }
        byTx[key].push(row);
    }
    let result = [];
    for(let key of order){
        let rows = byTx[key];
        // A single row, or a settlement action that fans out per output by design,
        // passes through unchanged.
        if(rows.length < 2 || isPerOutputSettlementRow(rows[0])){
            for(let row of rows)
                result.push(row);
            continue;
        }
        // Data-bearing, non-COINPAY transaction that fanned out to multiple rows.
        if(!enabled){
            let msg = 'CONSENSUS-CRITICAL: transaction ' + key + ' carries action data and ' +
                'produced ' + rows.length + ' native-output rows; per-output fan-out would ' +
                'double-execute the action. Aborting block (FIX_OUTPUT_FANOUT not yet active).';
            if(typeof logError === 'function')
                logError(msg);
            throw new Error(msg);
        }
        // Activation active: keep exactly ONE row — the lowest-vout row, chosen
        // deterministically so every node collapses to the identical row. Every
        // emitted row already carries the full tx_outputs set (built in
        // getDecoderBlockData), so native-coin fee validation is unaffected by
        // which row survives.
        let chosen = rows[0];
        for(let row of rows){
            if(Number(row.vout) < Number(chosen.vout))
                chosen = row;
        }
        result.push(chosen);
    }
    return result;
}

module.exports = { collapseOutputFanout, isPerOutputSettlementRow };
