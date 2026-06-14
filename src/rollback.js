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
            'slash_events'
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

        // Collect touched contract balance pairs before deletion (for VM rollback)
        let touchedContractPairs = [];
        if(firstActionIndex !== null){
            query = `SELECT contract_index, tick_id FROM deposits WHERE action_index >= ?`;
            args  = [firstActionIndex];
            let depositRows = await this.indexerDb.doQuery(query, args);
            for(let row of depositRows)
                touchedContractPairs.push({ contract_index: Number(row.contract_index), tick_id: Number(row.tick_id) });

            query = `SELECT contract_index, tick_id FROM withdrawals WHERE action_index >= ?`;
            args  = [firstActionIndex];
            let withdrawalRows = await this.indexerDb.doQuery(query, args);
            for(let row of withdrawalRows)
                touchedContractPairs.push({ contract_index: Number(row.contract_index), tick_id: Number(row.tick_id) });
        }

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

                // Re-NULL orphaned ownership-escrow stamps on surviving token rows. When a
                // token's ownership is offered via an ORDER / SWAP / DISPENSER carrying
                // GIVE_OWNERSHIP, the forward path stamps tokens.escrow_action_index with the
                // OFFER's action_index (setTokenEscrow, an in-place UPDATE on the token row that
                // was created by a much earlier ISSUE in a surviving block). The bulk delete
                // below removes the orphaned offer row but cannot undo that in-place stamp, and
                // the token recompute (updateTokens → getTokenInfo → createToken) never touches
                // the escrow column — so without this reset the surviving token keeps pointing at
                // a now-deleted offer. isOwnershipEscrowed() then permanently returns true,
                // rejecting every owner-only action (ISSUE, CALLBACK, SLEEP, LINK, FILE, new
                // offers) on the reorged node while a from-genesis replay — where the offer was
                // never re-mined — has escrow_action_index = NULL and accepts them: a consensus-
                // affecting divergence on every chain ownership trading spans (BTC/LTC/DOGE).
                // The stamp IS the offer's action_index, so `>= firstActionIndex` is exact — it
                // clears only stamps whose owning offer falls in the orphaned range; surviving
                // escrows (stamps < firstActionIndex) are untouched.
                query = `UPDATE tokens SET escrow_action_index = NULL WHERE escrow_action_index >= ?`;
                args  = [firstActionIndex];
                await this.indexerDb.doQuery(query, args);

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

            // Recalculate contract custody balances for touched pairs
            if(touchedContractPairs.length > 0)
                await this.indexerDb.updateContractBalances(touchedContractPairs);

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
