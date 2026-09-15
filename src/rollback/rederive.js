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
 * XChain Indexer - Rollback: action-scoped purge and re-derives
 *
 * The generic action_index delete and what must run straight after it: the icon
 * orphan sweep and the two re-derives of state a surviving row carries. Installed
 * onto Rollback.prototype by ./index.js; the statements are in
 * src/db/rollback/rederive.js.
 *
 ********************************************************************/

'use strict';

const rederiveSql = require('../db/rollback/rederive.js');

module.exports = {

    // Loop through the data tables and delete records above the action_index.
    // This is the whole price rollback path for `prices`: an orphaned PRICE v0
    // round row and an orphaned PRICE batch row are both removed WHOLESALE by
    // action_index, so batch_first_round/batch_last_round/round_count/rounds_json
    // are cleared exactly as round_number/pairs_json/sigs_json are, by virtue of
    // the row itself being gone; no v2-specific delete or partial-column reset is
    // needed on top of this generic loop.
    async purgeActionScopedTables(firstActionIndex){
        await rederiveSql.purgeActionScopedTables(this.indexerDb, this.dataTables, firstActionIndex);
    },

    // Sweep orphaned icon-cache rows. icons is a metadata cache keyed by
    // token_id with no action_index/block_index of its own, so it escapes
    // both delete loops. When a token row is removed above (tokens is in
    // dataTables) any icons row pointing at it is left dangling. With
    // no enforced FK the DB won't cascade the delete. A stale orphan makes
    // the icon-fetch pipeline believe an icon already exists for a token
    // that no longer does. Runs after the loop, so the tokens rows are
    // already gone before the orphan sweep evaluates the sub-query.
    async sweepOrphanedIcons(){
        await rederiveSql.sweepOrphanedIcons(this.indexerDb);
    },

    // Re-derive tokens.escrow_action_index (the ownership-escrow gate) for every
    // affected token. MUST run AFTER the dataTables delete: orphaned offer rows
    // (orders/swaps/dispensers) and their append-only status rows
    // (order_statuses/swap_statuses/dispenser_statuses) are now gone, so a surviving
    // offer whose closing action was orphaned has reverted to its latest surviving
    // status. setTokenEscrow stamps the gate with the OFFER's action_index and
    // clearTokenEscrow NULLs it on release; the in-place stamp survives the delete and
    // updateTokens never touches the escrow column. A single re-derive collapses both
    // rollback directions (orphaned offer -> NULL; orphaned release on a surviving
    // offer -> re-stamp; nothing relevant orphaned -> reproduces the current value)
    // and byte-matches a from-genesis replay (the gate is always exactly the offer's
    // action_index). Affected set = tokens currently escrowed (Class A) UNION tokens
    // with a surviving still-escrowed GIVE_OWNERSHIP offer (Class B), provably
    // complete: a token in neither cannot have a wrong escrow value. A token's gate
    // is held while its GIVE_OWNERSHIP offer's latest status is open/cancelling/
    // expiring (two-phase COINPay states keep escrow set); cleared only at a terminal
    // status, written in the same action as the escrow clear. Alias `si` (not the
    // SQL keyword `is`). The SQL between the ESCROW-REDERIVE-SQL markers is kept
    // logically identical with xchain-sync/src/client/rollback.js; a cross-repo drift
    // guard (xchain-sync test/unit/rollback_coverage.test.js) asserts they match, so
    // source + replica derive byte-identical escrow_action_index values.
    async rederiveTokenEscrow(){
        await rederiveSql.rederiveTokenEscrow(this.indexerDb);
    },

    // Re-derive order_matches.status for COINPay matches, AFTER the dataTables
    // delete and for the same reason the escrow gate above is re-derived there.
    // A COINPay match is written `pending_coinpay` (actions/order_match.js) and
    // promoted IN PLACE to `valid` by the settling COINPAY
    // (actions/coinpay.js -> updateOrderMatchStatus, UPDATE order_matches SET
    // status_id=? WHERE action_index=?). The promoted row belongs to an EARLIER
    // action than the COINPAY, so a reorg that orphans the payment deletes the
    // payment's rows and leaves the promotion standing: the match reads `valid`
    // where a from-genesis replay reads `pending_coinpay`, and the valid-only
    // last-trade and 24h price reads keep counting a settlement that no longer
    // exists.
    //
    // Settlement proof is the same thing the forward handler writes: a
    // `fulfilled` coinpay_statuses row for the obligation, whose
    // coinpay_action_index IS the match's action_index (createCoinpayStatus is
    // called with the obligation's index, and coinpay_obligations.action_index =
    // order_matches.action_index). Those status rows are action-scoped, so the
    // generic delete has already removed the orphaned one by the time this runs.
    //
    // Re-derived rather than range-reset, for the reason this file already states
    // for the escrow gate: a range reset handles only the SET direction, while a
    // re-derive collapses both and is idempotent, so it also self-heals rows an
    // earlier reorg left wrong. Both statements are restricted to rows whose
    // status actually disagrees, and both no-op when the target status has never
    // been minted in index_statuses, so neither can blank a status_id.
    // `pending_coinpay` and `valid` are the only two values a COINPay match ever
    // takes (updateOrderMatchStatus has exactly one caller), so anything else is
    // left untouched rather than guessed at.
    //
    // The SQL between the COINPAY-MATCH-REDERIVE-SQL markers is kept logically
    // identical with xchain-sync/src/client/rollback.js; a cross-repo drift guard
    // (xchain-sync test/unit/rollback_coverage.test.js) asserts they match, so
    // source and replica derive the same match statuses.
    async rederiveCoinpayMatchStatus(){
        await rederiveSql.rederiveCoinpayMatchStatus(this.indexerDb);
    },

};
