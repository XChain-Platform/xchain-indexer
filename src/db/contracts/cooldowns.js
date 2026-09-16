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
 * XChain Indexer - Database mixin part: contracts / cooldowns
 *
 * The end-of-block cooldown sweep over unstakes and contract_unstakes, and the status
 * write that closes the swept rows.
 * Merged into the contracts mixin by db/contracts/index.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

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
        // Status filter - most existing unstakes carry 'valid' since createStatus normalizes that way.
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
        // Positivity filter is cast at DECIMAL(60,18) (not 30,8) so a contract refund finer than
        // 8 dp on an >8-dp token isn't truncated to 0 and stranded as a never-swept 'pending' row.
        // XCHAIN(8) and every <=8-dp refund evaluate identically under either scale (item 5303).
        let conQ = `SELECT cu.action_index, cu.amount, a.address AS source_address, t.tick AS tick
                    FROM contract_unstakes cu
                        LEFT JOIN index_addresses a ON (a.id = cu.source_id)
                        LEFT JOIN index_tickers   t ON (t.id = cu.tick_id)
                    WHERE cu.cooldown_end_block <= ?
                      AND cu.status_id IN (${placeholders})
                      AND CAST(cu.amount AS DECIMAL(60,18)) > 0
                    ORDER BY cu.action_index ASC`;
        let conRows = await this.doQuery(conQ, [currentBlock, ...statusIds]);
        let contractRows = [];
        for(let row of conRows){
            credits.push([row.tick, String(row.amount), row.source_address]);
            contractRows.push(row.action_index);
        }
        return { credits, capabilityRows, contractRows, completedId };
    },

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
    },

};
