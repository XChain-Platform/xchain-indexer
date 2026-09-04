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
 * XChain Indexer - Rollback Class
 * 
 * This file handles processing rollbacks and updating the database
 *
 ********************************************************************/

const crypto    = require('crypto');
const swq       = require('./stake_weighted_quorum.js');
const pmsh      = require('./attestation/providerMinStakeHistory.js');
const ProviderRegistry = require('./attestation/providerRegistry.js');
const lifecycle = require('./tableLifecycle.js');
const ar        = require('./anchor_reward_activation.js');
const { ARCHIVE_HEAD_VERSIONS_SQL } = require('./stateHash.js');

class Rollback {

    // Handle constructing a class instance
    constructor(indexer){
        // Keep a reference to the indexer so the rollback can surface its in-progress
        // state (stallReason) on the /health payload for the reorg window (#1812).
        this.indexer   = indexer;

        // Parse in indexer configuration
        this.config    = indexer.config;

        // Same effective provider map actions/attest.js builds (DEFAULTS overlaid with
        // config.ATTESTATION.PROVIDERS), so the reorg recompute of missed_count resolves
        // the identical provider stake floor the live expiry path did.
        this.providerRegistry = new ProviderRegistry(this.config);

        // Setup alias to the indexer database connection
        this.decoderDb = indexer.decoderDb;
        this.indexerDb = indexer.indexerDb;

        // Pool-direct view for the pre-transaction read phase (REORG-1). getConnection() adopts any
        // open transactionConnection, so before this rollback opens its own transaction the read-phase
        // queries would otherwise run on whatever foreign transaction happens to be open (e.g. a public
        // feequote dry-run, which always rolls back), silently discarding/dirtying them. The view's
        // doQuery/doQueryStrict draw an independent pooled connection that never adopts a transaction.
        // The rollback's own transaction still uses this.indexerDb (transactionConnection). apiView may
        // be absent on a minimal mock (or indexerDb itself absent in a static drift-guard analyzer), so
        // fall back to the raw db. That fallback is a test affordance and not a production path; the
        // rationale, and why it must never spread to a federation read, is stated in full at the
        // indexerReorgView guard in XChainIndexer.js.
        this.indexerView = (this.indexerDb && typeof this.indexerDb.apiView === 'function') ? this.indexerDb.apiView() : this.indexerDb;

        // Setup alias to the utility class
        this.util      = indexer.util;

        // Setup alias to the hub client (used to retract price rows + cross_chain_calls
        // relay rows seeded from rolled-back PRICE / XCALL actions on the cross-chain hub)
        this.hubClient = indexer.hubClient;

        // Setup alias to the durable hub-push queue. Paused around the post-commit retraction
        // block so an in-flight deferred drain cannot interleave with this rollback and re-issue
        // a stale open-ended retraction against the just-rolled-back range (item 5297). May be
        // unset during early boot (rollbacks only occur in the main loop after the queue starts),
        // so every use is null-guarded.
        this.hubPushQueue = indexer.hubPushQueue || null;

        // Deliberately NO alias to indexer.protocolChanges. That registry answers
        // isEnabled(name, block_index) against a LOCAL height, and during an unwind there is no
        // single unambiguous height to hand it: the rolled-back tip, the target block and the
        // block a restored row was earned in all differ. A handle here is therefore a footgun,
        // not a convenience, so it is left off the surface rather than left present-and-unread.
        // Rollback's flag-day gating goes through the snapshot-anchored twin predicates instead
        // (swq.isStakeWeightedQuorumActive above, keyed on the row's OWN snapshot block), which
        // is the only reading a re-derivation can make without inventing a height.

        // Generic rollback table lists, generated from the table-lifecycle
        // registry (src/tableLifecycle.js): dataTables are deleted by
        // action_index, blockTables by block_index, indexTables are the two
        // wire-^<id> consensus lookups deleted by their own block_index. Per-
        // table rationale (why a table is generic vs recomputed vs bespoke vs
        // exempt) lives with its registry entry; classify NEW tables there,
        // not here. The bespoke restores/sweeps in rollback() below stay
        // hand-written and run in their required order around these loops.
        let rollbackLists = lifecycle.rollbackTables();
        this.blockTables  = rollbackLists.blockTables;
        this.dataTables   = rollbackLists.dataTables;
        this.indexTables  = rollbackLists.indexTables;

        // NOTE: index_addresses and index_tickers ARE rolled back (block-scoped delete at
        // the end of rollback(), keyed by index_*.block_index). Once an address/ticker can
        // be referenced on the wire as ^<id>, its index id is consensus-relevant: a ^<id>
        // is stored verbatim into a *_id column and resolved to a canonical string at
        // block-hash time, so the same ^<id> must name the same entity on every node. Their
        // ids are now assigned by an explicit dense counter (db.getNextAddressId /
        // getNextTickerId), never lazily by AUTO_INCREMENT, so deleting the ids first seen
        // in orphaned blocks and reapplying the canonical chain reproduces them identically.
        //
        // The OTHER index_* lookup tables (index_statuses, index_actions, index_coins,
        // index_fiats, ...) remain intentionally NOT rolled back: none of them can be named
        // by a wire ^<id>, and the block hashes resolve their ids to canonical strings
        // before hashing (see db.getBlockHashes / BLOCK_HASH_VERSION), so a row first seen
        // in a later-orphaned block survives the reorg harmlessly. Do not reintroduce a raw
        // lookup id from one of those tables into any hashed projection, and do not add a new
        // ^<id>-style wire reference for one without also rolling its table back here.

    }

    // Handle rolling back data to a specific block
    async rollback(block_index){
        // Genesis floor: the genesis block carries the bootstrapped Counterparty/Dogeparty
        // name ownership and is the consensus base of the ledger. A reorg can never legitimately
        // reach it, so refuse to roll back to or below it rather than destroy that state. Throwing
        // here (before any DB work) surfaces the attempt to the operator instead of silently
        // unwinding genesis. GENESIS_BLOCK = 0 (disabled) leaves normal rollback unaffected.
        let genesisBlock = this.config['GENESIS_BLOCK'];
        if(genesisBlock && Number(block_index) <= Number(genesisBlock)){
            let msg = 'Rollback to block ' + block_index + ' refused: at/below GENESIS_BLOCK ' + genesisBlock + ' (would destroy the bootstrapped genesis ledger)';
            console.error(msg);
            throw new Error(msg);
        }

        // Start tracking time of rollback
        var rollbackTimer = this.util.startTimer();
        const rollbackStartedAt = Date.now();

        // Surface the in-progress rollback on /health for the whole reorg window, so a
        // hung or looping rollback is not misreported as last-known-good (a frozen
        // lastIndexedBlock with stallReason:null). Cleared after commit, and on the
        // failure path below (#1812).
        if(this.indexer) this.indexer.stallReason = 'reorg_rollback';

        // Notify user of start of rollback
        console.log('Starting rollback to block ' + block_index + '...');

        // Source-chain reorg fence (item 5308): this chain's monotonic push generation is bumped so
        // that rows re-published by forward replay carry the NEW generation while the orphaned rows
        // keep the prior one, and the retractions below carry the PRE-bump generation (bumped - 1) so
        // the hub fence deletes only the orphans (push_generation <= pre) while a re-published row at a
        // recycled action_index (new generation) survives. push_generations is NEVER a rollback
        // dataTable (monotonic).
        //
        // The bump is issued INSIDE the rollback transaction (just before commit, below), NOT here,
        // for two reasons (HUB-RETRACT-1): (a) fail-closed - a bump failure throws into the
        // transaction's catch, rolling back every delete, so the reorg is retried idempotently rather
        // than shipping an un-fenced rollback; (b) atomicity vs concurrent hub PULLs - the hub stamps
        // getpendingcrosschaincalls / getopencrosschainorders results with the CURRENT generation at
        // serve time, so if the generation flipped to bumped while the orphaned rows were still
        // committed and visible, a pull would stamp an orphan with the NEW generation and it would
        // escape the fence forever. Bumping in-transaction means another connection sees either
        // (pre-commit) old generation + orphaned rows, stamped with the old generation the fence
        // covers, or (post-commit) new generation + rows already gone - never orphans + new generation.
        let retractionGeneration = null;
        // Retraction rows written ahead inside the transaction (HUB-RETRACT-2); the post-commit block
        // attempts immediate live delivery and drops each on success, else leaves it for HubPushQueue.
        let stagedRetractions = [];

        // Reset the address/tickers/transactions lists
        this.util.resetLists();

        // Placeholder for the first action_index. Initialized to null (not a
        // falsy number) so the guards below distinguish "no actions in range"
        // from a legitimate action_index of 0 (Number(0) is falsy), so a false
        // sentinel would silently skip all rollback processing and the hub
        // price retraction whenever the lowest rolled-back action is index 0.
        let firstActionIndex = null;

        // Highest rolled-back action_index, used to bound a DEFERRED hub retraction to a CLOSED
        // range [first, last]. Captured here, before the dataTables DELETE below removes the
        // orphaned `actions` rows, so the MAX reflects the full rolled-back range. The live
        // (immediate) retraction stays open-ended; only a queued/replayed retraction needs the
        // ceiling, so that a re-published row at A' (>= first) landing before the deferred drain
        // is not wiped by an open-ended DELETE (items 5296/5297).
        let lastActionIndex = null;

        // Placeholder for market pairs
        let markets = [];
        // Orientation-free keys of the pairs already collected in `markets`. The dedupe below
        // used to rescan the whole array per row, without breaking on a hit, so collecting pairs
        // cost O(rows x pairs) inside the reorg stall window where every block is deferred. The
        // key is min:max over the two tick ids, which is exactly the either-orientation match the
        // scan performed; pairs are still pushed in the orientation they were first seen, so the
        // contents and order of `markets` are unchanged. Deliberately spans the whole per-table
        // read loop, matching the array it shadows (dedupe is across tables, not per table).
        let marketKeys = new Set();

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
        let rows = await this.indexerView.doQueryStrict(query, args);
        if(rows.length > 0)
            firstActionIndex = Number(rows[0].action_index);

        // Capture the upper bound of the rolled-back action range (still in the DB at this point).
        let maxRows = await this.indexerView.doQueryStrict(
            'SELECT MAX(a.action_index) AS last_action_index FROM actions a WHERE a.block_index >= ?',
            [block_index]
        );
        if(maxRows.length > 0 && maxRows[0].last_action_index !== null)
            lastActionIndex = Number(maxRows[0].last_action_index);

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

                // Run the query and populate the addresses, tickers, and markets arrays.
                // doQueryStrict (not doQuery): still pre-transaction; a swallowed fault here would
                // silently empty the address/ticker/market recompute sets, so updateBalances/
                // updateTokens/updateMarkets below skip rows they must fix - a stale-balance/supply
                // divergence. Fail loud so the reorg is retried cleanly instead.
                if(query){
                    let rows = await this.indexerView.doQueryStrict(query, args);
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
                            let tick1_id = Number(row.tick1_id);
                            let tick2_id = Number(row.tick2_id);
                            let key      = Math.min(tick1_id, tick2_id) + ':' + Math.max(tick1_id, tick2_id);
                            if(!marketKeys.has(key)){
                                marketKeys.add(key);
                                markets.push({ tick1_id, tick2_id });
                            }
                        }
                    }
                }
            }
        }

        // Get lists of addresses, tickers, and transactions (collected during read phase above)
        let addresses = this.util.getAddressesList();
        let tickers   = this.util.getTickersList();

        // Begin a transaction; all deletes and recalculations are atomic
        await this.indexerDb.beginTransaction();
        try {

            // Reverse any cooldown maturities orphaned by this reorg. Runs UNCONDITIONALLY (outside
            // the firstActionIndex guard) and BEFORE the generic deletes: the legacy (pre-flag-day)
            // maturity path writes the refund credit + 'completed' flip against a SURVIVING unstake
            // row and mints NO actions row in the maturity block, so a reorg over an action-empty
            // range leaves firstActionIndex null and would otherwise skip the reversal entirely,
            // stranding the refund and forking the ledger vs a from-genesis replay. Keyed entirely
            // on block_index / cooldown_end_block, so it is a no-op when nothing matured. Seeds the
            // affected source addresses/ticks into the util lists captured above so the unconditional
            // updateBalances/updateTokens below recompute them.
            await this._reverseCooldownMaturities(block_index);

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
                // and, for a reorged expiry, the deadline sweep (pending-only)
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
                // below can't undo it. Without this reset, a re-applied result row
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

                // Re-open VOTE polls whose TERMINAL finalization happened in the
                // orphaned range. The VOTE v2 sweep flips a poll (created in an
                // EARLIER block, so it survives the bulk delete below) from 'open'
                // to 'finalized'/'failed_quorum' via a direct UPDATE on the polls
                // row, and writes poll_results keyed on the v2 action_index (those
                // ARE deleted generically). Without this reset the surviving polls
                // row stays terminal, so the per-block sweep (open-only) never
                // re-synthesizes the v2 and a reorged node diverges from a fresh
                // sync. Keyed on resolved_block (stamped at finalize) so it re-opens
                // and re-evaluates early-decide on replay. Mirrors the ATTEST reset.
                // deposit_resolved + callback_execute_action_index reset too: the v2
                // escrow release and the injected binding-callback EXECUTE (both at the
                // v2 action_index) are deleted generically with the orphaned range, so
                // the re-synthesized v2 must re-release the escrow and re-fire the
                // callback on replay.
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
                await this.indexerDb.doQuery(query, args);

                // BET in-place flip resets (P4; the polls/attests pattern
                // applied to all three BET stamps). A feed row created in an
                // EARLIER block survives the bulk delete below, but its
                // feed_status_id was flipped in place by the latch pass
                // (closed_block stamp) and/or a terminal path (terminal_block
                // stamp: resolve tx / cancel tx / BET_EXPIRE pass); a bet row
                // likewise flips bet_status_id in place at settlement
                // (settled_block stamp). Without these resets a reorg past a
                // latch block leaves the feed permanently closed (rejecting
                // valid bets on the re-mined chain) and a reorg past a
                // settlement block leaves stakes marked won/lost with their
                // credits deleted - stranded escrow. Reset order matters:
                // (a) terminal feeds whose latch SURVIVES (closed_block below
                //     the reorg point) go back to 'closed';
                // (b) terminal feeds with no surviving latch go back to 'open';
                // (c) any surviving latch stamped in the orphaned range is
                //     un-latched (runs last so feeds reset by (b) also clear
                //     their orphaned closed_block).
                // Status names resolve through index_statuses (bet_feeds/bets
                // store status_id, unlike polls' inline strings); the interned
                // 'open'/'closed' rows are created by the BET handlers, and the
                // resets are no-ops (JOIN misses) before any BET activity.
                await this.indexerDb.createStatus('open');
                await this.indexerDb.createStatus('closed');
                query = `UPDATE bet_feeds f
                            JOIN index_statuses cs ON (cs.status = 'closed')
                            SET f.feed_status_id = cs.id, f.terminal_block = NULL
                            WHERE f.terminal_block >= ?
                              AND f.closed_block IS NOT NULL
                              AND f.closed_block < ?`;
                args  = [block_index, block_index];
                await this.indexerDb.doQuery(query, args);
                query = `UPDATE bet_feeds f
                            JOIN index_statuses os ON (os.status = 'open')
                            SET f.feed_status_id = os.id, f.terminal_block = NULL
                            WHERE f.terminal_block >= ?
                              AND (f.closed_block IS NULL OR f.closed_block >= ?)`;
                args  = [block_index, block_index];
                await this.indexerDb.doQuery(query, args);
                query = `UPDATE bet_feeds f
                            JOIN index_statuses os ON (os.status = 'open')
                            SET f.feed_status_id = os.id, f.closed_block = NULL
                            WHERE f.closed_block >= ?`;
                args  = [block_index];
                await this.indexerDb.doQuery(query, args);
                // Bets settled in the orphaned range re-open (their terminal
                // credits/escrow releases are deleted generically, so the stake
                // is back in escrow, exactly the pre-settlement state)
                query = `UPDATE bets b
                            JOIN index_statuses os ON (os.status = 'open')
                            SET b.bet_status_id = os.id, b.settled_block = NULL
                            WHERE b.settled_block >= ?`;
                args  = [block_index];
                await this.indexerDb.doQuery(query, args);

                // timelock: a DEFERRED binding-callback fire whose due block is
                // orphaned while the finalization itself survives (resolved_block below
                // the reorg point, callback_due_block at/above it). The injected EXECUTE
                // is deleted generically with the orphaned range; re-NULL the fired
                // marker so the sweep re-fires deterministically when the due block
                // replays. The stamped callback_due_block itself is derived state
                // (resolved_block + delay) from a surviving v2, so it stays.
                query = `UPDATE polls
                            SET callback_execute_action_index = NULL
                            WHERE poll_status IN ('finalized', 'failed_quorum')
                              AND callback_due_block >= ?
                              AND callback_execute_action_index IS NOT NULL`;
                args  = [block_index];
                await this.indexerDb.doQuery(query, args);

                // tokens.escrow_action_index (the ownership-escrow gate) is RE-DERIVED below,
                // AFTER the dataTables delete (see rederiveTokenEscrow()). A range reset here
                // could only handle the SET direction (offer orphaned); it cannot handle the
                // CLEAR direction (a surviving offer whose release was orphaned), so the
                // re-derive replaces it entirely.

                // Re-NULL deactivation_block stamps that orphaned UNSTAKE / DELEGATE-revoke
                // actions wrote IN PLACE on surviving parent stake/delegation rows. Each
                // forward handler (createUnstake, the DELEGATE-revoke path,
                // createContractUnstake, the contract-revoke path) marks an ALREADY-ACTIVE
                // parent row (created by a much earlier STAKE/DELEGATE in a surviving block)
                // with deactivation_block = actionBlock + activationDelay. The bulk delete
                // below removes the orphaned action row but cannot undo that in-place UPDATE,
                // so without this reset the surviving parent keeps a non-NULL deactivation_block.
                // Every active-set read gates on (deactivation_block IS NULL OR
                // deactivation_block > currentBlock), so once the new chain passes the stale
                // value the staker/validator silently drops out of the active set on the
                // reorged node while a from-genesis replay keeps it active, a consensus-
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
                // activationDelay (equivalently precise, because any surviving revoke stamps a
                // strictly smaller value, i.e. survivingBlock < block_index).
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
                // never re-mined) keeps the original, a consensus-affecting divergence (active
                // stake drives VM staker weighting, quorum eligibility, and cooldown refunds on
                // all chains). We copy back the EARLIEST orphaned debit's `prev_amount` per row
                // (min block_index, then (execution_index, slash_position) tiebreak, the same
                // deterministic total order the block-hash preimage uses for contract_emissions,
                // so it is replay-stable and identical across the source indexer and every
                // replica; the AUTO_INCREMENT `id` is NOT, and would let two nodes restore a
                // divergent amount on a reorg that retracts a block with ≥2 slashes against one
                // stake row). This is a pure string copy, so the restored value is
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

                // Restore signing keys an orphaned DELEGATE v1 materialization rewrote IN PLACE
                // on surviving rows. materializeContractDelegations rewrites
                // contract_stakes/contract_unstakes.signing_pubkey_id on rows from earlier
                // (surviving) blocks and records each rewrite's pre-rotation key, with the table
                // it landed on, in contract_delegation_rotations. The
                // generic deletes below drop the orphaned journal rows but cannot revert the
                // UPDATE, so without this a surviving row keeps the rotated key while a
                // from-genesis replay (the DELEGATE never re-mined, or re-mined at a different
                // height) keeps the original - a consensus-affecting divergence, since the key on
                // the row is exactly what the VM stake snapshot, the UNSTAKE aggregate and the
                // SLASH deduction all read. We copy back the EARLIEST orphaned rotation's
                // `prev_signing_pubkey_id` per row (min block_index, then delegation_action_index,
                // both replay-stable; the AUTO_INCREMENT `id` is NOT and would let two nodes
                // restore different keys). Pure id copy, so the restored value is byte-identical
                // to the surviving chain's pre-rotation state. Earlier SURVIVING rotations are
                // intentionally left applied. Runs BEFORE the deletes so both tables still exist.
                for(let rotTbl of ['contract_stakes', 'contract_unstakes']){
                    query = `UPDATE ` + rotTbl + ` t
                                JOIN contract_delegation_rotations r ON r.stake_action_index = t.action_index
                                SET t.signing_pubkey_id = r.prev_signing_pubkey_id
                                WHERE r.target_table = ?
                                  AND r.block_index >= ?
                                  AND NOT EXISTS (
                                      SELECT 1 FROM contract_delegation_rotations e
                                      WHERE e.target_table       = r.target_table
                                        AND e.stake_action_index = r.stake_action_index
                                        AND e.block_index >= ?
                                        AND (e.block_index < r.block_index
                                             OR (e.block_index = r.block_index
                                                 AND e.delegation_action_index < r.delegation_action_index)))`;
                    args = [rotTbl, block_index, block_index];
                    await this.indexerDb.doQuery(query, args);
                }

                // Same restore for CAPABILITY-stake equivocation slashes (WI-2 bump 2):
                // slashCapabilityStake reduces stakes/unstakes.amount IN PLACE on surviving
                // rows and logs the pre-slash `prev_amount` in capability_slash_debits. Copy
                // back the EARLIEST orphaned debit's prev_amount per row (min block_index, then
                // slash_action_index tiebreak). This is a pure string copy, byte-identical to the
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
                // action_index, so it orders by (execution_index, slash_position), i.e. the EXECUTE's
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

                // Restore anchor validator_rewards rows an orphaned reconcile DELETEd IN PLACE
                // from earlier SURVIVING blocks (RB-ANCHOR). reconcileAnchorRewardWinner keeps
                // only the smallest-pubkey winner per (reward_type, round_reference); on a
                // failover double-publish it deletes loser rows that were created at the
                // checkpoint's SNAPSHOT_BLOCK (earlier than the ANCHOR that runs the reconcile),
                // logging each pre-image in anchor_reward_reconcile_log keyed to the reconcile's
                // (ANCHOR) block. If that ANCHOR is in the orphaned range, the generic block
                // delete below drops the log rows and the ANCHOR but cannot re-create the deleted
                // losers, leaving the reorged node with a collapsed reward set while a from-genesis
                // replay to reorg_block-1 (reconcile never re-ran) keeps every loser. That lowers
                // a later COLLECT's SUM(validator_rewards) → a ledger-hashed fork. Re-INSERT only
                // losers whose ORIGINAL earn-block (reward_block_index) SURVIVES the reorg
                // (< block_index): a loser earned inside the orphaned range is correctly absent
                // (replay never mints it, and the generic delete already removed any copy). The
                // restored row carries its original earn-block, so the generic block delete (which
                // scopes on block_index >= reorg) leaves it in place. Runs BEFORE that delete so
                // the log rows still exist. amount is the frozen consensus reward constant per
                // round, so duplicate log rows carry an identical value and INSERT IGNORE is
                // value-stable + idempotent (no earliest-debit tiebreak needed, unlike the slash
                // restores above where prev_amount can differ across repeated slashes of one row).
                //
                // The surviving-earn-block test alone is NOT sufficient once a reward can be
                // MATERIALIZED later than it is earned. An derived anchor reward
                // carries block_index = the checkpoint's SNAPSHOT_BLOCK but is written while the
                // BTC indexer processes a much later block, recorded here as
                // reward_derive_block_index. A loser materialized INSIDE the orphaned range has a
                // surviving earn-block yet must NOT be restored: the replay to reorg_block-1 never
                // ran the derivation, so restoring it would mint an orphan the replay does not have
                // and fork SUM(validator_rewards) in the other direction. Require BOTH heights to
                // survive; NULL (every same-block writer, and every row pre-dating the column)
                // keeps the original earn-block-only behavior.
                // round_qualifier rides the pre-image like every other key column: it is part
                // of the reward's UNIQUE identity (snapshot_block for the archive leg, whose
                // round_reference is a reissuable hub counter), so restoring without it would
                // re-INSERT the loser under qualifier 0 - a DIFFERENT row from the one the
                // reconcile deleted, colliding with whatever legacy row already holds that key
                // and leaving the real loser unrestored.
                query = `INSERT IGNORE INTO validator_rewards
                            (source_id, signing_pubkey_id, reward_type, round_reference, round_qualifier,
                             amount, block_index, derive_block_index)
                         SELECT d.source_id, d.signing_pubkey_id, d.reward_type, d.round_reference,
                                d.round_qualifier,
                                d.amount, d.reward_block_index, d.reward_derive_block_index
                           FROM anchor_reward_reconcile_log d
                          WHERE d.block_index >= ?
                            AND d.reward_block_index < ?
                            AND (d.reward_derive_block_index IS NULL OR d.reward_derive_block_index < ?)`;
                args = [block_index, block_index, block_index];
                await this.indexerDb.doQuery(query, args);

                // Cooldown-maturity reversal was here; it is now in _reverseCooldownMaturities,
                // called UNCONDITIONALLY at the top of the transaction (before this guard). It had
                // to leave this firstActionIndex-gated block because the legacy cooldown maturity
                // (pre UNSTAKE_COOLDOWN_COMPLETION_ACTION) mints NO actions row, so an orphaned
                // range containing only such a maturity leaves firstActionIndex null and would skip
                // the reversal entirely, forking the ledger vs a from-genesis replay.

                // Reset an anchor archive batch's parent (v1/v6 archive-head) status that an
                // orphaned final chunk flipped to 'invalid_archive' IN PLACE on a surviving row. A
                // chunked archive batch spans multiple blocks: a head in an early block, then v2
                // continuation chunks in later blocks. When the LAST v2 chunk lands, anchor.js
                // reassembles the blob and, on a CRC mismatch against the parent's signed
                // batch_crc32, stamps the parent 'invalid_archive' via a direct UPDATE on the
                // parent row (created in an EARLIER block, so it survives the bulk delete below).
                // If that completing chunk is in the orphaned range, the delete removes the chunk
                // but cannot undo the in-place stamp, leaving the surviving parent stuck
                // 'invalid_archive' while a from-genesis replay (the bad chunk never re-mined, or
                // re-mined validly) would re-derive the parent's pre-flip status. anchor_actions
                // .status_id is not in any block-hash projection, so this is a state-table
                // divergence (and could mislead the archive-integrity flag / recovery selection,
                // which read version IN (1, 6) status IN ('valid','unverified')), not a consensus fork.
                //
                // Reset to 'unverified', the conservative re-verification state (anchor.js stores
                // a v1 'unverified' whenever its signer snapshot isn't locally mirrored, and
                // recovery re-verifies such rows from the archived snapshots), so a parent that was
                // 'valid' before the flip is re-promoted by recovery rather than left wrongly
                // terminal. We self-join the parent to an orphaned v2 chunk of the SAME
                // match_batch_seq and require that chunk's status be 'valid': a completing chunk is
                // always 'valid', and there can be at most TOTAL_CHUNKS-1 distinct valid chunks (the
                // duplicate-index guard rejects extras as 'invalid: ...'), so a surviving orphaned
                // VALID chunk proves fewer than the full set remain on the new chain, so the batch can
                // no longer reassemble there and the flip is not re-derivable. Filtering on 'valid'
                // also excludes a late duplicate chunk that landed (and was rejected) AFTER a
                // legitimate completion, which must NOT trigger a reset. Runs BEFORE the delete so
                // both the parent and the orphaned chunk rows are still present.
                if(firstActionIndex !== null){
                    // Intern 'unverified' FIRST (IDX-1). The UPDATE below resolves its target id via
                    // `JOIN index_statuses us ON us.status = 'unverified'`, but a normally hub-connected
                    // node never writes 'unverified' forward (anchor.js only stores it when no
                    // oracle_publish snapshot is mirrored), so that row is usually absent and the JOIN
                    // matches nothing, silently no-oping the reset and leaving the parent wedged at
                    // 'invalid_archive'. createStatus interns it (INSERT IGNORE) so the JOIN is
                    // guaranteed non-empty; index_statuses ids are never hashed, so an in-rollback
                    // intern is byte-neutral. The UPDATE's JOIN text is pinned by the cross-repo
                    // drift guard (xchain-sync rollback-coverage); the replica converges via
                    // snapshot catch-up (it cannot intern locally without diverging the replicated
                    // id, and anchor status_id is in no block-hash projection).
                    //
                    // Version predicate: the parent is any ARCHIVE_HEAD version (v1
                    // legacy, v6 publisher-bearing post-ARCHIVE_REWARD), shared constant from
                    // stateHash.js. Unconditionally widened: a v6 parent's stamp is exactly as
                    // un-re-derivable after the chunk delete as a v1's, and this reset is not a
                    // hash preimage (the GATED anchor_invalid state-hash class covers the stamp
                    // itself), so no flag-day applies here. ClientRollback.js mirrors this;
                    // the drift guard pins the widened predicate on both sides.
                    await this.indexerDb.createStatus('unverified');
                    query = `UPDATE anchor_actions p
                                JOIN index_statuses ps ON ps.id = p.status_id AND ps.status = 'invalid_archive'
                                JOIN anchor_actions c
                                  ON c.version = 2
                                 AND c.match_batch_seq = p.match_batch_seq
                                 AND c.action_index >= ?
                                JOIN index_statuses cs ON cs.id = c.status_id AND cs.status = 'valid'
                                JOIN index_statuses us ON us.status = 'unverified'
                                SET p.status_id = us.id
                                WHERE p.version ${ARCHIVE_HEAD_VERSIONS_SQL}
                                  AND p.action_index < ?`;
                    args = [firstActionIndex, firstActionIndex];
                    await this.indexerDb.doQuery(query, args);
                }

                // Loop through the data tables and delete records above the action_index.
                // This is the whole price rollback path for `prices`: an orphaned PRICE v0
                // round row and an orphaned PRICE batch row are both removed WHOLESALE by
                // action_index, so batch_first_round/batch_last_round/round_count/rounds_json
                // are cleared exactly as round_number/pairs_json/sigs_json are, by virtue of
                // the row itself being gone; no v2-specific delete or partial-column reset is
                // needed on top of this generic loop.
                for(let table of this.dataTables){
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
                        query = `DELETE FROM pending_hub_pushes WHERE action_index >= ? AND push_type NOT IN ('price_retraction', 'xcall_retraction', 'match_retraction')`;
                    }
                    await this.indexerDb.doQuery(query, args);
                }

                // Sweep orphaned icon-cache rows. icons is a metadata cache keyed by
                // token_id with no action_index/block_index of its own, so it escapes
                // both delete loops. When a token row is removed above (tokens is in
                // dataTables) any icons row pointing at it is left dangling. With
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
                // with a surviving still-escrowed GIVE_OWNERSHIP offer (Class B), provably
                // complete: a token in neither cannot have a wrong escrow value. A token's gate
                // is held while its GIVE_OWNERSHIP offer's latest status is open/cancelling/
                // expiring (two-phase COINPay states keep escrow set); cleared only at a terminal
                // status, written in the same action as the escrow clear. Alias `si` (not the
                // SQL keyword `is`). The SQL between the ESCROW-REDERIVE-SQL markers is kept
                // logically identical with xchain-sync/src/ClientRollback.js; a cross-repo drift
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
                     ORDER BY action_index ASC
                     LIMIT 1`;
                //</ESCROW-REDERIVE-SQL>
                let escrowTickers = await this.indexerDb.doQuery(escrowAffectedTickersSql, []);
                for(let row of escrowTickers){
                    let offerRows = await this.indexerDb.doQuery(escrowOpenOfferSql, [row.tick, row.tick, row.tick]);
                    let newEscrow = (offerRows.length > 0) ? offerRows[0].action_index : null;
                    await this.indexerDb.doQuery("UPDATE tokens SET escrow_action_index=? WHERE tick_id=(SELECT id FROM index_tickers WHERE tick=? LIMIT 1)", [newEscrow, row.tick]);
                }
            }

            // ROLLCALL eviction repair, and it MUST run before the block-table loop below
            // deletes the rollcall_absences rows it reads.
            //
            // The generic delegations repair above cannot cover an eviction. That repair is a
            // self-join on an orphaned DELEGATE-revoke row, and an eviction writes no revoke
            // row: it stamps every delegation of the source directly. So the only record of
            // which sources were stamped is `evicted = 1` in rollcall_absences, which is
            // exactly why that column exists. The stakes side needs nothing here -- the
            // eviction wrote real `unstakes` rows at the close block, so the orphaned-unstake
            // join above already re-NULLs those stamps.
            try {
                let rcStaking = this.config['STAKING'];
                let rcDelay   = Number((rcStaking && rcStaking['ACTIVATION_DELAY_BLOCKS'])
                                       ? rcStaking['ACTIVATION_DELAY_BLOCKS'] : this.config['ACTIVATION_DELAY_BLOCKS']);
                await this.indexerDb.doQuery(
                    `UPDATE delegations d
                        JOIN rollcall_absences ra ON ra.source_id = d.source_id
                        SET d.deactivation_block = NULL
                        WHERE ra.evicted = 1
                          AND ra.close_block >= ?
                          AND d.deactivation_block IS NOT NULL
                          AND d.deactivation_block = ra.close_block + ?`,
                    [block_index, rcDelay]);
            } catch(e){
                // Swallow ONLY a genuine schema gap (1054/1146) on a DB that predates the
                // ROLLCALL migration; no eviction can exist on such a node, so there is
                // nothing to repair. Every other fault must surface.
                if(!(e && (e.errno === 1054 || e.errno === 1146))) throw e;
            }

            // The two BTC-side ROLLCALL tables delete on close_block. They are declared
            // rollback: 'special' rather than 'block' because neither has a block_index
            // column, so the generic blockTables loop below would throw 1054 on them and
            // fail the entire rollback transaction on every reorg.
            // Absences before verdicts, so a partial failure cannot leave an absence row
            // pointing at an epoch whose verdict is already gone; the catch swallows ONLY
            // the schema gap on a node that predates the ROLLCALL migration, where the
            // tables do not exist and there is nothing to unwind. This is the ONLY
            // roll-call unwind: xchain-sync/src/ClientRollback.js carries the replica's
            // mirror of it, and a second copy here re-raises 1146 on a pre-migration node
            // and aborts the reorg this guard exists to keep alive.
            try {
                await this.indexerDb.doQuery(`DELETE FROM rollcall_absences WHERE close_block >= ?`, [block_index]);
                await this.indexerDb.doQuery(`DELETE FROM rollcalls WHERE close_block >= ?`, [block_index]);
            } catch(e){
                if(!(e && (e.errno === 1054 || e.errno === 1146))) throw e;
            }

            // Delete data from tables using block_index
            for(let table of this.blockTables){
                query = `DELETE FROM ` + table + ` WHERE block_index >= ?`;
                args  = [block_index];
                await this.indexerDb.doQuery(query, args);
            }

            // Second scoping key for validator_rewards: the MATERIALIZATION block. The
            // loop above deletes on block_index, which for a reward is its EARN block.
            // That is the same block for every writer except the BTC-side anchor/archive
            // derivation, which earns at the checkpoint's SNAPSHOT_BLOCK S but
            // creates the row while processing a later BTC block B (stamped derive_block_index).
            // A reorg to any H in (S, B] orphans the block that MINTED the reward while leaving
            // block_index = S below the delete's scope, so the row survived as a COLLECT-
            // spendable credit that a from-genesis replay to H-1 has not derived yet: the next
            // COLLECT reads a larger SUM(validator_rewards) here than on a freshly-synced node,
            // which is a ledger-hashed fork. Deleting on the creating block makes the reorged
            // node match the replay, and the derivation is idempotent, so the row re-materializes
            // when the canonical chain reaches the mirrored attestation again.
            //
            // Runs AFTER the loop (so it also covers a row the earn-block delete already took,
            // as a no-op) and BEFORE the index_addresses/index_tickers deletes below, which
            // require that no surviving row still points at an id they are about to remove.
            // NULL derive_block_index (every same-block writer, and every row written before the
            // column existed) is never matched, so this is byte-neutral until the derive flag-day
            // arms. Wrapped for the schema gap on a node that has not yet taken the column.
            try {
                await this.indexerDb.doQuery(
                    `DELETE FROM validator_rewards WHERE derive_block_index >= ?`, [block_index]);
            } catch(e){
                // Swallow ONLY a genuine schema gap (1054 unknown column) on a DB that predates
                // the migration; on such a node no derived reward can exist either, so there is
                // nothing to delete. Every other fault (deadlock, lock-wait, killed connection)
                // must propagate so the whole reorg transaction rolls back rather than committing
                // a partial rollback that keeps a spendable reward.
                if(!(e && (e.errno === 1146 || e.errno === 1054))) throw e;
            }

            // Roll back the index id lookups (index_addresses / index_tickers).
            //
            // These ids became consensus-relevant once an address/ticker can be referenced
            // on the wire as ^<id>: a wire ^<id> is stored verbatim into a *_id column and
            // resolved back to a string at block-hash time, so the SAME ^<id> must name the
            // SAME entity on every node. The ids are assigned by an explicit dense counter
            // (db.getNextAddressId / getNextTickerId), so deleting the ids first seen in the
            // orphaned blocks lets the surviving MAX(id)+1 reproduce them deterministically
            // when the canonical chain is reapplied. (Pre-^id, these tables were intentionally
            // NOT rolled back: their AUTO_INCREMENT ids never rewound and fed no hashed value.
            // That is now a fork vector, so they ARE rolled back.)
            //
            // MUST run AFTER the action_index and block_index data deletes above: every row
            // that referenced an orphaned-block id has already been removed, so no surviving
            // row is left pointing at a deleted id. Rows whose block_index is NULL
            // (pre-migration / never stamped) are never matched and are left untouched.
            for(let table of this.indexTables){
                query = `DELETE FROM ` + table + ` WHERE block_index >= ?`;
                args  = [block_index];
                await this.indexerDb.doQuery(query, args);
            }

            // F1a recovery reward re-arm. validator_rewards is block-scoped and was deleted
            // above by earn-block (block_index >= firstBlockIndex). Re-arm the staging rows for
            // those same earn-blocks so the reward can be re-materialized on the canonical chain.
            // Key on the reward's earn-block (block_index), NOT on whether the source address
            // rolled out: a reward row is dropped iff its earn-block is in the orphaned range,
            // independent of its source address. The common (and easily missed) case is an
            // address first seen BEFORE the range that earns a reward INSIDE it: the reward row
            // is deleted but the address survives, so the old "source_id NOT IN index_addresses"
            // predicate never fired and the reward was silently lost forever. MUST run AFTER the
            // validator_rewards/index_addresses deletes above. No-op (and the table may be absent
            // on a non-recovery stack) outside an in-progress recovery, so it is wrapped cheaply.
            //
            // The floor is NOT the reorg height alone. A restored row carries the
            // MATERIALIZATION block it was first derived at (earn + the frozen mirror
            // maturity), so the derive-scoped delete above takes it whenever that height is
            // orphaned - which happens for earn-blocks a whole maturity window BELOW the reorg
            // point. Re-arming only from the reorg height would leave those rows applied=1 with
            // no validator_rewards row behind them: the reward would be gone from this node for
            // good while the live fleet re-derives it from its mirror when the canonical chain
            // reaches the same height again. restoredRewardRearmFloor drops the floor by exactly
            // the maturity window on a network where derivation is armed, and stays at the reorg
            // height everywhere else (nothing below it can carry a derive stamp).
            let rearmFloor = ar.restoredRewardRearmFloor(block_index, String(this.config['NETWORK'] || ''));
            if(rearmFloor === null) rearmFloor = block_index;
            try {
                let rearm = await this.indexerDb.doQuery(
                    `UPDATE recovery_pending_rewards
                        SET applied=0, source_id=NULL, applied_block=NULL
                      WHERE applied=1 AND block_index >= ?`, [rearmFloor]);
                if(rearm && rearm.affectedRows)
                    this.indexerDb._recoveryPendingChecked = false;
                let survivors = await this.indexerDb.doQuery(
                    `SELECT DISTINCT rpr.source_address AS source_address, ia.id AS source_id
                       FROM recovery_pending_rewards rpr
                       JOIN index_addresses ia ON ia.address = rpr.source_address
                      WHERE rpr.applied=0`);
                // Re-materialize at the reorg point B (block_index): the survivor's reward
                // earn-block may be < B, so stamp applied_block = B as the forward-window key
                // xchain-sync streams it by (its earn-block sits below the post-reorg window).
                // A row whose ORIGINAL derive height is still ahead of B is left staged by the
                // apply path's due gate and lands again when the replay reaches that height,
                // which is the same block a live node re-derives it at.
                for(let s of (survivors || []))
                    await this.indexerDb._applyPendingRewardsForAddress(s.source_address, s.source_id, block_index);
            } catch(e){
                // Swallow ONLY the schema-gap case: recovery_pending_rewards absent on a
                // non-recovery stack (errno 1146 missing table / 1054 missing column), where
                // nothing was staged to re-arm. Every other fault (lock-wait timeout, deadlock,
                // killed connection) must propagate to the outer catch so the whole reorg
                // transaction rolls back and is retried, instead of commitTransaction()
                // persisting a half-re-armed recovery_pending_rewards/validator_rewards set
                // (which forks SUM(validator_rewards) at the next COLLECT). Mirrors the
                // narrow errno gates in xchain-sync's ClientApplier.
                if(!(e && (e.errno === 1146 || e.errno === 1054))) throw e;
            }

            // Sweep balances rows orphaned by the index-table delete above. `balances` is a
            // derived table keyed by (address_id, tick_id); it is NOT in dataTables (not
            // deleted by action_index) and is normally reconciled by updateAddressBalance.
            // But when an address (or tick) is seen ONLY in the orphaned range, its
            // index_addresses/index_tickers row was just deleted, so the refresh below
            // resolves the string to NULL (suppressIndexIdCreation) and updateAddressBalance
            // can no longer locate the stale row by its now-deleted id. That leaves a zombie
            // balance whose id matches no index row, which inflates sum(balances) and trips
            // sanityCheck on the next block touching the tick (indexer halts). A
            // from-genesis replay never created that row, so deleting every balance whose
            // address_id/tick_id no longer resolves makes the reorged node match a fresh
            // one. (Pre-suppressIndexIdCreation this was masked: createAddress resurrected the
            // id and updateAddressBalance recomputed the row to 0 and removed it, at the cost
            // of the ^<id> fork the index delete exists to close. The id PKs are NOT NULL, so
            // the NOT IN subqueries never short-circuit on a NULL.) Mirrors the icons orphan
            // sweep above.
            await this.indexerDb.doQuery(
                `DELETE FROM balances
                 WHERE address_id NOT IN (SELECT id FROM index_addresses)
                    OR tick_id    NOT IN (SELECT id FROM index_tickers)`, []);

            // Same orphan-sweep for the other two derived tables that reference a rolled-back
            // index id but are NOT removed by the action_index / block_index delete loops
            // (an audit of every table referencing index_addresses/index_tickers found exactly
            // these plus balances and the icons sweep above):
            //
            //  - markets (tick1_id, tick2_id): updateMarkets only UPDATEs existing rows, never
            //    deletes, so a pair whose tick is orphaned-only keeps a row with a dangling
            //    tick id. Worse on id reclaim: getMarketId(tick1, reclaimed_id) then matches the
            //    stale row and the new pair silently inherits the old market's price/volume.
            //  - pubkeys (address_id -> pubkey, INSERT IGNORE): an orphaned-only source address
            //    leaves a dangling row; because the write is INSERT IGNORE, a later address that
            //    reclaims the id keeps the OLD pubkey. Not consensus-hashed (block hashes take
            //    source_pubkey from the decoder DB, not this table), so this is stale-data, not a
            //    fork, but it still mis-attributes a pubkey after id reuse.
            //
            // A from-genesis node never created either row, so deleting any whose id no longer
            // resolves makes the reorged node match it.
            await this.indexerDb.doQuery(
                `DELETE FROM markets
                 WHERE tick1_id NOT IN (SELECT id FROM index_tickers)
                    OR tick2_id NOT IN (SELECT id FROM index_tickers)`, []);
            await this.indexerDb.doQuery(
                `DELETE FROM pubkeys
                 WHERE address_id NOT IN (SELECT id FROM index_addresses)`, []);

            // IDX-2: the dangling-tick sweep above misses a market whose pair was FIRST traded only in
            // the orphaned range but whose ticks survive (both were issued in earlier surviving
            // blocks). createMarket inserts the markets row on the first order for a pair; if that
            // order (and every other order/match for the pair) is in the orphaned range, the generic
            // dataTables delete removes the orders but updateMarkets only refreshes stats, never
            // deletes, so a zeroed-stats row lingers that a from-genesis replay never created. Scoped
            // to the pairs this rollback collected (`markets`), each is dropped only if NO surviving
            // orders/order_matches row references it in either orientation. markets is unhashed and
            // snapshot-replicated (no consensus reader), so this is a fresh-replay parity fix.
            for(let pair of markets){
                let survives = await this.indexerDb.doQuery(
                    `SELECT 1 FROM orders o
                        WHERE (o.give_tick_id=? AND o.get_tick_id=?) OR (o.give_tick_id=? AND o.get_tick_id=?)
                        LIMIT 1`,
                    [pair.tick1_id, pair.tick2_id, pair.tick2_id, pair.tick1_id]);
                if(survives.length === 0){
                    survives = await this.indexerDb.doQuery(
                        `SELECT 1 FROM order_matches om
                            WHERE (om.give_tick_id=? AND om.get_tick_id=?) OR (om.give_tick_id=? AND om.get_tick_id=?)
                            LIMIT 1`,
                        [pair.tick1_id, pair.tick2_id, pair.tick2_id, pair.tick1_id]);
                }
                if(survives.length === 0){
                    await this.indexerDb.doQuery(
                        `DELETE FROM markets WHERE (tick1_id=? AND tick2_id=?) OR (tick1_id=? AND tick2_id=?)`,
                        [pair.tick1_id, pair.tick2_id, pair.tick2_id, pair.tick1_id]);
                }
            }

            // Delete consensus price snapshots anchored to the orphaned blocks.
            // price_snapshots anchors each round to a block via reference_block
            // (its equivalent of block_index) rather than block_index itself, so
            // it falls outside the generic blockTables loop above and needs its
            // own delete. Without it, snapshots tied to orphaned blocks survive
            // with status='finalized' and a from-genesis replay on the new chain
            // never regenerates those rounds, leaving replaying nodes permanently
            // divergent from surviving nodes on this table.
            //
            // Note: other hub-mirrored block-anchored tables (state_checkpoints,
            // capability_snapshots) are intentionally NOT deleted here. Both are
            // append-only with supersede-by-seq / MAX-per-height read semantics,
            // so a stale row is harmless once the hub pushes a higher-seq
            // replacement; convergence is hub-driven for those tables. The
            // price_snapshots delete exists because a from-genesis replay never
            // regenerates orphaned rounds, so hub re-mirror alone cannot close
            // the divergence window on this table.
            // PRICE-SNAP-1: reference_block is ALWAYS a BTC anchor height (the PRICE v0 wire field),
            // regardless of the publishing chain, and reference_chain records that publisher. The old
            // unqualified `reference_block >= block_index` therefore (a) is a numeric no-op on a
            // DOGE/LTC indexer (local heights dwarf BTC anchors) and (b) would, once the price
            // capability is resolvable off-BTC, let a BTC reorg delete a DOGE/LTC-published round
            // anchored to a BTC height that the hub (source_chain-scoped) still keeps - a mirror-hole
            // fork on a table that feeds getOracleDataForVM. Scope the delete to BTC-published rounds
            // on the BTC indexer only; off-BTC rounds converge via the hub's source_chain retraction,
            // exactly as the note above describes. Behavior-preserving today (all v0 rounds are BTC).
            if(this.config['COIN'] === 'BTC'){
                query = `DELETE FROM price_snapshots WHERE reference_chain = 'BTC' AND reference_block >= ?`;
                args  = [block_index];
                await this.indexerDb.doQuery(query, args);
            }

            // oracle_prices is the per-action local mirror of PRICE v1 rows
            // (populated by hub_db_sync). Like price_snapshots, its rows are
            // tagged by source_chain + action_index and are NOT regenerated by a
            // from-genesis replay on the new chain. The async hub retraction
            // (retractPriceRange below) handles convergence eventually, but a
            // reorg concurrent with a hub blip leaves stale rows serving until
            // the hub reconnects. Deleting them here closes that window; the
            // later hub-driven delete is a harmless no-op. The delete MUST be
            // qualified by source_chain (COIN) because oracle_prices holds rows
            // from ALL chains and action_index is only unique within a chain.
            query = `DELETE FROM oracle_prices WHERE source_chain = ? AND action_index >= ?`;
            args  = [this.config['COIN'], firstActionIndex !== null ? firstActionIndex : Number.MAX_SAFE_INTEGER];
            await this.indexerDb.doQuery(query, args);

            // cross_chain_calls / cross_chain_matches are the per-action local mirrors
            // of hub-relayed XCALL + cross-chain DEX rows (populated by hub_db_sync).
            // Like oracle_prices above, they are tagged by source chain + a per-chain
            // action_index and are NOT regenerated by a from-genesis replay on the new
            // chain. The async hub retractions (retractXcallRange / retractMatchRange
            // below) converge eventually, but a reorg concurrent with a hub blip would
            // leave stale 'finalized' calls / matches serving until the hub reconnects;
            // deleting them here closes that window and the later hub-driven row:deleted
            // is a harmless no-op. cross_chain_matches is two-sided: a match drops when
            // EITHER leg on this chain was rolled back. Predicates are byte-identical to
            // ClientRollback.js (drift-guarded by the markers below), and deliberately NOT
            // to hub_db_sync.js _applyRetraction: that path additionally carries the bounded
            // to_action_index clause and the item-5308 push_generation fence, and for these
            // two quorum-class tables the fence is MANDATORY (an unfenced retraction is
            // refused outright), so its emitted SQL is always stricter than this one.
            // The asymmetry is the point. This delete is our own authoritative rollback of
            // our own chain, so it is unbounded from the orphan point up; the hub-driven
            // delete acts on untrusted input and must be fenced to a generation we produced.
            // Do not "reconcile" the two by adding a fence here or dropping one there.
            //<CROSS-CHAIN-MIRROR-REORG-DELETE>
            let crossChainFrom = firstActionIndex !== null ? firstActionIndex : Number.MAX_SAFE_INTEGER;
            query = `DELETE FROM cross_chain_calls WHERE source_chain = ? AND source_action_index >= ?`;
            args  = [this.config['COIN'], crossChainFrom];
            await this.indexerDb.doQuery(query, args);
            query = `DELETE FROM cross_chain_matches WHERE (a_chain = ? AND a_action_index >= ?) OR (b_chain = ? AND b_action_index >= ?)`;
            args  = [this.config['COIN'], crossChainFrom, this.config['COIN'], crossChainFrom];
            await this.indexerDb.doQuery(query, args);
            //</CROSS-CHAIN-MIRROR-REORG-DELETE>

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

            // The refresh helpers below resolve addresses/tickers collected from the
            // orphaned range (the read phase ran before the deletes). An entity that
            // existed ONLY in rolled-back blocks has just had its index_addresses /
            // index_tickers row removed by the indexTables delete above. Without this
            // guard, createAddress/createTicker (reached via updateAddressBalance and
            // updateTokenInfo -> getTokenInfo) would RE-CREATE that lookup row, resurrecting
            // the just-deleted id at the surviving MAX(id)+1. A fresh-from-genesis node
            // never had that entity, so the same id stays free there and a wire ^<id>
            // reference resolves to a different entity -> the exact consensus fork this
            // rollback delete set out to close. suppressIndexIdCreation makes the create
            // helpers resolve-only for the duration: surviving entities still resolve to
            // their existing id; orphaned-only entities resolve to null and the refresh is
            // a harmless no-op (their data rows are already gone). Reset in finally so a
            // throw (e.g. sanityCheck supply mismatch) never leaks the read-only mode into
            // the next forward block.
            this.indexerDb.suppressIndexIdCreation = true;
            try {

                // Update address balances to get back to sane balances based on credits/debits
                await this.indexerDb.updateBalances(Object.keys(addresses), true);

                // Update token information
                await this.indexerDb.updateTokens(tickers, true);

                // Update market information
                await this.indexerDb.updateMarkets(markets, block_index);

                // Do a sanity check to verify that token supplies match data in credits/debits/escrows/balances tables
                await this.indexerDb.sanityCheck(block_index);

            } finally {
                this.indexerDb.suppressIndexIdCreation = false;
            }

            // Bump the push-generation fence (HUB-RETRACT-1) and write-ahead the hub retractions
            // (HUB-RETRACT-2), both INSIDE this transaction so they commit atomically with the
            // deletes above. Placed last (after sanityCheck) so any earlier failure rolls the bump
            // back and the reorg is retried cleanly. bumpPushGeneration routes through the open
            // transaction connection (doQuery), so a failure throws into the catch below.
            let bumpedGeneration = await this.indexerDb.bumpPushGeneration(this.config['COIN']);
            retractionGeneration = bumpedGeneration - 1;

            // Write-ahead the three retraction intents as durable pending_hub_pushes rows, committed
            // atomically with the rollback. Previously the retractions were only enqueued in the
            // post-commit failure path, so a crash (or DB-pool blip) between commit and the live RPC
            // dropped them permanently - the retried reorg skips rollback() (lastIndexerBlock already
            // below minReorgBlock), so they were never re-issued, leaving orphaned 'finalized' hub
            // rows serving fleet-wide. The rows are inserted AFTER the dataTables purge, so this
            // rollback's own orphan delete cannot remove them; and a deeper later reorg's purge
            // deliberately EXCLUDES these retraction push_types (HUB-RETRACT-2 nested-reorg guard,
            // see the pending_hub_pushes delete above), so they are never superseded by a later
            // purge and instead drain idempotently under the generation fence. The
            // durable rows are CLOSED-range (bounded by lastActionIndex): a queued drain runs after
            // replay may have re-published rows above lastActionIndex, which must be preserved.
            if(firstActionIndex !== null && this.hubClient && this.hubClient.enabled){
                for(let pushType of ['price_retraction', 'xcall_retraction', 'match_retraction']){
                    let id = await this.indexerDb.enqueueHubPushTx(pushType, {
                        coin: this.config['COIN'], action_index: firstActionIndex,
                        last_action_index: lastActionIndex, retraction_generation: retractionGeneration });
                    stagedRetractions.push({ pushType, id });
                }
            }

            // Commit: the rollback is now atomically applied
            await this.indexerDb.commitTransaction();

            // Invalidate the height-keyed getBlockTime() memo on BOTH DB instances. This reorg
            // just changed the content of every height >= block_index: the decoder re-inserted
            // the new-chain block(s) with new block_time(s), and the indexer's blocks rows were
            // deleted above. The memo is keyed by height only and is never otherwise cleared, so
            // without this a depth-1 reorg replay of the same height would hit a stale cache and
            // drive the block with the orphaned chain's timestamp (a unilateral consensus fork on
            // any straddling time gate). Clearing after commit guarantees the forward replay
            // re-reads the new chain's block_time.
            if(this.decoderDb && typeof this.decoderDb.clearBlockTimeCache === 'function') this.decoderDb.clearBlockTimeCache();
            if(this.indexerDb && typeof this.indexerDb.clearBlockTimeCache === 'function') this.indexerDb.clearBlockTimeCache();

            // Same reorg, same class of stale memo, same place for the same reason:
            // drop the light-client touched-key resolver caches. They map a
            // surrogate id to its canonical name and were cached for the connection
            // lifetime on the premise that the mapping is immutable. A rollback is
            // exactly where that premise fails, because it deletes index_tickers /
            // index_addresses rows above the reorg point and FREES their dense ids for
            // createTicker/createAddress to reassign to whatever the new chain interns.
            // (createTicker documents the same hazard from the other side: it refuses
            // to mint under suppressIndexIdCreation because resurrecting a deleted id
            // would re-open the wire ^<id> fork.)
            //
            // A stale entry yields NO leaf and no error rather than a wrong one: the
            // touched key is recorded under the OLD name, getNetBalance matches
            // nothing, _leafOrNull turns 0 into null, and the commitment deletes a key
            // that never existed. The block's balances_root then comes out
            // byte-identical to its predecessor's and the real leaf is never written.
            //
            // Cleared HERE, immediately after commit and beside the block-time memo,
            // not at the end of rollback(): a throw between here and there would skip
            // it on an already-committed rollback, which is precisely the stale-cache
            // state this prevents. Clearing is cheap (pure memoisation, refilled on
            // demand); invalidating per deleted id would mean enumerating rows this
            // pass has already deleted.
            if(this.indexerDb){
                this.indexerDb._smtTickNameCache    = null;
                this.indexerDb._smtAddressNameCache = null;
            }
            // Still needed on its own after db.clearSmtNameCaches() was wired into
            // every transaction ABORT: this frees ids by COMMITTING deletes, an abort
            // frees them by un-assigning them, and neither implies the other.

            // Invalidate the early-decide tally watermark. This reorg may have deleted
            // and re-added ledger, vote, and delegation rows at or above block_index (and reused
            // action_index values), so any cached poll fingerprint could now match spuriously and
            // wrongly skip a re-tally on the replay. Drop them all; the forward replay re-tallies
            // each armed poll on first sight, exactly as on a fresh process.
            if(this.indexerDb && typeof this.indexerDb.clearPollTallyWatermark === 'function') this.indexerDb.clearPollTallyWatermark();

            // Destructive rollback is done and committed; clear the in-progress marker so
            // /health reflects a caught-up node again (#1812).
            if(this.indexer) this.indexer.stallReason = null;

        } catch(e) {
            // Roll back so the DB is left untouched rather than in a partial rollback state
            await this.indexerDb.rollbackTransaction();
            // Clear the reorg marker on failure too so it can't stick; the caller re-detects
            // the reorg and retries, re-arming it on the next attempt (#1812).
            if(this.indexer) this.indexer.stallReason = null;
            throw e;
        }

        // Deliver the write-ahead hub retractions committed above (HUB-RETRACT-2). Each was already
        // durably staged in pending_hub_pushes inside the rollback transaction, so even a crash right
        // here loses nothing: HubPushQueue drains the surviving rows on restart. Here we just try an
        // IMMEDIATE live delivery to prune the hub's orphaned oracle_prices / cross_chain_calls /
        // cross_chain_matches rows without waiting for the queue's backoff, and drop the durable row
        // on success. Any failure simply leaves the row for the queue (retractions are idempotent and
        // generation-fenced, so re-delivery is safe).
        //
        // The immediate delivery is OPEN-ENDED (last_action_index = null): it runs before any forward
        // replay re-publishes rows, so an open-ended delete hits only orphans. The durable fallback
        // row is CLOSED-range (bounded by lastActionIndex) because a queued drain runs later, after
        // replay may have re-published rows above lastActionIndex that must be preserved.
        //
        // Quiesce the durable queue across delivery so an in-flight drain cannot race these rows (item
        // 5297); resume() is in the finally so the queue always restarts even if a delivery throws.
        if(stagedRetractions.length > 0){
            // await: pause() now waits for any in-flight drain to finish (HUB-RETRACT-3), so a
            // pre-fetched stale forward push cannot land on the hub after our retraction below.
            if(this.hubPushQueue) await this.hubPushQueue.pause();
            try {
                let coin       = this.config['COIN'];
                let liveByType = {
                    price_retraction: (last) => this.hubClient.retractPriceRange(coin, firstActionIndex, last, retractionGeneration),
                    xcall_retraction: (last) => this.hubClient.retractXcallRange(coin, firstActionIndex, last, retractionGeneration),
                    match_retraction: (last) => this.hubClient.retractMatchRange(coin, firstActionIndex, last, retractionGeneration),
                };
                for(let r of stagedRetractions){
                    try {
                        await liveByType[r.pushType](null);
                        await this.indexerDb.markHubPushDelivered(r.id);
                    } catch(err) {
                        // Live delivery failed; the durable (closed-range) write-ahead row stays for
                        // HubPushQueue to retry with backoff. A dropped retraction would otherwise
                        // leave orphaned 'finalized' hub rows serving fleet-wide (stale prices, XCALL
                        // relay rows eligible for re-injection, matches eligible for settlement).
                        console.warn('Rollback: live ' + r.pushType + ' failed; durable row ' + r.id +
                            ' will be retried by HubPushQueue:', err && err.message);
                    }
                }
            } finally {
                if(this.hubPushQueue) this.hubPushQueue.resume();
            }
        }

        // Structured completion summary so a successful rollback is distinguishable
        // from a hung/partial one in the log stream (#1812): target block, the rolled-
        // back action range, the staged hub retractions, and elapsed time.
        const elapsedMs     = Date.now() - rollbackStartedAt;
        const retractionIds = stagedRetractions.map(r => r.pushType + '#' + r.id);
        console.log('Rollback complete: to block ' + block_index +
            ', action range [' + firstActionIndex + ', ' + lastActionIndex + ']' +
            ', staged retractions ' + (retractionIds.length ? retractionIds.join(', ') : 'none') +
            ', elapsed ' + elapsedMs + 'ms');

        // Log the rollback time
        this.util.logTimer(rollbackTimer, 'Rollback Done');
    }

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
    async _reverseCooldownMaturities(block_index){
        let completedStatusId = await this.indexerDb.getStatusId('completed');
        let validStatusId     = await this.indexerDb.getStatusId('valid');
        if(completedStatusId === null || validStatusId === null)
            return;
        let query, gasTick = this.config['GAS'];
        // Feed the affected source address + tick of every reversed maturity into the
        // balance/supply recompute set. These unstake rows live in surviving blocks, so the
        // read-phase scan never saw them and neither `addresses` nor `tickers` holds them. The
        // refund credit is a net mint (its STAKE-time debit was burned), so deleting it must drop
        // both the source's cached balance AND the tick's tokens.supply; without seeding the
        // recompute here, updateBalances/updateTokens skip these rows and the cached projection
        // keeps the now-deleted refund (and trips the per-block supply sanityCheck). Collect BEFORE
        // the status reset below, which clears the status_id = 'completed' filter.
        let capAffected = await this.indexerDb.doQuery(
            `SELECT a.address
                FROM unstakes u
                    JOIN index_addresses a ON a.id = u.source_id
                WHERE u.status_id = ? AND u.cooldown_end_block >= ? AND u.block_index < ?`,
            [completedStatusId, block_index, block_index]);
        for(let row of capAffected)
            this.util.addAddressTicker(row.address, gasTick);
        let conAffected = await this.indexerDb.doQuery(
            `SELECT a.address, t.tick
                FROM contract_unstakes cu
                    JOIN index_addresses a ON a.id = cu.source_id
                    JOIN index_tickers   t ON t.id = cu.tick_id
                WHERE cu.status_id = ? AND cu.cooldown_end_block >= ? AND cu.block_index < ?`,
            [completedStatusId, block_index, block_index]);
        for(let row of conAffected)
            this.util.addAddressTicker(row.address, row.tick);
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

    // Re-derive attest_validator_stats rows touched at or after block_index.
    //
    // The counters are written incrementally by the ATTEST handler
    // (db.incrementAttestationValidatorStat):
    //   - fulfilled_count: +1 per verified signature on a STATUS='ok' response.
    //   - missed_count:    +1 per responsible-set validator when a request expires.
    //   - slashed_count:   Phase 4 (no producer yet → always 0).
    // Because the table is keyed by (validator_pubkey, provider_id) and carries
    // only counters, it can't be rolled back by deleting a row range. Earlier
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

        // Scope the two source scans below to the affected pairs' providers. Only
        // affected (pubkey, provider) pairs are re-inserted, and every source row
        // contributes counters solely under its own provider_id, so rows for other
        // providers are pure discarded work. Without this bound each reorg (including
        // routine depth-1 reorgs) pays a full-history scan + JSON parse of the whole
        // attests table inside the rollback transaction.
        let affectedProviders  = [...new Set(pairRows.map(r => String(r.provider_id)))];
        let providerPlaceholders = affectedProviders.map(() => '?').join(', ');

        // Drop the stale rows. Any pair whose entire history was orphaned simply
        // stays gone: a from-genesis replay would never have created its row.
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
             WHERE version = 1 AND response_status = 'ok' AND validator_signatures IS NOT NULL
               AND provider_id IN (` + providerPlaceholders + `)`,
            affectedProviders
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
        // expired. There is no per-validator expiry row to count, as the live path
        // recomputes the responsible set deterministically and bumps each member.
        // We reproduce that over the surviving requests that WOULD have expired in
        // a replay to block_index-1: a request expires at deadline_block+1 (the
        // first sweep past its deadline), so it counts iff deadline_block+1 <=
        // block_index-1 (i.e. deadline_block < block_index-1) AND no *valid*
        // response survives for it. Only a *terminal* valid v1 response
        // (response_status IN ('ok','expired')) excludes a request; a retryable
        // round (timeout/no_quorum/provider_error) leaves it 'pending' so it
        // still expires and charges missed_count via the v2 sweep. We derive eligibility from
        // surviving rows, NOT request_status. The resolved_block reset above only
        // covers flips inside the orphaned range, and deriving from rows keeps this
        // recomputation independent of status bookkeeping either way.
        let validId = await this.indexerDb.getStatusId('valid');
        let expiredReqs = await this.indexerDb.doQuery(
            `SELECT ar.request_id, ar.provider_id, ar.redundancy, ar.block_index, ar.deadline_block, ar.responsible_set_json
             FROM attests ar
             WHERE ar.version = 0
               AND ar.deadline_block < ?
               AND ar.provider_id IN (${providerPlaceholders})
               AND ar.request_status <> 'rejected'
               AND NOT EXISTS (
                   SELECT 1 FROM attests r
                   WHERE r.version = 1
                     AND r.request_id = ar.request_id
                     AND r.status_id = ?
                     AND r.response_status IN ('ok', 'expired')
               )`,
            [block_index - 1, ...affectedProviders, validId]
        );

        // Cache the capability set per request block; this must consult the SAME
        // snapshot and stake-weighted branch the live expiry path used, or missed_count
        // re-derives wrong after a reorg. At/after STAKE_WEIGHTED_QUORUM activation the
        // live path dedups multi-key sources to one slot, so the unweighted validator
        // list would credit an excluded key and drop a real one.
        let validatorsByBlock = new Map();
        for(let req of expiredReqs){
            // ATT-RECOMP-1: prefer the responsible set pinned as-of the request block at v0
            // creation (attests.responsible_set_json). It captures the historical stake amounts
            // BEFORE any later surviving slash, so the recompute reproduces the true responsible
            // set instead of re-deriving it against the CURRENT mutable stakes.amount (which a
            // surviving slash has already reduced → a divergent set → wrong missed_count). Legacy
            // rows created before the column existed carry NULL and fall back to the live
            // re-derive below (the pre-fix behaviour, with the known as-of-amount caveat).
            let responsible = null;
            if(req.responsible_set_json){
                try {
                    let parsed = JSON.parse(req.responsible_set_json);
                    if(Array.isArray(parsed))
                        responsible = parsed.map(p => String(p).toLowerCase());
                } catch(_) { responsible = null; }
            }
            if(responsible === null){
                let reqBlock = Number(req.block_index);
                let cached   = validatorsByBlock.get(reqBlock);
                if(cached === undefined){
                    // Mirroring actions/attest.js _computeResponsibleSet (#3233): the SWQ
                    // gate is BTC-anchored, and `reqBlock` is the request's LOCAL height, so
                    // off BTC it is already past the 961000 anchor and would resolve
                    // `weighted` TRUE out of band. This function's header requires
                    // byte-for-byte agreement with attest.js "or reorg-recomputed
                    // missed_count diverges from the live expiry path", so the two must
                    // short-circuit on the SAME condition, not just reach the same empty
                    // answer by different routes. Capability staking is BTC-only, so a
                    // non-BTC indexer has no responsible set to recompute.
                    let cached_weighted = false;
                    let vs = [];
                    if(this.config['COIN'] === 'BTC'){
                        cached_weighted = swq.isStakeWeightedQuorumActive(reqBlock, this.config['NETWORK']);
                        vs = cached_weighted
                            ? await this.indexerDb.getStakeWeightsByCapability('attestation', reqBlock)
                            : await this.indexerDb.getValidatorsByCapability('attestation', reqBlock);
                    }
                    cached = { weighted: cached_weighted, validators: vs || [] };
                    validatorsByBlock.set(reqBlock, cached);
                }
                // The provider floor is a PER-REQUEST bar, so it cannot ride the
                // per-block validator cache above: two requests at the same block against
                // different providers filter that one snapshot differently. Resolve it here
                // and let _responsibleSet apply it, keeping the cache provider-agnostic.
                responsible = this._responsibleSet(String(req.request_id), cached.validators, Number(req.redundancy), cached.weighted,
                                                   this.providerRegistry.getMinStake(String(req.provider_id), Number(req.block_index), this.config['NETWORK']));
            }
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

    // Deterministic responsible validator set. MUST mirror attest.js
    // _computeResponsibleSet byte-for-byte (sort by SHA256(request_id || pubkey),
    // when stake-weighted dedup to one slot per source keeping the lowest hash,
    // then take the top REDUNDANCY) or reorg-recomputed missed_count diverges from
    // the live expiry path. `validators` are the raw capability rows ({pubkey, source},
    // plus `weight` when weighted); `weighted` is swq.isStakeWeightedQuorumActive for
    // the request block. `minStake` is the request provider's block-anchored
    // min_stake_xchain floor at the request block, applied on the weighted path
    // only and BEFORE the ranking, exactly as attest.js._providerFloorFilter does; null
    // fails the recompute closed to an empty set the same way the live path does, so a
    // reorg cannot charge missed_count to validators the live expiry never held
    // responsible.
    _responsibleSet(requestId, validators, redundancy, weighted, minStake){
        if(!validators || validators.length === 0)
            return [];
        if(weighted){
            if(minStake === null || minStake === undefined)
                return [];
            validators = validators.filter(v => pmsh.meetsProviderFloor(v && v.weight, minStake));
            if(validators.length === 0)
                return [];
        }
        let withHash = validators.map(v => {
            let pk = String(v.pubkey).toLowerCase();
            let h  = crypto.createHash('sha256').update(String(requestId), 'utf8').update(pk, 'utf8').digest('hex');
            return { pubkey: pk, source: (v.source != null ? String(v.source) : null), hash: h };
        });
        withHash.sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
        if(weighted){
            let seen = new Set();
            withHash = withHash.filter(v => {
                if(v.source === null) return true;
                if(seen.has(v.source)) return false;
                seen.add(v.source);
                return true;
            });
        }
        return withHash.slice(0, Math.max(1, Number(redundancy) || 1)).map(v => v.pubkey);
    }
}

module.exports = Rollback;
