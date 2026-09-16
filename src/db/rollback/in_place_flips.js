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
 * XChain Indexer - Database statements: rollback in-place flip resets
 *
 * The resets that undo an orphaned action's in-place write on a surviving row, each
 * one the body of the src/rollback/in_place_flips.js method of the same name, where
 * the fork each one closes is stated. Run inside the rollback transaction.
 *
 ********************************************************************/

'use strict';

module.exports = {

    // contract_emissions references contract_executions, so it goes first.
    async deleteContractEmissions(db, firstActionIndex){
        let query, args;
        query = `DELETE FROM contract_emissions WHERE execution_index IN
                    (SELECT action_index FROM contract_executions WHERE action_index >= ?)`;
        args  = [firstActionIndex];
        await db.doQuery(query, args);
    },

    // ATTEST v0 requests whose terminal flip is orphaned go back to pending.
    async resetOrphanedAttestRequests(db, block_index){
        let query, args;
        query = `UPDATE attests
                    SET request_status = 'pending', resolved_block = NULL
                    WHERE version = 0
                      AND request_status IN ('fulfilled', 'errored', 'expired')
                      AND resolved_block >= ?`;
        args  = [block_index];
        await db.doQuery(query, args);
    },

    // XCALL v0 requests whose terminal flip is orphaned go back to pending.
    async resetOrphanedXcallRequests(db, block_index){
        let query, args;
        query = `UPDATE xcalls
                    SET request_status = 'pending', result_status = NULL,
                        result_payload = NULL, resolved_block = NULL,
                        callback_action_index = NULL
                    WHERE version = 0 AND request_status IN ('completed', 'expired')
                      AND resolved_block >= ?`;
        args  = [block_index];
        await db.doQuery(query, args);
    },

    // VOTE polls whose finalization is orphaned re-open with every result column cleared.
    async reopenOrphanedPolls(db, block_index){
        let query, args;
        query = `UPDATE polls
                    SET poll_status = 'open', winning_option = NULL, total_weight = NULL,
                        total_voters = NULL, quorum_met = NULL, min_voters_met = NULL,
                        fail_reason = NULL, decided_early = NULL, effective_close_block = NULL,
                        finalized_action_index = NULL, resolved_block = NULL,
                        deposit_resolved = NULL, callback_execute_action_index = NULL,
                        callback_due_block = NULL
                    WHERE poll_status IN ('finalized', 'failed_quorum')
                      AND resolved_block >= ?`;
        args  = [block_index];
        await db.doQuery(query, args);
    },

    // The three BET feed resets in their required order, then the bet settlement reset.
    async resetOrphanedBetFlips(db, block_index){
        let query, args;
        await db.createStatus('open');
        await db.createStatus('closed');
        query = `UPDATE bet_feeds f
                    JOIN index_statuses cs ON (cs.status = 'closed')
                    SET f.feed_status_id = cs.id, f.terminal_block = NULL
                    WHERE f.terminal_block >= ?
                      AND f.closed_block IS NOT NULL
                      AND f.closed_block < ?`;
        args  = [block_index, block_index];
        await db.doQuery(query, args);
        query = `UPDATE bet_feeds f
                    JOIN index_statuses os ON (os.status = 'open')
                    SET f.feed_status_id = os.id, f.terminal_block = NULL
                    WHERE f.terminal_block >= ?
                      AND (f.closed_block IS NULL OR f.closed_block >= ?)`;
        args  = [block_index, block_index];
        await db.doQuery(query, args);
        query = `UPDATE bet_feeds f
                    JOIN index_statuses os ON (os.status = 'open')
                    SET f.feed_status_id = os.id, f.closed_block = NULL
                    WHERE f.closed_block >= ?`;
        args  = [block_index];
        await db.doQuery(query, args);
        // Bets settled in the orphaned range re-open (their terminal
        // credits/escrow releases are deleted generically, so the stake
        // is back in escrow, exactly the pre-settlement state)
        query = `UPDATE bets b
                    JOIN index_statuses os ON (os.status = 'open')
                    SET b.bet_status_id = os.id, b.settled_block = NULL
                    WHERE b.settled_block >= ?`;
        args  = [block_index];
        await db.doQuery(query, args);
    },

    // A fired binding callback whose due block is orphaned is re-armed.
    async resetOrphanedPollCallbacks(db, block_index){
        let query, args;
        query = `UPDATE polls
                    SET callback_execute_action_index = NULL
                    WHERE poll_status IN ('finalized', 'failed_quorum')
                      AND callback_due_block >= ?
                      AND callback_execute_action_index IS NOT NULL`;
        args  = [block_index];
        await db.doQuery(query, args);
    },

    // The four deactivation_block resets: two by child join, two by value threshold.
    async clearOrphanedDeactivations(db, block_index, activationDelay){
        let query, args;

        // stakes ← orphaned unstakes (capability staking)
        query = `UPDATE stakes s
                    JOIN unstakes u ON u.signing_pubkey_id = s.signing_pubkey_id
                    SET s.deactivation_block = NULL
                    WHERE u.block_index >= ?
                      AND s.deactivation_block IS NOT NULL
                      AND s.deactivation_block = u.block_index + ?`;
        args = [block_index, activationDelay];
        await db.doQuery(query, args);

        // delegations ← orphaned DELEGATE-revoke and ROLLCALL-eviction stamps. The revoke
        // stopped writing a child delegations row at the DELEGATE_REVOKE_NO_REINSERT
        // flag-day (actions/delegate.js), so the old self-join on that row matched nothing
        // for any post-flag-day revoke and the surviving parent kept its stamp. Key on the
        // value threshold instead, exactly as contract_delegations does below.
        // INVARIANT: every writer of delegations.deactivation_block stamps
        // actionBlock + ACTIVATION_DELAY_BLOCKS (setDelegationDeactivation from
        // actions/delegate.js, setAllDelegationDeactivationsBySource from
        // rollcall_close.js), so a SURVIVING stamper wrote a strictly smaller value. A new
        // writer using a different offset MUST update this query.
        query = `UPDATE delegations
                    SET deactivation_block = NULL
                    WHERE deactivation_block IS NOT NULL
                      AND deactivation_block >= ?`;
        args = [Number(block_index) + activationDelay];
        await db.doQuery(query, args);

        // contract_stakes ← orphaned contract_unstakes (contract staking, all chains)
        query = `UPDATE contract_stakes cs
                    JOIN contract_unstakes cu
                      ON cu.signing_pubkey_id     = cs.signing_pubkey_id
                     AND cu.target_contract_index = cs.target_contract_index
                     AND cu.tick_id               = cs.tick_id
                    SET cs.deactivation_block = NULL
                    WHERE cu.block_index >= ?
                      AND cs.deactivation_block IS NOT NULL
                      AND cs.deactivation_block = cu.block_index + ?`;
        args = [block_index, activationDelay];
        await db.doQuery(query, args);

        // contract_delegations ← orphaned DELEGATE v3 contract-revokes. No child row
        // exists (pure in-place UPDATE), so key on the value threshold: anything at or
        // above block_index + activationDelay was stamped by an orphaned revoke.
        query = `UPDATE contract_delegations
                    SET deactivation_block = NULL
                    WHERE deactivation_block IS NOT NULL
                      AND deactivation_block >= ?`;
        args = [Number(block_index) + activationDelay];
        await db.doQuery(query, args);
    },

};
