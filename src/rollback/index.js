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
 * This file handles processing rollbacks and updating the database.
 *
 * The class below holds the reorg driver: construction, the table lists, the
 * top-level rollback() and the transaction that orders every step. The steps
 * themselves are method groups in the files beside this one, installed onto
 * Rollback.prototype at the bottom in the order rollback() reaches them, so every
 * call site stays this.<method>(). The statements those steps run live under
 * src/db/rollback/, one file per group, and are called with the db handle.
 *
 ********************************************************************/

const ProviderRegistry = require('../attestation/provider_registry.js');
const lifecycle = require('../hub/table_lifecycle.js');
const { getLogger } = require('../observability/index.js');

const readPhaseMethods          = require('./read_phase.js');
const cooldownMaturityMethods   = require('./cooldown_maturities.js');
const inPlaceFlipMethods        = require('./in_place_flips.js');
const batchHeadMethods          = require('./batch_heads.js');
const rederiveMethods           = require('./rederive.js');
const purgeMethods              = require('./purge.js');
const sweepMethods              = require('./sweeps.js');
const attestationStatsMethods   = require('./attestation_stats.js');
const commitMethods             = require('./commit.js');

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

        // Inherit the indexer's utility methods and configuration, but own the mutable
        // address/ticker lists. Fee-quote dry runs dispatch through indexer.util and call
        // resetLists before every action. That reset can land between any two awaits in the
        // rollback entity loop, so sharing these lists could discard entities collected from
        // earlier tables or leak the quoted action's entities into the rollback recompute.
        this.util      = Object.create(indexer.util);
        this.util.resetLists();

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

        this.initRollbackTableLists();

    }

    // Generic rollback table lists, generated from the table-lifecycle
    // registry (src/hub/table_lifecycle.js): dataTables are deleted by
    // action_index, blockTables by block_index, indexTables are the two
    // wire-^<id> consensus lookups deleted by their own block_index. Per-
    // table rationale (why a table is generic vs recomputed vs bespoke vs
    // exempt) lives with its registry entry; classify NEW tables there,
    // not here. The bespoke restores/sweeps in rollback() below stay
    // hand-written and run in their required order around these loops.
    initRollbackTableLists(){
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
        this.assertAboveGenesis(block_index);

        // Start tracking time of rollback
        var rollbackTimer = this.util.startTimer();
        const rollbackStartedAt = Date.now();

        // Surface the in-progress rollback on /health for the whole reorg window, so a
        // hung or looping rollback is not misreported as last-known-good (a frozen
        // lastIndexedBlock with stallReason:null). Cleared after commit, and on the
        // failure path below (#1812).
        if(this.indexer) this.indexer.stallReason = 'reorg_rollback';

        // Notify user of start of rollback
        getLogger().info('Starting rollback to block ' + block_index + '...');

        // Reset the address/tickers/transactions lists
        this.util.resetLists();

        let scope                 = await this.readRollbackScope(block_index);
        let firstActionIndex      = scope.firstActionIndex;
        let lastActionIndex       = scope.lastActionIndex;

        // collectAffectedEntities returns this rollback's private address/ticker lists. A
        // concurrent fee-quote dry run uses indexer.util, so it cannot reset or refill them at
        // any await in the entity loop.
        let { markets, addresses, tickers } = await this.collectAffectedEntities(firstActionIndex);

        // The push-generation fence and the durable retraction rows the transaction stages
        // (stageHubRetractions carries the reasoning for both), read after the commit by the
        // live delivery and the completion summary.
        let staged = await this.runRollbackTransaction(block_index, scope, markets, addresses, tickers);

        await this.deliverStagedRetractions(firstActionIndex, staged.retractionGeneration, staged.stagedRetractions);

        this.logRollbackSummary(block_index, firstActionIndex, lastActionIndex, staged.stagedRetractions, rollbackStartedAt);

        // Log the rollback time
        this.util.logTimer(rollbackTimer, 'Rollback Done');
    }

    // The atomic part of the reorg: every delete, reset and re-derive, plus the hub
    // retractions written ahead of the commit so they survive a crash. A throw anywhere
    // inside leaves the database untouched, and the caller re-detects the reorg and retries.
    async runRollbackTransaction(block_index, scope, markets, addresses, tickers){
        let { firstActionIndex, lastActionIndex, unlandedAttestBatches } = scope;
        let staged = null;
        this.sweepStats = [];
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
            await this.reverseCooldownMaturities(block_index);

            if(firstActionIndex !== null){
                await this.deleteContractEmissions(firstActionIndex);
            }

            await this.restoreInPlaceFlips(block_index, firstActionIndex);

            await this.purgeOrphanedTables(block_index, firstActionIndex, markets);

            // Re-derive attest_validator_stats for the orphaned range. This is
            // a monotone aggregate (fulfilled/missed/slashed counters per
            // validator/provider) with no action_index or block FK, so neither
            // generic delete loop above can touch it. A blanket delete would also
            // drop increments earned in surviving blocks. Instead we drop only the
            // rows whose most-recent touch is in the orphaned range and rebuild them
            // from the surviving signatures + expired-request records, matching what
            // a from-genesis replay to block_index-1 would produce.
            await this.recomputeAttestationValidatorStats(block_index);

            await this.refreshDerivedProjections(block_index, addresses, tickers, markets);

                staged = await this.stageHubRetractions(firstActionIndex, lastActionIndex, unlandedAttestBatches);

            await this.commitAndInvalidateCaches();

        } catch(e) {
            // Roll back so the DB is left untouched rather than in a partial rollback state
            await this.indexerDb.rollbackTransaction();
            // Clear the reorg marker on failure too so it can't stick; the caller re-detects
            // the reorg and retries, re-arming it on the next attempt (#1812).
            if(this.indexer) this.indexer.stallReason = null;
            throw e;
        }
        return staged;
    }

    // Undo the flips an orphaned action wrote IN PLACE on a row that SURVIVES the reorg.
    // Each reset states its own fork risk; they share the guard because every one of them
    // is keyed on an orphaned action, so none has anything to undo without one.
    async restoreInPlaceFlips(block_index, firstActionIndex){
        if(firstActionIndex !== null){

            await this.resetOrphanedAttestRequests(block_index);

            await this.resetOrphanedXcallRequests(block_index);

            await this.reopenOrphanedPolls(block_index);

            await this.resetOrphanedBetFlips(block_index);

            await this.resetOrphanedPollCallbacks(block_index);

            await this.clearOrphanedDeactivations(block_index);

            await this.restoreContractSlashAmounts(block_index);

            await this.restoreDelegationRotations(block_index);

            await this.restoreCapabilitySlashAmounts(block_index);

            // Anchor reward reconcile-restore (RB-ANCHOR) was here; it now runs
            // UNCONDITIONALLY just past this guard, for the same reason the cooldown reversal
            // below left it: the BTC-side derive path calls reconcileAnchorRewardWinner with a
            // NULL anchor action index (anchor_reward_derive.js, the rows arrive over the
            // mirror), so it mints no actions row and an orphaned range carrying only a
            // derive-side reconcile leaves firstActionIndex null.

            // Cooldown-maturity reversal was here; it is now in reverseCooldownMaturities,
            // called UNCONDITIONALLY at the top of the transaction (before this guard). It had
            // to leave this firstActionIndex-gated block because the legacy cooldown maturity
            // (pre UNSTAKE_COOLDOWN_COMPLETION_ACTION) mints NO actions row, so an orphaned
            // range containing only such a maturity leaves firstActionIndex null and would skip
            // the reversal entirely, forking the ledger vs a from-genesis replay.

            await this.resetOrphanedArchiveHeads(block_index, firstActionIndex);

            await this.restoreStampedAttestHeads(firstActionIndex);

            await this.purgeActionScopedTables(firstActionIndex);

            await this.sweepOrphanedIcons();

            await this.rederiveTokenEscrow();

            await this.rederiveCoinpayMatchStatus();
        }
    }

    // Remove what the orphaned blocks left behind, in the order the deletes require:
    // the restores above read rows these statements drop, the index-id lookups go after
    // every row that references them, and the sweeps go after the rows they check for.
    async purgeOrphanedTables(block_index, firstActionIndex, markets){
        await this.restoreReconciledAnchorRewards(block_index);

        await this.repairRollcallEvictions(block_index);

        await this.unwindRollcallEpochs(block_index);

        await this.purgeBlockScopedTables(block_index);

        await this.purgeDerivedRewards(block_index);

        await this.purgeIndexLookups(block_index);

        await this.rearmRecoveryRewards(block_index);

        await this.sweepDanglingIndexReferences();

        await this.sweepOrphanedMarketPairs(markets);

        await this.purgeOrphanedPriceSnapshots(block_index);

        await this.purgeOrphanedOraclePrices(firstActionIndex);

        await this.purgeCrossChainMirrors(firstActionIndex);
    }

    // Genesis floor: the genesis block carries the bootstrapped Counterparty/Dogeparty
    // name ownership and is the consensus base of the ledger. A reorg can never legitimately
    // reach it, so refuse to roll back to or below it rather than destroy that state. Throwing
    // here (before any DB work) surfaces the attempt to the operator instead of silently
    // unwinding genesis. GENESIS_BLOCK = 0 (disabled) leaves normal rollback unaffected.
    assertAboveGenesis(block_index){
        let genesisBlock = this.config['GENESIS_BLOCK'];
        if(genesisBlock && Number(block_index) <= Number(genesisBlock)){
            let msg = 'Rollback to block ' + block_index + ' refused: at/below GENESIS_BLOCK ' + genesisBlock + ' (would destroy the bootstrapped genesis ledger)';
            getLogger().error(msg);
            throw new Error(msg);
        }
    }
}

// The step groups, in the order rollback() reaches them. A later group never redefines an
// earlier group's method: every name is defined exactly once across the files.
Object.assign(Rollback.prototype, readPhaseMethods, cooldownMaturityMethods, inPlaceFlipMethods,
              batchHeadMethods, rederiveMethods, purgeMethods, sweepMethods, attestationStatsMethods,
              commitMethods);

module.exports = Rollback;
