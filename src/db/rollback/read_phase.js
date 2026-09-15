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
 * XChain Indexer - Database statements: rollback read phase
 *
 * The statements the rollback runs before its transaction opens, and the per-table
 * queries that collect what the orphaned range touched. Each read takes the
 * handle it runs on: the rollback passes its pool-direct view, so no read here
 * adopts a transaction another caller left open. Called from src/rollback/read_phase.js.
 *
 ********************************************************************/

'use strict';

// Wire versions only, for the ATTEST batch-link retraction below: the head and the
// continuation are what make an `attests` row part of a batch, and naming them from the
// wire module keeps the reorg query and the parser reading the same two numbers.
const abw       = require('../../actions/attest/attest_batch_wire.js');

module.exports = {

    // The first action_index at or after the reorg block, read strict.
    async readFirstActionRows(view, block_index){
        // Get the first action_index at or after the given block
        let query = `SELECT
                        a.action_index
                    FROM
                        actions a
                    WHERE
                        a.block_index >= ?
                    ORDER BY
                        a.action_index ASC
                    LIMIT 1`;
        let args = [block_index];
        // doQueryStrict (not doQuery): these reads run OUTSIDE the rollback transaction, where
        // doQuery collapses a transient DB fault (lock timeout, killed connection) into [] -
        // indistinguishable from "no actions in range" - leaving firstActionIndex null. The
        // unconditional blockTables/indexTables deletes below would then COMMIT a partial rollback
        // (blocks/transactions gone, orphaned action/ledger rows surviving) that forks the hash
        // chain permanently and is never retried (the processed-reorg cursor advances). A throw
        // instead aborts before any delete; the driver re-detects and retries the reorg cleanly.
        let rows = await view.doQueryStrict(query, args);
        return rows;
    },

    // The highest rolled-back action_index, read strict while the rows still exist.
    async readLastActionRows(view, block_index){
        let maxRows = await view.doQueryStrict(
            'SELECT MAX(a.action_index) AS last_action_index FROM actions a WHERE a.block_index >= ?',
            [block_index]
        );
        return maxRows;
    },

    // Tables that carry their own tick_id and address id, so the tick and address come
    // off the row itself.
    entityQueryForLedgerTables(table){
        let query = false;
        // Credits / Debits / Escrows
        if(['credits','debits','escrows'].includes(table)){
            query = `SELECT 
                        t1.tick,
                        a1.address
                    FROM 
                        ` + table + ` m
                        INNER JOIN index_tickers   t1 ON (t1.id=m.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=m.address_id)
                    WHERE 
                        m.action_index >= ?`;
        }

        // Contract staking (STAKE v3 / UNSTAKE v1 / DELEGATE v1+v3)
        if(['contract_stakes','contract_unstakes','contract_delegations'].includes(table)){
            query = `SELECT
                        t1.tick,
                        a1.address
                    FROM
                        ` + table + ` m
                        INNER JOIN index_tickers   t1 ON (t1.id=m.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=m.source_id)
                    WHERE
                        m.action_index >= ?`;
        }

        // AIRDROP / DESTROY
        if(['airdrops','destroys'].includes(table)){
            query = `SELECT 
                        t2.tick,
                        a2.address
                    FROM 
                        ` + table + ` m
                        INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_tickers   t2 ON (t2.id=m.tick_id)
                        INNER JOIN index_addresses a2 ON (a2.id=t1.source_id)
                    WHERE 
                        m.action_index >= ?`;
        }

        return query;
    },

    // Tables whose address comes from the transaction that carried the action, reached
    // through actions -> transactions, plus the extra destination/transfer sides.
    entityQueryForTransferTables(table){
        let query = false;
        // MINT / SEND / FEE
        if(['mints','sends','fees'].includes(table)){
            query = `SELECT 
                        t2.tick,
                        a2.address,
                        a3.address as address2
                    FROM 
                        ` + table + ` m
                        INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_tickers   t2 ON (t2.id=m.tick_id)
                        INNER JOIN index_addresses a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses a3 ON (a3.id=m.destination_id)
                    WHERE 
                        m.action_index >= ?`;
        }

        // ISSUE
        if(table=='issues'){
            query = `SELECT 
                        t2.tick,
                        a2.address,
                        a3.address as address2,
                        a4.address as address3
                    FROM 
                        ` + table + ` m
                        INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_tickers   t2 ON (t2.id=m.tick_id)
                        INNER JOIN index_addresses a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses a3 ON (a3.id=m.transfer_id)
                        LEFT  JOIN index_addresses a4 ON (a4.id=m.transfer_supply_id)
                    WHERE 
                        m.action_index >= ?`;
        }

        // SWAPS
        if(table=='swaps'){
            query = `SELECT 
                        t2.tick,
                        a2.address
                    FROM 
                        ` + table + ` m
                        INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_tickers   t2 ON (t2.id=m.give_tick_id)
                        INNER JOIN index_addresses a2 ON (a2.id=t1.source_id)
                    WHERE 
                        m.action_index >= ?`;
        }

        return query;
    },

    // The sweep source/destination pair, and the DEX tables that name a market pair by
    // its give/get tick and coin ids rather than an address.
    entityQueryForDexTables(table){
        let query = false;
        // SWEEPS
        if(table=='sweeps'){
            query = `SELECT 
                        a2.address,
                        a3.address as address2
                    FROM 
                        ` + table + ` m
                        INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_addresses a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses a3 ON (a3.id=m.destination_id)
                    WHERE 
                        m.action_index >= ?`;
        }

        // ORDERS / ORDER_MATCHES
        if(['orders','order_matches'].includes(table)){
            query = `SELECT 
                        m.give_tick_id as tick1_id,
                        m.get_tick_id  as tick2_id,
                        m.give_coin_id as coin1_id,
                        m.get_coin_id  as coin2_id
                    FROM 
                        ` + table + ` m
                    WHERE 
                        m.action_index >= ?`;
        }

        // COINPAY_OBLIGATIONS
        if(table=='coinpay_obligations'){
            query = `SELECT
                        om.give_tick_id as tick1_id,
                        om.get_tick_id  as tick2_id,
                        om.give_coin_id as coin1_id,
                        om.get_coin_id  as coin2_id
                    FROM
                        ` + table + ` m
                        INNER JOIN order_matches om ON (om.action_index=m.action_index)
                    WHERE
                        m.action_index >= ?`;
        }

        return query;
    },

    // COINPay and order-lifecycle rows, whose market pair is reached through the parent
    // obligation, match or order the row points at.
    entityQueryForCoinpayTables(table){
        let query = false;
        // COINPAY_EXPIRES / COINPAY_STATUSES / COINPAYS
        if(['coinpay_expires','coinpay_statuses','coinpays'].includes(table)){
            query = `SELECT
                        om.give_tick_id as tick1_id,
                        om.get_tick_id  as tick2_id,
                        om.give_coin_id as coin1_id,
                        om.get_coin_id  as coin2_id
                    FROM
                        ` + table + ` m
                        INNER JOIN coinpay_obligations co ON (co.action_index=m.` + (table=='coinpay_statuses' ? 'coinpay_action_index' : 'obligation_action_index') + `)
                        INNER JOIN order_matches       om ON (om.action_index=co.action_index)
                    WHERE
                        m.action_index >= ?`;
        }

        // ORDER_CANCELS / ORDER_EDITS / ORDER_EXPIRES
        if(['order_cancels','order_edits','order_expires'].includes(table)){
            query = `SELECT 
                        o1.give_tick_id as tick1_id,
                        o1.get_tick_id  as tick2_id,
                        o1.give_coin_id as coin1_id,
                        o1.get_coin_id  as coin2_id
                    FROM 
                        ` + table + ` m
                        INNER JOIN orders o1 ON (o1.action_index=m.order_action_index)
                    WHERE 
                        m.action_index >= ?`;
        }

        return query;
    },

    // The valid ATTEST batch heads a rolled-back chunk row belongs to, read strict.
    async readUnlandedAttestBatchRows(view, firstActionIndex){
        let query = `SELECT DISTINCT
                        LOWER(h.request_id)     AS batch_key,
                        h.action_index          AS action_index,
                        h.batch_window_start    AS window_start,
                        h.batch_window_end      AS window_end
                     FROM attests h
                        JOIN index_statuses hs ON hs.id = h.status_id AND hs.status = 'valid'
                        JOIN actions         hact ON hact.action_index = h.action_index
                        JOIN index_addresses hadr ON hadr.id = hact.source_id
                        JOIN attests c ON c.request_id = h.request_id
                                      AND c.version IN (${abw.ATTEST_BATCH_HEAD_VERSION}, ${abw.ATTEST_BATCH_CONTINUATION_VERSION})
                                      AND c.batch_chunk_index IS NOT NULL
                                      AND c.action_index >= ?
                        JOIN index_statuses cs ON cs.id = c.status_id AND cs.status = 'valid'
                        JOIN actions         cact ON cact.action_index = c.action_index
                        JOIN index_addresses cadr ON cadr.id = cact.source_id
                                                 AND cadr.address = hadr.address
                     WHERE h.version = ${abw.ATTEST_BATCH_HEAD_VERSION}
                       AND h.batch_chunk_index IS NOT NULL
                       AND h.batch_window_start IS NOT NULL
                       AND h.batch_window_end IS NOT NULL`;
        let rows = await view.doQueryStrict(query, [firstActionIndex]);
        return rows;
    },

};
