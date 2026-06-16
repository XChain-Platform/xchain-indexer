/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - Rollback Class
 * 
 * This file handles processing rollbacks and updating the database
 *
 ********************************************************************/

const crypto = require('crypto');

class Rollback {

    // Handle constructing a class instance
    constructor(indexer){
        // Parse in indexer configuration
        this.config    = indexer.config;

        // Setup alias to the indexer database connection
        this.decoderDb = indexer.decoderDb;
        this.indexerDb = indexer.indexerDb;

        // Setup alias to the utility class
        this.util      = indexer.util;

        // Setup alias to the hub client (used to retract price rows + cross_chain_calls
        // relay rows seeded from rolled-back PRICE / XCALL actions on the cross-chain hub)
        this.hubClient = indexer.hubClient;

        // Setup alias to the indexer protocol changes instance
        this.protocolChanges = indexer.protocolChanges;

        // List of tables that store data using block_index
        this.blockTables = [
            'blocks',
            'transactions',
            'validator_rewards',
            'contract_state',
            'slash_events',
            // Per-row slash debit log (one row per in-place contract_stakes/contract_unstakes
            // amount reduction). Block-scoped (rollback key = block_index, same as slash_events).
            // The restore below reads it BEFORE this generic delete drops the orphaned rows.
            'contract_slash_debits',
            // Capability-stake equivocation slashing (WI-2 bump 2). Audit + per-row debit log,
            // both block-scoped like their contract twins; the capability_slash_debits restore
            // below runs BEFORE these generic deletes.
            'capability_slash_events',
            'capability_slash_debits'
        ];

        // List of tables that store data using action_index
        this.dataTables = [
            'actions',
            'addresses',
            'airdrops',
            'batches',
            'broadcasts',
            'callbacks',
            'credits',
            'debits',
            'coinpay_expires',
            'coinpay_obligations',
            'coinpay_statuses',
            'coinpays',
            'destroys',
            'dispensers',
            'dispenser_cancels',
            'dispenser_closes',
            'dispenser_edits',
            'dispenser_expires',
            'dispenser_statuses',
            'dispenses',
            'dividends',
            'escrows',
            'fees',
            'files',
            'gated_files',
            'issues',
            'links',
            'lists',
            'list_edits',
            'list_items',
            'list_items_invalid',
            'mappings_actions',
            'mappings_files',
            'messages',
            'mints',
            'orders',
            'order_cancels',
            'order_edits',
            'order_expires',
            'order_matches',
            'order_statuses',
            'sends',
            'sleeps',
            'swaps',
            'swap_cancels',
            'swap_edits',
            'swap_expires',
            'swap_matches',
            'swap_statuses',
            'cross_chain_settlements',
            'cross_chain_call_executions',
            'cross_chain_call_callbacks',
            'xcalls',
            'sweeps',
            'tokens',
            'stakes',
            'unstakes',
            'delegations',
            'stake_key_revocations',
            'reward_claims',
            // NODEPROOF verdict rows (verified full-node tier). Keyed by the verdict's
            // action_index (one verdict writes one row per PASS pubkey, all sharing it),
            // so the generic action_index delete drops a reorged verdict and all its
            // verification rows together — verified status can't survive a reorg.
            'full_node_verifications',
            'contracts',
            'contract_permissions',
            'deploy_chunks',
            'contract_stakes',
            'contract_unstakes',
            'contract_delegations',
            'contract_executions',
            'deposits',
            'withdrawals',
            'anchor_actions',
            'attests',
            'prices',
            'pending_hub_pushes',
            // Programmable policy layer — append-only controller bind/unbind event logs. Each event
            // row is keyed by its own action_index and never mutated (cooldown expiry is computed at
            // read time), so the generic action_index delete reverts orphaned binds/unbinds exactly.
            'token_controllers',
            'address_controllers'
        ];

        // NOTE: the index_* lookup tables (index_addresses, index_tickers, index_statuses,
        // index_actions, ...) are intentionally NOT rolled back. Their rows are created on
        // first reference via INSERT IGNORE and their AUTO_INCREMENT ids never rewind, so a
        // row first seen in a later-orphaned block survives the reorg. That is safe because
        // those surrogate ids are purely local artifacts and feed NO consensus value: the
        // block hashes resolve them to canonical strings before hashing (BLOCK_HASH_VERSION 2,
        // see db.getBlockHashes). Do not reintroduce a raw lookup id into any hashed projection
        // — if you do, these un-rolled-back rows will fork checkpoint hashes after a reorg.

    }

    // Handle rolling back data to a specific block
    async rollback(block_index){
        // Start tracking time of rollback
        var rollbackTimer = this.util.startTimer();

        // Notify user of start of rollback
        console.log('Starting rollback to block ' + block_index + '...');

        // Reset the address/tickers/transactions lists
        this.util.resetLists();

        // Placeholder for the first action_index. Initialized to null (not a
        // falsy number) so the guards below distinguish "no actions in range"
        // from a legitimate action_index of 0 — Number(0) is falsy, so a false
        // sentinel would silently skip all rollback processing and the hub
        // price retraction whenever the lowest rolled-back action is index 0.
        let firstActionIndex = null;

        // Placeholder for market pairs
        let markets = [];

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
        let rows = await this.indexerDb.doQuery(query, args);
        if(rows.length > 0)
            firstActionIndex = Number(rows[0].action_index);

        // Handle looking up data for any action_indexes in the rollback
        if(firstActionIndex !== null){

            // Loop through the data tables and build out list of addresses and tickers
            for(let table of this.dataTables){

                // Build out the correct SQL to pull address and ticker data from the various tables
                query = false;
                args  = [firstActionIndex];

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
                                m.get_tick_id  as tick2_id
                            FROM 
                                ` + table + ` m
                            WHERE 
                                m.action_index >= ?`;
                }

                // COINPAY_OBLIGATIONS
                if(table=='coinpay_obligations'){
                    query = `SELECT
                                om.give_tick_id as tick1_id,
                                om.get_tick_id  as tick2_id
                            FROM
                                ` + table + ` m
                                INNER JOIN order_matches om ON (om.action_index=m.action_index)
                            WHERE
                                m.action_index >= ?`;
                }

                // COINPAY_EXPIRES / COINPAY_STATUSES / COINPAYS
                if(['coinpay_expires','coinpay_statuses','coinpays'].includes(table)){
                    query = `SELECT
                                om.give_tick_id as tick1_id,
                                om.get_tick_id  as tick2_id
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
                                o1.get_tick_id  as tick2_id
                            FROM 
                                ` + table + ` m
                                INNER JOIN orders o1 ON (o1.action_index=m.order_action_index)
                            WHERE 
                                m.action_index >= ?`;
                }

                // Run the query and populate the addresses, tickers, and markets arrays
                if(query){
                    let rows = await this.indexerDb.doQuery(query, args);
                    for(let row of rows){
                        // Populate addresses and tickers arrays
                        if(!this.util.isNull(row.address))
                            this.util.addAddressTicker(row.address, row.tick);
                        if(!this.util.isNull(row.address2))
                            this.util.addAddressTicker(row.address2, row.tick);
                        if(!this.util.isNull(row.address3))
                            this.util.addAddressTicker(row.address3, row.tick);
                        // Build out list of DEX market pairs
                        if(!this.util.isNull(row.tick1_id) && !this.util.isNull(row.tick2_id)){
                            let found = false;
                            for(let pair of markets){
                                if((pair.tick1_id == row.tick1_id && pair.tick2_id == row.tick2_id) || (pair.tick1_id == row.tick2_id && pair.tick2_id == row.tick1_id))
                                    found = true;
                            }
                            if(!found){
                                markets.push({
                                    tick1_id: Number(row.tick1_id),
                                    tick2_id: Number(row.tick2_id)
                                });
                            }
                        }
                    }
                }
            }
        }

        // Get lists of addresses, tickers, and transactions (collected during read phase above)
        let addresses = this.util.getAddressesList();
        let tickers   = this.util.getTickersList();

        // Begin a transaction — all deletes and recalculations are atomic
        await this.indexerDb.beginTransaction();
        try {

            // Delete contract_emissions first (references contract_executions)
            if(firstActionIndex !== null){
                query = `DELETE FROM contract_emissions WHERE execution_index IN
                            (SELECT action_index FROM contract_executions WHERE action_index >= ?)`;
                args  = [firstActionIndex];
                await this.indexerDb.doQuery(query, args);
            }

            if(firstActionIndex !== null){

                // Reset ATTEST v0 (request) rows whose TERMINAL flip happened in the
                // orphaned range. The forward path flips a request from 'pending' to
                // 'fulfilled'/'errored' (v1 response) or 'expired' (v2 expiry) via a
                // direct UPDATE on the request row (created in an EARLIER block, so
                // it survives the bulk delete below). Without the reset, the
                // surviving request is stuck non-'pending': a re-applied response is
                // rejected as already-resolved, the contract callback never fires,
                // and — for a reorged expiry — the deadline sweep (pending-only)
                // never re-synthesizes the v2 row, diverging a reorged node from a
                // fresh sync. Keyed on resolved_block (recorded at flip time) so
                // BOTH flip paths reset; this replaced the v1-only self-join, which
                // could not see v2 expiries (they flip without a correlated v1 row).
                query = `UPDATE attests
                            SET request_status = 'pending', resolved_block = NULL
                            WHERE version = 0
                              AND request_status IN ('fulfilled', 'errored', 'expired')
                              AND resolved_block >= ?`;
                args  = [block_index];
                await this.indexerDb.doQuery(query, args);

                // Reset XCALL v0 (request) rows whose terminal flip (result callback
                // or deadline expiry) happened in the orphaned range. The flip is a
                // direct UPDATE on the surviving request row, so the bulk delete
                // below can't undo it — without this reset, a re-applied result row
                // hits the already-resolved interlock and the contract's callback is
                // silently lost (and an expiry never re-arms). Keyed on
                // resolved_block (recorded at flip time) so BOTH flip paths reset.
                query = `UPDATE xcalls
                            SET request_status = 'pending', result_status = NULL,
                                result_payload = NULL, resolved_block = NULL,
                                callback_action_index = NULL
                            WHERE version = 0 AND request_status IN ('completed', 'expired')
                              AND resolved_block >= ?`;
                args  = [block_index];
                await this.indexerDb.doQuery(query, args);

                // tokens.escrow_action_index (the ownership-escrow gate) is RE-DERIVED below,
                // AFTER the dataTables delete — see rederiveTokenEscrow(). A range reset here
                // could only handle the SET direction (offer orphaned); it cannot handle the
                // CLEAR direction (a surviving offer whose release was orphaned), so the
                // re-derive replaces it entirely.

                // Re-NULL deactivation_block stamps that orphaned UNSTAKE / DELEGATE-revoke
                // actions wrote IN PLACE on surviving parent stake/delegation rows. Each
                // forward handler (createUnstake, the DELEGATE-revoke path,
                // createContractUnstake, the contract-revoke path) marks an ALREADY-ACTIVE
                // parent row — created by a much earlier STAKE/DELEGATE in a surviving block —
                // with deactivation_block = actionBlock + activationDelay. The bulk delete
                // below removes the orphaned action row but cannot undo that in-place UPDATE,
                // so without this reset the surviving parent keeps a non-NULL deactivation_block.
                // Every active-set read gates on (deactivation_block IS NULL OR
                // deactivation_block > currentBlock), so once the new chain passes the stale
                // value the staker/validator silently drops out of the active set on the
                // reorged node while a from-genesis replay keeps it active — a consensus-
                // affecting divergence (capability staking on BTC, contract staking on all chains).
                //
                // The reset must be PRECISE: a surviving UNSTAKE in an earlier block stamps
                // earlierBlock + activationDelay, which can itself land at/after block_index, so
                // a blanket `deactivation_block >= block_index` would wrongly clear legitimately-
                // earned deactivations. We instead match the EXACT value an orphaned action
                // wrote. For the three tables that record a child action row (stakes↔unstakes,
                // delegations↔revoke-rows, contract_stakes↔contract_unstakes) we JOIN the
                // surviving parent to its orphaned action row on the same keys the forward
                // handler used and require deactivation_block = orphanBlock + activationDelay.
                // The DELEGATE v3 contract-revoke records NO child row (a pure in-place UPDATE),
                // so contract_delegations is keyed on the value threshold block_index +
                // activationDelay — equivalently precise, because any surviving revoke stamps a
                // strictly smaller value (survivingBlock < block_index).
                let staking         = this.config['STAKING'];
                let activationDelay = Number((staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS']);

                // stakes ← orphaned unstakes (capability staking)
                query = `UPDATE stakes s
                            JOIN unstakes u ON u.signing_pubkey_id = s.signing_pubkey_id
                            SET s.deactivation_block = NULL
                            WHERE u.block_index >= ?
                              AND s.deactivation_block IS NOT NULL
                              AND s.deactivation_block = u.block_index + ?`;
                args = [block_index, activationDelay];
                await this.indexerDb.doQuery(query, args);

                // delegations ← orphaned DELEGATE-revoke rows. A revoke is itself a delegations
                // row keyed by its own action_index; the parent it stamped is an earlier
                // delegations row for the same source + signing pubkey (self-join).
                query = `UPDATE delegations p
                            JOIN delegations r
                              ON r.source_id = p.source_id
                             AND r.signing_pubkey_id = p.signing_pubkey_id
                            SET p.deactivation_block = NULL
                            WHERE r.block_index >= ?
                              AND p.deactivation_block IS NOT NULL
                              AND p.deactivation_block = r.block_index + ?`;
                args = [block_index, activationDelay];
                await this.indexerDb.doQuery(query, args);

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
                await this.indexerDb.doQuery(query, args);

                // contract_delegations ← orphaned DELEGATE v3 contract-revokes. No child row
                // exists (pure in-place UPDATE), so key on the value threshold: anything at or
                // above block_index + activationDelay was stamped by an orphaned revoke.
                query = `UPDATE contract_delegations
                            SET deactivation_block = NULL
                            WHERE deactivation_block IS NOT NULL
                              AND deactivation_block >= ?`;
                args = [Number(block_index) + activationDelay];
                await this.indexerDb.doQuery(query, args);

                // Restore stake amounts an orphaned SLASH reduced IN PLACE on surviving rows.
                // slashContractStake debits contract_stakes/contract_unstakes.amount on rows
                // from earlier (surviving) blocks and records each debit's pre-slash
                // `prev_amount` in contract_slash_debits. The generic deletes below drop the
                // orphaned debit rows but cannot revert the in-place reduction, so without this
                // a surviving row keeps its slashed amount while a from-genesis replay (slash
                // never re-mined) keeps the original — a consensus-affecting divergence (active
                // stake drives VM staker weighting, quorum eligibility, and cooldown refunds on
                // all chains). We copy back the EARLIEST orphaned debit's `prev_amount` per row
                // (min block_index, then (execution_index, slash_position) tiebreak — the same
                // deterministic total order the block-hash preimage uses for contract_emissions,
                // so it is replay-stable and identical across the source indexer and every
                // replica; the AUTO_INCREMENT `id` is NOT, and would let two nodes restore a
                // divergent amount on a reorg that retracts a block with ≥2 slashes against one
                // stake row) — a pure string copy, so the restored value is
                // byte-identical to the surviving chain's pre-orphaned-slash state and to a fresh
                // replay (no arithmetic / decimal-format drift). Earlier SURVIVING debits
                // (block_index < block_index) are intentionally left applied. Runs BEFORE the
                // deletes so the debit rows and target rows still exist.
                for(let slashTbl of ['contract_stakes', 'contract_unstakes']){
                    query = `UPDATE ` + slashTbl + ` t
                                JOIN contract_slash_debits d ON d.stake_action_index = t.action_index
                                SET t.amount = d.prev_amount
                                WHERE d.target_table = ?
                                  AND d.block_index >= ?
                                  AND NOT EXISTS (
                                      SELECT 1 FROM contract_slash_debits e
                                      WHERE e.target_table      = d.target_table
                                        AND e.stake_action_index = d.stake_action_index
                                        AND e.block_index >= ?
                                        AND (e.block_index < d.block_index
                                             OR (e.block_index = d.block_index
                                                 AND (e.execution_index < d.execution_index
                                                      OR (e.execution_index = d.execution_index
                                                          AND e.slash_position < d.slash_position)))))`;
                    args = [slashTbl, block_index, block_index];
                    await this.indexerDb.doQuery(query, args);
                }

                // Same restore for CAPABILITY-stake equivocation slashes (WI-2 bump 2):
                // slashCapabilityStake reduces stakes/unstakes.amount IN PLACE on surviving
                // rows and logs the pre-slash `prev_amount` in capability_slash_debits. Copy
                // back the EARLIEST orphaned debit's prev_amount per row (min block_index, then
                // slash_action_index tiebreak) — a pure string copy, byte-identical to the
                // surviving chain and to a from-genesis replay where the SLASH was never
                // re-mined. Earlier SURVIVING debits (block_index < block_index) stay applied.
                // Runs BEFORE the generic deletes so both the debit rows and the target rows
                // still exist.
                //
                // The same-block tiebreak is slash_action_index, NOT the AUTO_INCREMENT `id`:
                // capability slashes are permissionless SLASH WIRE actions, so slash_action_index
                // is a deterministic, replay-stable action_index (assigned by the idempotent
                // compound-key path, not force=true). Ordering by `id` would let two nodes whose
                // AUTO_INCREMENT chains were assigned in a different order (live vs from-genesis
                // replay) restore a different prev_amount on a reorg that retracts a block with
                // ≥2 slashes against one stake row → a stake-weight fork. (The CONTRACT twin in
                // the restore above keys on the same idea: VM-emitted slashes have no wire
                // action_index, so it orders by (execution_index, slash_position) — the EXECUTE's
                // on-chain action_index plus the emission-loop index, the identical deterministic
                // total order the block-hash preimage uses for contract_emissions.)
                for(let slashTbl of ['stakes', 'unstakes']){
                    query = `UPDATE ` + slashTbl + ` t
                                JOIN capability_slash_debits d ON d.stake_action_index = t.action_index
                                SET t.amount = d.prev_amount
                                WHERE d.target_table = ?
                                  AND d.block_index >= ?
                                  AND NOT EXISTS (
                                      SELECT 1 FROM capability_slash_debits e
                                      WHERE e.target_table      = d.target_table
                                        AND e.stake_action_index = d.stake_action_index
                                        AND e.block_index >= ?
                                        AND (e.block_index < d.block_index
                                             OR (e.block_index = d.block_index AND e.slash_action_index < d.slash_action_index)))`;
                    args = [slashTbl, block_index, block_index];
                    await this.indexerDb.doQuery(query, args);
                }

                // Reverse cooldown-maturity completions whose maturity block was orphaned.
                // When a capability/contract UNSTAKE cooldown elapses, processCooldownCompletions
                // finalizes it by (1) writing a refund credit with the UNSTAKE's OWN action_index
                // (utility.js, "for audit-trail continuity") and (2) flipping the unstake row's
                // status_id to 'completed' IN PLACE (db.markCooldownsCompleted). The unstake row
                // lives in an EARLIER (surviving) block, so BOTH effects carry an action_index
                // BELOW firstActionIndex and survive the generic dataTables delete below — and the
                // credit has no block_index column (keyed only by action_index/address/tick), so it
                // cannot be range-deleted at all. The maturity itself fires at block =
                // cooldown_end_block, which is in the orphaned range whenever cooldown_end_block >=
                // block_index, so a from-genesis replay to block_index-1 would NOT have matured: it
                // holds neither the refund credit nor the 'completed' status. Without this reset the
                // reorged node keeps an extra refund (updateBalances re-counts it) and a 'completed'
                // row the re-maturity sweep (status_id IN (pending,valid), db.sweepCompletedCooldowns)
                // then skips forever — a permanent credits/balances/unstakes divergence, and a hard
                // balance fork if a SLASH reduces the stake before the new chain re-matures.
                // createUnstake only ever writes 'valid' (unstake.js), so the from-genesis-equivalent
                // reset target is 'valid'. Scope to SURVIVING unstake rows (block_index < block_index);
                // orphaned-range unstakes and their credits are removed wholesale by the dataTables
                // delete. Runs BEFORE that delete (rows still present) and BEFORE updateBalances.
                let completedStatusId = await this.indexerDb.getStatusId('completed');
                let validStatusId     = await this.indexerDb.getStatusId('valid');
                if(completedStatusId !== null && validStatusId !== null){
                    let gasTick = this.config['GAS'];
                    // Capability maturity refund is paid in GAS, keyed by the unstake's action_index.
                    query = `DELETE c FROM credits c
                                JOIN unstakes u ON u.action_index = c.action_index AND u.source_id = c.address_id
                                JOIN index_tickers g ON g.id = c.tick_id AND g.tick = ?
                                WHERE u.status_id = ? AND u.cooldown_end_block >= ? AND u.block_index < ?`;
                    await this.indexerDb.doQuery(query, [gasTick, completedStatusId, block_index, block_index]);
                    // Contract maturity refund is paid in the unstake's own tick.
                    query = `DELETE c FROM credits c
                                JOIN contract_unstakes cu ON cu.action_index = c.action_index
                                                         AND cu.source_id   = c.address_id
                                                         AND cu.tick_id     = c.tick_id
                                WHERE cu.status_id = ? AND cu.cooldown_end_block >= ? AND cu.block_index < ?`;
                    await this.indexerDb.doQuery(query, [completedStatusId, block_index, block_index]);
                    // Reset the in-place 'completed' flip back to 'valid' so the sweep re-matures the
                    // cooldown once the new chain re-reaches cooldown_end_block.
                    query = `UPDATE unstakes SET status_id = ?
                                WHERE status_id = ? AND cooldown_end_block >= ? AND block_index < ?`;
                    await this.indexerDb.doQuery(query, [validStatusId, completedStatusId, block_index, block_index]);
                    query = `UPDATE contract_unstakes SET status_id = ?
                                WHERE status_id = ? AND cooldown_end_block >= ? AND block_index < ?`;
                    await this.indexerDb.doQuery(query, [validStatusId, completedStatusId, block_index, block_index]);
                }

                // Reset an anchor archive batch's parent v1 status that an orphaned final
                // chunk flipped to 'invalid_archive' IN PLACE on a surviving row. A chunked
                // archive batch spans multiple blocks: a v1 parent in an early block, then v2
                // continuation chunks in later blocks. When the LAST v2 chunk lands, anchor.js
                // reassembles the blob and, on a CRC mismatch against the parent's signed
                // batch_crc32, stamps the parent 'invalid_archive' via a direct UPDATE on the
                // parent row (created in an EARLIER block, so it survives the bulk delete below).
                // If that completing chunk is in the orphaned range, the delete removes the chunk
                // but cannot undo the in-place stamp — leaving the surviving parent stuck
                // 'invalid_archive' while a from-genesis replay (the bad chunk never re-mined, or
                // re-mined validly) would re-derive the parent's pre-flip status. anchor_actions
                // .status_id is not in any block-hash projection, so this is a state-table
                // divergence (and could mislead the archive-integrity flag / recovery selection,
                // which read version=1 status IN ('valid','unverified')), not a consensus fork.
                //
                // Reset to 'unverified' — the conservative re-verification state (anchor.js stores
                // a v1 'unverified' whenever its signer snapshot isn't locally mirrored, and
                // recovery re-verifies such rows from the archived snapshots), so a parent that was
                // 'valid' before the flip is re-promoted by recovery rather than left wrongly
                // terminal. We self-join the parent to an orphaned v2 chunk of the SAME
                // match_batch_seq and require that chunk's status be 'valid': a completing chunk is
                // always 'valid', and there can be at most TOTAL_CHUNKS-1 distinct valid chunks (the
                // duplicate-index guard rejects extras as 'invalid: ...'), so a surviving orphaned
                // VALID chunk proves fewer than the full set remain on the new chain — the batch can
                // no longer reassemble there and the flip is not re-derivable. Filtering on 'valid'
                // also excludes a late duplicate chunk that landed (and was rejected) AFTER a
                // legitimate completion, which must NOT trigger a reset. Runs BEFORE the delete so
                // both the parent and the orphaned chunk rows are still present.
                if(firstActionIndex !== null){
                    query = `UPDATE anchor_actions p
                                JOIN index_statuses ps ON ps.id = p.status_id AND ps.status = 'invalid_archive'
                                JOIN anchor_actions c
                                  ON c.version = 2
                                 AND c.match_batch_seq = p.match_batch_seq
                                 AND c.action_index >= ?
                                JOIN index_statuses cs ON cs.id = c.status_id AND cs.status = 'valid'
                                JOIN index_statuses us ON us.status = 'unverified'
                                SET p.status_id = us.id
                                WHERE p.version = 1
                                  AND p.action_index < ?`;
                    args = [firstActionIndex, firstActionIndex];
                    await this.indexerDb.doQuery(query, args);
                }

                // Loop through the data tables and delete records above the action_index
                for(let table of this.dataTables){
                    query = `DELETE FROM ` + table + ` WHERE action_index >= ?`;
                    args  = [firstActionIndex];
                    await this.indexerDb.doQuery(query, args);
                }

                // Sweep orphaned icon-cache rows. icons is a metadata cache keyed by
                // token_id with no action_index/block_index of its own, so it escapes
                // both delete loops. When a token row is removed above (tokens is in
                // dataTables) any icons row pointing at it is left dangling — and with
                // no enforced FK the DB won't cascade the delete. A stale orphan makes
                // the icon-fetch pipeline believe an icon already exists for a token
                // that no longer does. Runs after the loop, so the tokens rows are
                // already gone before the orphan sweep evaluates the sub-query.
                query = `DELETE FROM icons WHERE token_id NOT IN (SELECT id FROM tokens)`;
                await this.indexerDb.doQuery(query, []);

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
                // with a surviving still-escrowed GIVE_OWNERSHIP offer (Class B) — provably
                // complete: a token in neither cannot have a wrong escrow value. A token's gate
                // is held while its GIVE_OWNERSHIP offer's latest status is open/cancelling/
                // expiring (two-phase COINPay states keep escrow set); cleared only at a terminal
                // status, written in the same action as the escrow clear. Alias `si` (not the
                // SQL keyword `is`). The SQL between the ESCROW-REDERIVE-SQL markers is kept
                // logically identical with xchain-sync/src/ClientRollback.js — a cross-repo drift
                // guard (xchain-sync test/unit/rollback-coverage.test.js) asserts they match, so
                // source + replica derive byte-identical escrow_action_index values.
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
                     LIMIT 1`;
                //</ESCROW-REDERIVE-SQL>
                let escrowTickers = await this.indexerDb.doQuery(escrowAffectedTickersSql, []);
                for(let row of escrowTickers){
                    let offerRows = await this.indexerDb.doQuery(escrowOpenOfferSql, [row.tick, row.tick, row.tick]);
                    let newEscrow = (offerRows.length > 0) ? offerRows[0].action_index : null;
                    await this.indexerDb.doQuery("UPDATE tokens SET escrow_action_index=? WHERE tick_id=(SELECT id FROM index_tickers WHERE tick=? LIMIT 1)", [newEscrow, row.tick]);
                }
            }

            // Delete data from tables using block_index
            for(let table of this.blockTables){
                query = `DELETE FROM ` + table + ` WHERE block_index >= ?`;
                args  = [block_index];
                await this.indexerDb.doQuery(query, args);
            }

            // Delete consensus price snapshots anchored to the orphaned blocks.
            // price_snapshots anchors each round to a block via reference_block
            // (its equivalent of block_index) rather than block_index itself, so
            // it falls outside the generic blockTables loop above and needs its
            // own delete. Without it, snapshots tied to orphaned blocks survive
            // with status='finalized' and a from-genesis replay on the new chain
            // never regenerates those rounds, leaving replaying nodes permanently
            // divergent from surviving nodes on this table.
            query = `DELETE FROM price_snapshots WHERE reference_block >= ?`;
            args  = [block_index];
            await this.indexerDb.doQuery(query, args);

            // Re-derive attest_validator_stats for the orphaned range. This is
            // a monotone aggregate (fulfilled/missed/slashed counters per
            // validator/provider) with no action_index or block FK, so neither
            // generic delete loop above can touch it. A blanket delete would also
            // drop increments earned in surviving blocks. Instead we drop only the
            // rows whose most-recent touch is in the orphaned range and rebuild them
            // from the surviving signatures + expired-request records, matching what
            // a from-genesis replay to block_index-1 would produce.
            await this._recomputeAttestationValidatorStats(block_index);

            // DEBUG : Full balances and token updates
            // await this.indexerDb.updateBalances(true, true);
            // await this.indexerDb.updateTokens(true, true);

            // Update address balances to get back to sane balances based on credits/debits
            await this.indexerDb.updateBalances(Object.keys(addresses), true);

            // Update token information
            await this.indexerDb.updateTokens(tickers, true);

            // Update market information
            await this.indexerDb.updateMarkets(markets, block_index);

            // Do a sanity check to verify that token supplies match data in credits/debits/escrows/balances tables
            await this.indexerDb.sanityCheck(block_index);

            // Commit — the rollback is now atomically applied
            await this.indexerDb.commitTransaction();

        } catch(e) {
            // Roll back so the DB is left untouched rather than in a partial rollback state
            await this.indexerDb.rollbackTransaction();
            throw e;
        }

        // Signal the cross-chain hub to retract any price rows seeded from the
        // PRICE actions we just rolled back. The hub stores each pushed round /
        // oracle price tagged with the source chain + the source action_index, so
        // it can prune exactly the rows whose action_index falls in the orphaned
        // range. Without this, the hub (and every indexer mirroring its price
        // tables) keeps serving prices that were never finalized on-chain.
        // Best-effort, like every other hub push — a failure here must not leave
        // the local rollback half-applied, so we only log on error.
        //
        // One-time recovery note: prior to the null-sentinel fix above, a reorg
        // whose lowest rolled-back action had action_index 0 skipped this
        // retraction entirely (Number(0) is falsy), leaving orphaned rows in the
        // hub's oracle_prices / price_snapshots tables and every indexer mirror.
        // If any chain experienced such a reorg before this fix shipped, flush the
        // stale rows once by invoking the hub's price-reorg reconciliation
        // (pushpricereorg) with from_action_index=0 for the affected COIN before
        // resuming normal indexing.
        if(firstActionIndex !== null && this.hubClient){
            try {
                await this.hubClient.retractPriceRange(this.config['COIN'], firstActionIndex);
            } catch(err) {
                console.warn('Rollback: hub price retraction failed:', err);
            }
        }

        // Signal the hub to retract any cross_chain_calls relay rows seeded from XCALL
        // request actions just rolled back on this chain. The hub marks the matching relay
        // rows 'retracted' and broadcasts deletions to indexers mirroring their local
        // cross_chain_calls copy — so a source-chain reorg never leaves an orphaned
        // 'finalized' relay row eligible for re-injection on the target chain. Best-effort
        // and out-of-transaction (the rollback already committed above), exactly like the
        // price retraction — a hub failure must not leave the local rollback half-applied.
        if(firstActionIndex !== null && this.hubClient){
            try {
                await this.hubClient.retractXcallRange(this.config['COIN'], firstActionIndex);
            } catch(err) {
                console.warn('Rollback: hub XCALL retraction failed:', err);
            }
        }

        // Signal the hub to retract any cross_chain_matches rows whose retracted leg references DEX
        // ORDER actions just rolled back on this chain. The hub marks the matching matches
        // 'retracted', restores both legs' remaining capacity, and broadcasts deletions to indexers
        // mirroring their local cross_chain_matches copy — so a source-chain reorg never leaves an
        // orphaned 'finalized' match eligible for settlement against an order that no longer exists.
        // Best-effort and out-of-transaction, exactly like the price + XCALL retractions above — a
        // hub failure must not leave the local rollback half-applied.
        if(firstActionIndex !== null && this.hubClient){
            try {
                await this.hubClient.retractMatchRange(this.config['COIN'], firstActionIndex);
            } catch(err) {
                console.warn('Rollback: hub DEX match retraction failed:', err);
            }
        }

        // Log the rollback time
        this.util.logTimer(rollbackTimer, 'Rollback Done');
    }

    // Re-derive attest_validator_stats rows touched at or after block_index.
    //
    // The counters are written incrementally by the ATTEST handler
    // (db.incrementAttestationValidatorStat):
    //   - fulfilled_count: +1 per verified signature on a STATUS='ok' response.
    //   - missed_count:    +1 per responsible-set validator when a request expires.
    //   - slashed_count:   Phase 4 (no producer yet → always 0).
    // Because the table is keyed by (validator_pubkey, provider_id) and carries
    // only counters, it can't be rolled back by deleting a row range — earlier,
    // surviving increments live in the same row as the orphaned ones. So we drop
    // every row whose last touch is in the orphaned range and rebuild those exact
    // pairs from the surviving ledger. Runs inside the rollback transaction (after
    // the data/block deletes), so every query below sees only post-rollback rows.
    async _recomputeAttestationValidatorStats(block_index){
        // Pairs whose counters may include orphaned increments: any row last
        // touched at/after block_index. Increments stamp last_updated_block with
        // the touch block and blocks advance monotonically, so a pair touched in
        // the orphaned range always has last_updated_block >= block_index here.
        let pairRows = await this.indexerDb.doQuery(
            `SELECT validator_pubkey, provider_id
             FROM attest_validator_stats
             WHERE last_updated_block >= ?`,
            [block_index]
        );
        if(pairRows.length === 0)
            return;

        let affected = new Set();
        for(let r of pairRows)
            affected.add(String(r.validator_pubkey).toLowerCase() + '|' + String(r.provider_id));

        // Drop the stale rows. Any pair whose entire history was orphaned simply
        // stays gone — a from-genesis replay would never have created its row.
        await this.indexerDb.doQuery(
            `DELETE FROM attest_validator_stats WHERE last_updated_block >= ?`,
            [block_index]
        );

        // Accumulate recomputed counters: key -> { pubkey, provider, fulfilled, missed, lastBlock }
        let stats  = new Map();
        let ensure = (pubkey, provider) => {
            let key = pubkey + '|' + provider;
            if(!stats.has(key))
                stats.set(key, { pubkey, provider, fulfilled: 0, missed: 0, lastBlock: 0 });
            return stats.get(key);
        };

        // fulfilled_count: one per verified signature contributed to a STATUS='ok'
        // response. Signatures now ride in the validator_signatures JSON column on
        // the surviving v1 response rows (already rolled back via the action_index
        // delete), so we aggregate them in JS rather than joining a child table.
        let okResponses = await this.indexerDb.doQuery(
            `SELECT provider_id, validator_signatures, block_index
             FROM attests
             WHERE version = 1 AND response_status = 'ok' AND validator_signatures IS NOT NULL`,
            []
        );
        for(let row of okResponses){
            let sigs = [];
            try { sigs = JSON.parse(row.validator_signatures) || []; }
            catch(_) { sigs = []; }
            let provider = String(row.provider_id);
            let block    = Number(row.block_index) || 0;
            for(let sig of sigs){
                if(!sig || !sig.pubkey) continue;
                let s = ensure(String(sig.pubkey).toLowerCase(), provider);
                s.fulfilled += 1;
                s.lastBlock = Math.max(s.lastBlock, block);
            }
        }

        // missed_count: one per responsible-set validator each time a request
        // expired. There is no per-validator expiry row to count — the live path
        // recomputes the responsible set deterministically and bumps each member.
        // We reproduce that over the surviving requests that WOULD have expired in
        // a replay to block_index-1: a request expires at deadline_block+1 (the
        // first sweep past its deadline), so it counts iff deadline_block+1 <=
        // block_index-1 (i.e. deadline_block < block_index-1) AND no *valid*
        // response survives for it (any valid response flips it out of 'pending'
        // before the deadline, so it never expires). We derive eligibility from
        // surviving rows, NOT request_status — the resolved_block reset above only
        // covers flips inside the orphaned range, and deriving from rows keeps this
        // recomputation independent of status bookkeeping either way.
        let validId = await this.indexerDb.getStatusId('valid');
        let expiredReqs = await this.indexerDb.doQuery(
            `SELECT ar.request_id, ar.provider_id, ar.redundancy, ar.block_index, ar.deadline_block
             FROM attests ar
             WHERE ar.version = 0
               AND ar.deadline_block < ?
               AND NOT EXISTS (
                   SELECT 1 FROM attests r
                   WHERE r.version = 1
                     AND r.request_id = ar.request_id
                     AND r.status_id = ?
               )`,
            [block_index - 1, validId]
        );

        // Cache the capability set per request block — getValidatorsByCapability
        // is the same deterministic snapshot the live expiry path consulted.
        let validatorsByBlock = new Map();
        for(let req of expiredReqs){
            let reqBlock   = Number(req.block_index);
            let validators = validatorsByBlock.get(reqBlock);
            if(validators === undefined){
                let vs     = await this.indexerDb.getValidatorsByCapability('attestation', reqBlock);
                validators = (vs || []).map(v => String(v.pubkey).toLowerCase());
                validatorsByBlock.set(reqBlock, validators);
            }
            let responsible = this._responsibleSet(String(req.request_id), validators, Number(req.redundancy));
            let provider    = String(req.provider_id);
            let expiryBlock  = Number(req.deadline_block) + 1;
            for(let pubkey of responsible){
                let s = ensure(pubkey, provider);
                s.missed   += 1;
                s.lastBlock = Math.max(s.lastBlock, expiryBlock);
            }
        }

        // Re-insert recomputed rows for the pairs we dropped (others are already
        // correct). slashed_count/quality_score re-derive to 0 (Phase 4 unshipped).
        for(let s of stats.values()){
            if(!affected.has(s.pubkey + '|' + s.provider))
                continue;
            if(s.fulfilled === 0 && s.missed === 0)
                continue;
            await this.indexerDb.doQuery(
                `INSERT INTO attest_validator_stats
                    (validator_pubkey, provider_id, fulfilled_count, missed_count, slashed_count, quality_score, last_updated_block)
                 VALUES (?, ?, ?, ?, 0, 0, ?)
                 ON DUPLICATE KEY UPDATE
                    fulfilled_count    = VALUES(fulfilled_count),
                    missed_count       = VALUES(missed_count),
                    slashed_count      = VALUES(slashed_count),
                    last_updated_block = VALUES(last_updated_block)`,
                [s.pubkey, s.provider, s.fulfilled, s.missed, s.lastBlock]
            );
        }
    }

    // Deterministic responsible validator set — mirrors attest.js
    // _computeResponsibleSet: sort the capability validators by
    // SHA256(request_id || pubkey), take the top REDUNDANCY.
    _responsibleSet(requestId, validators, redundancy){
        if(!validators || validators.length === 0)
            return [];
        let withHash = validators.map(pk => ({
            pubkey: pk,
            hash:   crypto.createHash('sha256').update(String(requestId), 'utf8').update(pk, 'utf8').digest('hex')
        }));
        withHash.sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
        return withHash.slice(0, Math.max(1, Number(redundancy) || 1)).map(v => v.pubkey);
    }
}

module.exports = Rollback;
