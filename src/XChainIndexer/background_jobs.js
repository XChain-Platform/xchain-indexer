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
 * XChain Indexer - Background jobs
 *
 * The two unref'd state-tree maintenance timers the indexer starts once its
 * databases are ready: the read-only orphan-count metric and the (default off)
 * state-retention sweep. Installed onto XChainIndexer.prototype by
 * ../XChainIndexer.js.
 *
 ********************************************************************/

const stateCommitment = require('../state_commitment/index.js');
const retention       = require('../chain/retention.js');
const { CONFIG_ENV }  = require('../config.js');
const { getLogger }   = require('../observability/index.js');

module.exports = {

    // Periodically emit a read-only orphan-count metric for the COW state_tree_nodes store so
    // its unbounded growth is observable. Runs on an unref'd interval (never holds
    // the process open), guarded against self-overlap, and reads on a POOLED connection so it never
    // touches the block-processing transaction. No deletion: see stateCommitment.reportOrphanStats.
    // Interval STATE_TREE_METRIC_INTERVAL_MS (default 4h; 0 disables).
    startStateTreeMetric(){
        if(this._stateTreeMetricTimer) return;
        const raw = parseInt(CONFIG_ENV.STATE_TREE_METRIC_INTERVAL_MS, 10);
        const intervalMs = Number.isFinite(raw) ? raw : (4 * 60 * 60 * 1000);
        if(intervalMs === 0) return;   // explicitly disabled
        this._stateTreeMetricRunning = false;
        this._stateTreeMetricTimer = setInterval(async () => {
            if(this._stateTreeMetricRunning) return;   // a prior slow scan is still running
            this._stateTreeMetricRunning = true;
            try {
                const stats = await stateCommitment.reportOrphanStats(
                    (sql, args) => this.indexerDb.poolQuery(sql, args),
                    this.config['COIN'], this.config['NETWORK']);
                if(stats.totalNodes === 0) return;   // pre-activation / empty store: nothing to report
                getLogger().info('[METRIC] ' + JSON.stringify({
                    metric: 'state_tree_orphan_nodes', component: 'indexer',
                    chain: this.config['COIN'], network: this.config['NETWORK'],
                    total_nodes: stats.totalNodes, reachable_nodes: stats.reachableNodes,
                    orphan_count: stats.orphanCount, reachability_skipped: stats.reachabilitySkipped,
                    // Publish the truncation flag or the line reads as a full-store figure:
                    // when the mark stops at the cap, orphan_count is an UPPER bound.
                    reachability_estimated: stats.reachabilityEstimated === true,
                    ts: Date.now()
                }));
            } catch(err) {
                getLogger().warn('XChainIndexer: state_tree orphan-metric failed for ' +
                    this.config['COIN'] + '/' + this.config['NETWORK'] + ':', err.message || err);
            } finally {
                this._stateTreeMetricRunning = false;
            }
        }, intervalMs);
        if(this._stateTreeMetricTimer.unref) this._stateTreeMetricTimer.unref();
        getLogger().info('XChainIndexer: state_tree orphan-metric started (interval ' + intervalMs + 'ms)');
    },

    // Periodic state-retention sweep. DEFAULT OFF: parseRetentionConfig returns
    // enabled=false unless STATE_ROOT_RETENTION_BLOCKS is a positive integer, and
    // this method returns before arming any timer in that case (current
    // keep-everything behavior unchanged). When enabled it runs runSweep: phase-1
    // root prune on a pooled connection, then, only if STATE_NODE_RECLAIM is opted
    // in, phase-2 orphan-node reclaim serialized against the block loop via the db
    // transaction mutex (runExclusive) so a concurrent forward insert can never
    // re-reference a node between the mark and the delete.
    startStateRetention(){
        if(this._stateRetentionTimer) return;
        // config.js's load-time snapshot, which carries every key parseRetentionConfig reads.
        const cfg = retention.parseRetentionConfig(CONFIG_ENV);
        if(!cfg.enabled) return;   // policy off: no timer, nothing prunes
        const runExclusive = async (fn) => {
            // Hold the same mutex block processing acquires in beginTransaction so
            // the mark+delete never interleaves with a forward block-root insert.
            await this.indexerDb.acquireTxLock();
            try { return await fn(); }
            finally { this.indexerDb.releaseTxLock(); }
        };
        this._stateRetentionRunning = false;
        this._stateRetentionTimer = setInterval(async () => {
            if(this._stateRetentionRunning) return;   // a prior slow sweep is still running
            this._stateRetentionRunning = true;
            try {
                const result = await retention.runSweep(
                    this.indexerDb, this.config['COIN'], this.config['NETWORK'], cfg,
                    { runExclusive });
                const rootsDeleted = result.roots && result.roots.deleted ? result.roots.deleted : 0;
                const nodesDeleted = result.nodes && result.nodes.deleted ? result.nodes.deleted : 0;
                if(rootsDeleted > 0 || nodesDeleted > 0){
                    getLogger().info('State retention: pruned ' + rootsDeleted + ' root(s) and reclaimed ' +
                        nodesDeleted + ' orphan node(s) for ' + this.config['COIN'] + '/' + this.config['NETWORK']);
                }
            } catch(err) {
                getLogger().warn('XChainIndexer: state-retention sweep failed for ' +
                    this.config['COIN'] + '/' + this.config['NETWORK'] + ':', err.message || err);
            } finally {
                this._stateRetentionRunning = false;
            }
        }, cfg.intervalMs);
        if(this._stateRetentionTimer.unref) this._stateRetentionTimer.unref();
        getLogger().info('XChainIndexer: state-retention started (keep ' + cfg.rootKeepBlocks +
            ' root-blocks, node-reclaim ' + (cfg.nodeReclaimEnabled ? 'ON' : 'off') +
            ', interval ' + cfg.intervalMs + 'ms)');
    }
};
