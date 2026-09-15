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
 * XChain Indexer - Rollback: cooldown maturity reversal
 *
 * The unconditional first step of the rollback transaction. Installed onto
 * Rollback.prototype by ./index.js; the statements are in
 * src/db/rollback/cooldown_maturities.js.
 *
 ********************************************************************/

'use strict';

const maturitySql = require('../db/rollback/cooldown_maturities.js');

module.exports = {

    // Reverse cooldown-maturity completions whose maturity block was orphaned by the reorg.
    // When a capability/contract UNSTAKE cooldown elapses, processCooldownCompletions finalizes
    // it by (1) writing a refund credit and (2) flipping the unstake row's status_id to
    // 'completed' IN PLACE (db.markCooldownsCompleted). In the LEGACY attribution era (before
    // UNSTAKE_COOLDOWN_COMPLETION_ACTION activates) the credit is keyed on the UNSTAKE's OWN
    // action_index and NO actions row is minted in the maturity block, so both effects live on a
    // SURVIVING row (block_index < reorg point) and neither the generic action-range nor block
    // deletes can undo them; worse, an orphaned range with no other actions leaves firstActionIndex
    // null, so this MUST run unconditionally (outside the firstActionIndex guard) or the reversal is
    // skipped entirely. The maturity fires at cooldown_end_block, in the orphaned range whenever
    // cooldown_end_block >= block_index, so a from-genesis replay to block_index-1 has neither the
    // refund credit nor the 'completed' status. Without this reset the reorged node keeps an extra
    // refund (updateBalances re-counts it) and a 'completed' row the re-maturity sweep (status_id IN
    // (pending,valid), db.sweepCompletedCooldowns) then skips forever: a permanent credits/balances/
    // unstakes divergence and a hard balance fork if a SLASH reduces the stake before the new chain
    // re-matures. createUnstake only ever writes 'valid' (unstake.js), so the from-genesis-equivalent
    // reset target is 'valid'. Scope to SURVIVING unstake rows (block_index < block_index); orphaned-
    // range unstakes and their credits are removed wholesale by the dataTables delete. Runs inside the
    // rollback transaction, BEFORE the blockTables delete and BEFORE updateBalances/updateTokens (the
    // seeded addresses/ticks feed the unconditional recompute via the live util lists). No-op when no
    // maturity landed in the range (every predicate is keyed on block_index / cooldown_end_block).
    async reverseCooldownMaturities(block_index){
        let completedStatusId = await this.indexerDb.getStatusId('completed');
        let validStatusId     = await this.indexerDb.getStatusId('valid');
        if(completedStatusId === null || validStatusId === null)
            return;
        let gasTick = this.config['GAS'];
        // Feed the affected source address + tick of every reversed maturity into the
        // balance/supply recompute set. These unstake rows live in surviving blocks, so the
        // read-phase scan never saw them and neither `addresses` nor `tickers` holds them. The
        // refund credit is a net mint (its STAKE-time debit was burned), so deleting it must drop
        // both the source's cached balance AND the tick's tokens.supply; without seeding the
        // recompute here, updateBalances/updateTokens skip these rows and the cached projection
        // keeps the now-deleted refund (and trips the per-block supply sanityCheck). Collect BEFORE
        // the status reset below, which clears the status_id = 'completed' filter.
        let capAffected = await maturitySql.readMaturedCapabilitySources(this.indexerDb, completedStatusId, block_index);
        for(let row of capAffected)
            this.util.addAddressTicker(row.address, gasTick);
        let conAffected = await maturitySql.readMaturedContractSources(this.indexerDb, completedStatusId, block_index);
        for(let row of conAffected)
            this.util.addAddressTicker(row.address, row.tick);
        await maturitySql.reverseMaturedRefunds(this.indexerDb, gasTick, completedStatusId, validStatusId, block_index);
    },

};
