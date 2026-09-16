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
 * XChain Indexer - Database statements: rollback cooldown maturity reversal
 *
 * The reads and resets that undo a cooldown maturity orphaned by a reorg. Called
 * from src/rollback/cooldown_maturities.js inside the rollback transaction.
 *
 ********************************************************************/

'use strict';

module.exports = {

    // Source addresses of the surviving capability unstakes whose maturity is orphaned.
    async readMaturedCapabilitySources(db, completedStatusId, block_index){
        let capAffected = await db.doQuery(
            `SELECT a.address
                FROM unstakes u
                    JOIN index_addresses a ON a.id = u.source_id
                WHERE u.status_id = ? AND u.cooldown_end_block >= ? AND u.block_index < ?`,
            [completedStatusId, block_index, block_index]);
        return capAffected;
    },

    // Source addresses and ticks of the surviving contract unstakes whose maturity is orphaned.
    async readMaturedContractSources(db, completedStatusId, block_index){
        let conAffected = await db.doQuery(
            `SELECT a.address, t.tick
                FROM contract_unstakes cu
                    JOIN index_addresses a ON a.id = cu.source_id
                    JOIN index_tickers   t ON t.id = cu.tick_id
                WHERE cu.status_id = ? AND cu.cooldown_end_block >= ? AND cu.block_index < ?`,
            [completedStatusId, block_index, block_index]);
        return conAffected;
    },

    // Delete the two refund credits and put both completed flips back to valid.
    async reverseMaturedRefunds(db, gasTick, completedStatusId, validStatusId, block_index){
        let query;
        // Capability maturity refund is paid in GAS, keyed by the unstake's action_index.
        query = `DELETE c FROM credits c
                    JOIN unstakes u ON u.action_index = c.action_index AND u.source_id = c.address_id
                    JOIN index_tickers g ON g.id = c.tick_id AND g.tick = ?
                    WHERE u.status_id = ? AND u.cooldown_end_block >= ? AND u.block_index < ?`;
        await db.doQuery(query, [gasTick, completedStatusId, block_index, block_index]);
        // Contract maturity refund is paid in the unstake's own tick.
        query = `DELETE c FROM credits c
                    JOIN contract_unstakes cu ON cu.action_index = c.action_index
                                             AND cu.source_id   = c.address_id
                                             AND cu.tick_id     = c.tick_id
                    WHERE cu.status_id = ? AND cu.cooldown_end_block >= ? AND cu.block_index < ?`;
        await db.doQuery(query, [completedStatusId, block_index, block_index]);
        // Reset the in-place 'completed' flip back to 'valid' so the sweep re-matures the
        // cooldown once the new chain re-reaches cooldown_end_block.
        query = `UPDATE unstakes SET status_id = ?
                    WHERE status_id = ? AND cooldown_end_block >= ? AND block_index < ?`;
        await db.doQuery(query, [validStatusId, completedStatusId, block_index, block_index]);
        query = `UPDATE contract_unstakes SET status_id = ?
                    WHERE status_id = ? AND cooldown_end_block >= ? AND block_index < ?`;
        await db.doQuery(query, [validStatusId, completedStatusId, block_index, block_index]);
    },

};
