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
 * XChain Indexer - Database statements: rollback action-scoped purge and re-derives
 *
 * The generic action_index delete, the icon orphan sweep, and the escrow gate and
 * COINPay match-status re-derives, each one the body of the src/rollback/rederive.js
 * method of the same name. The two marked blocks are compared statement for
 * statement with the replica by the cross-repo drift guards.
 *
 ********************************************************************/

'use strict';

const { timedSweep } = require('./sweeps.js');

module.exports = {

    // Every dataTables row at or above the first orphaned action, sparing retraction write-aheads.
    async purgeActionScopedTables(db, dataTables, firstActionIndex){
        let query, args;
        for(let table of dataTables){
            query = `DELETE FROM ` + table + ` WHERE action_index >= ?`;
            args  = [firstActionIndex];
            // HUB-RETRACT-2 nested-reorg guard: never purge a prior rollback's durable
            // retraction write-ahead rows. They are keyed at that rollback's OWN
            // firstActionIndex, so a deeper later reorg's generic purge would delete an
            // UNDELIVERED retraction whose closed range [firstOld, lastOld] this reorg's
            // replacement rows cannot cover (those actions were already deleted, so the
            // new lastActionIndex sits below firstOld) - permanently orphaning
            // 'finalized' hub rows if delivery also fails here. Retractions are
            // idempotent and generation-fenced, so letting the older rows survive and
            // drain later is safe: their fence cannot delete rows re-published after
            // this reorg's generation bump.
            if(table === 'pending_hub_pushes'){
                query = `DELETE FROM pending_hub_pushes WHERE action_index >= ? AND push_type NOT IN ('price_retraction', 'xcall_retraction', 'match_retraction', 'bridge_retraction', 'attest_batch_retraction')`;
            }
            await db.doQuery(query, args);
        }
    },

    // icons rows whose token is gone, timed.
    async sweepOrphanedIcons(db){
        let query;
        query = `DELETE FROM icons WHERE token_id NOT IN (SELECT id FROM tokens)`;
        return timedSweep(db, 'icons', query, []);
    },

    // tokens.escrow_action_index re-derived from the surviving open GIVE_OWNERSHIP offers.
    async rederiveTokenEscrow(db){
        //<ESCROW-REDERIVE-SQL>
        const escrowAffectedTickersSql =
            `SELECT DISTINCT tk.tick FROM tokens t INNER JOIN index_tickers tk ON tk.id=t.tick_id WHERE t.escrow_action_index IS NOT NULL
             UNION
             SELECT DISTINCT tk.tick FROM index_tickers tk WHERE tk.id IN (
                 SELECT o.give_tick_id FROM orders o INNER JOIN order_statuses st ON st.order_action_index=o.action_index INNER JOIN index_statuses si ON si.id=st.status_id WHERE o.give_ownership=1 AND st.action_index=(SELECT MAX(x.action_index) FROM order_statuses x WHERE x.order_action_index=o.action_index) AND si.status IN ('open','cancelling','expiring')
                 UNION ALL
                 SELECT s.give_tick_id FROM swaps s INNER JOIN swap_statuses st ON st.swap_action_index=s.action_index INNER JOIN index_statuses si ON si.id=st.status_id WHERE s.give_ownership=1 AND st.action_index=(SELECT MAX(x.action_index) FROM swap_statuses x WHERE x.swap_action_index=s.action_index) AND si.status IN ('open','cancelling','expiring')
                 UNION ALL
                 SELECT d.give_tick_id FROM dispensers d INNER JOIN dispenser_statuses st ON st.dispenser_action_index=d.action_index INNER JOIN index_statuses si ON si.id=st.status_id WHERE d.give_ownership=1 AND st.action_index=(SELECT MAX(x.action_index) FROM dispenser_statuses x WHERE x.dispenser_action_index=d.action_index) AND si.status IN ('open','cancelling','expiring')
             )`;
        const escrowOpenOfferSql =
            `SELECT o.action_index FROM orders o INNER JOIN order_statuses st ON st.order_action_index=o.action_index INNER JOIN index_statuses si ON si.id=st.status_id INNER JOIN index_tickers tk ON tk.id=o.give_tick_id WHERE tk.tick=? AND o.give_ownership=1 AND st.action_index=(SELECT MAX(x.action_index) FROM order_statuses x WHERE x.order_action_index=o.action_index) AND si.status IN ('open','cancelling','expiring')
             UNION ALL
             SELECT s.action_index FROM swaps s INNER JOIN swap_statuses st ON st.swap_action_index=s.action_index INNER JOIN index_statuses si ON si.id=st.status_id INNER JOIN index_tickers tk ON tk.id=s.give_tick_id WHERE tk.tick=? AND s.give_ownership=1 AND st.action_index=(SELECT MAX(x.action_index) FROM swap_statuses x WHERE x.swap_action_index=s.action_index) AND si.status IN ('open','cancelling','expiring')
             UNION ALL
             SELECT d.action_index FROM dispensers d INNER JOIN dispenser_statuses st ON st.dispenser_action_index=d.action_index INNER JOIN index_statuses si ON si.id=st.status_id INNER JOIN index_tickers tk ON tk.id=d.give_tick_id WHERE tk.tick=? AND d.give_ownership=1 AND st.action_index=(SELECT MAX(x.action_index) FROM dispenser_statuses x WHERE x.dispenser_action_index=d.action_index) AND si.status IN ('open','cancelling','expiring')
             ORDER BY action_index ASC
             LIMIT 1`;
        //</ESCROW-REDERIVE-SQL>
        let escrowTickers = await db.doQuery(escrowAffectedTickersSql, []);
        for(let row of escrowTickers){
            let offerRows = await db.doQuery(escrowOpenOfferSql, [row.tick, row.tick, row.tick]);
            let newEscrow = (offerRows.length > 0) ? offerRows[0].action_index : null;
            await db.doQuery("UPDATE tokens SET escrow_action_index=? WHERE tick_id=(SELECT id FROM index_tickers WHERE tick=? LIMIT 1)", [newEscrow, row.tick]);
        }
    },

    // COINPay match statuses re-derived from the surviving fulfilled payments.
    async rederiveCoinpayMatchStatus(db){
        //<COINPAY-MATCH-REDERIVE-SQL>
        const coinpayMatchDemoteSql =
            `UPDATE order_matches SET status_id=(SELECT id FROM index_statuses WHERE status='pending_coinpay' LIMIT 1)
             WHERE settlement_type='coinpay'
               AND (SELECT id FROM index_statuses WHERE status='pending_coinpay' LIMIT 1) IS NOT NULL
               AND status_id=(SELECT id FROM index_statuses WHERE status='valid' LIMIT 1)
               AND action_index NOT IN (SELECT cs.coinpay_action_index FROM coinpay_statuses cs INNER JOIN index_statuses si ON si.id=cs.status_id WHERE si.status='fulfilled' AND cs.coinpay_action_index IS NOT NULL)`;
        const coinpayMatchPromoteSql =
            `UPDATE order_matches SET status_id=(SELECT id FROM index_statuses WHERE status='valid' LIMIT 1)
             WHERE settlement_type='coinpay'
               AND (SELECT id FROM index_statuses WHERE status='valid' LIMIT 1) IS NOT NULL
               AND status_id=(SELECT id FROM index_statuses WHERE status='pending_coinpay' LIMIT 1)
               AND action_index IN (SELECT cs.coinpay_action_index FROM coinpay_statuses cs INNER JOIN index_statuses si ON si.id=cs.status_id WHERE si.status='fulfilled' AND cs.coinpay_action_index IS NOT NULL)`;
        //</COINPAY-MATCH-REDERIVE-SQL>
        await db.doQuery(coinpayMatchDemoteSql, []);
        await db.doQuery(coinpayMatchPromoteSql, []);
    },

};
