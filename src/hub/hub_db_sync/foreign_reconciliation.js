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
 * XChain Indexer - Hub DB Sync Client: foreign-row reconciliation
 *
 * The passes that clear what a complete re-page proves the hub does not hold:
 * retracted matches, finalized price rounds and capability snapshots left behind
 * by a repointed or rebuilt hub, and oracle rows the hub has retracted.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');
const { PRICE_FINALIZED_KEY_CAP, priceRoundKey, CAPABILITY_SNAPSHOT_KEY_CAP,
        capabilitySnapshotKey, ORACLE_PRICE_KEY_CAP, oraclePriceKey } = require('./mirror_bounds.js');
const { coerceMirrorValue, applyMirrorWrite, strictHubRead } = require('./mirror_write.js');

const CHECKPOINT_PAGE_LIMIT = 10000;
const CHECKPOINT_MAX_PAGES  = 1000;

function checkpointKey(row) {
    return [row.chain, row.network, row.checkpoint_seq].map(v => String(v)).join('\u0000');
}

function checkpointValue(value) {
    if (value === null || value === undefined) return value;
    if (value instanceof Date) return value.toISOString().replace('.000Z', 'Z');
    return String(value);
}

function checkpointRowsEqual(local, served, columns) {
    for (let column of columns) {
        if (column === 'id' || column === 'created_at') continue;
        if (checkpointValue(local[column]) !== checkpointValue(served[column])) return false;
    }
    return true;
}

module.exports = {

    // Mark pre-drain finalized matches retracted when a complete page omits
    // them below its certified watermark. Keep rows so later revivals can win.
    async snapshotFinalizedMatches() {
        try {
            let rows = await this.hubDb.doQuery(
                "SELECT match_id, effective_time FROM cross_chain_matches WHERE status = 'finalized'");
            return (rows || []).map(r => ({
                matchId: String(r.match_id),
                effectiveTime: Number(r.effective_time)
            })).filter(r => r.matchId !== '' && Number.isFinite(r.effectiveTime));
        } catch (e) {
            getLogger().warn('HubDbSync: match retraction snapshot skipped (read failed):', e);
            return null;
        }
    },

    async reconcileRetractedMatches(servedMatchIds, preDrainMatches, certifiedWatermark) {
        certifiedWatermark = Number(certifiedWatermark);
        if (!servedMatchIds || !Array.isArray(preDrainMatches) || !Number.isFinite(certifiedWatermark)) return;
        let stale = preDrainMatches.filter(r =>
            r.effectiveTime <= certifiedWatermark && !servedMatchIds.has(r.matchId));
        if (stale.length === 0) return;
        // Keep the snapshot's content in the UPDATE predicate. A live revive that changes
        // effective_time while the drain runs must not be overwritten by an older verdict.
        for (let i = 0; i < stale.length; i += 250) {
            let chunk = stale.slice(i, i + 250);
            let args = [];
            for (let row of chunk) args.push(row.matchId, row.effectiveTime);
            try {
                await this.hubDb.doQuery(
                    "UPDATE cross_chain_matches SET status = 'retracted' WHERE status = 'finalized' AND (" +
                    chunk.map(() => '(match_id = ? AND effective_time = ?)').join(' OR ') + ')', args);
            } catch (e) {
                getLogger().warn('HubDbSync: match retraction reconciliation failed for a chunk:', e);
                return;
            }
        }
        getLogger().warn('HubDbSync: reconciled ' + stale.length + ' cross_chain_matches row(s) the hub has retracted ' +
                     'but this mirror still held as finalized (missed retraction converged, #3211)');
        await this.refreshMatchSyncTimestamp();
    },

    // Delete finalized keys omitted by a complete unfiltered drain, plus skipped
    // rows below the lowest round served by a drain from zero.
    async reconcileForeignPriceRounds(servedKeys, keysComplete, maxServedRound, floorTs, minServedRound) {
        if (!servedKeys) return;
        let stale = await this.staleForeignPriceRoundIds(servedKeys, keysComplete, maxServedRound, floorTs);
        if (stale === null) return;
        let staleSkipped = await this.staleSkippedPriceRoundIds(floorTs, minServedRound);
        if (staleSkipped.length > 0) await this.deleteForeignPriceRows(staleSkipped, 'skipped');
        if (stale.length === 0) return;
        await this.deleteForeignPriceRows(stale, 'finalized');
        await this.refreshPriceSyncHeight();
    },

    // Local skipped rows below the lowest round a drain from zero served. Empty when the
    // drain started at the mirror floor (it never saw the hub's oldest rows), served
    // nothing, or the read failed.
    async staleSkippedPriceRoundIds(floorTs, minServedRound) {
        if (Number(floorTs) > 0 || minServedRound === null || minServedRound === undefined) return [];
        let floorRound = Number(minServedRound);
        if (!Number.isFinite(floorRound)) return [];
        try {
            let locals = await this.hubDb.doQuery(
                "SELECT id FROM price_snapshots WHERE status = 'skipped' AND round_number < ?", [floorRound]);
            return (locals || []).map(r => Number(r.id)).filter(Number.isFinite);
        } catch (e) {
            getLogger().warn('HubDbSync: skipped price round reconciliation skipped (read failed):', e);
            return [];
        }
    },

    async deleteForeignPriceRows(stale, status) {
        // Chunk deletes to bound statement size and report each chunk as
        // bootstrap progress for the stall detector.
        let startedAt = Date.now();
        let lastReportAt = startedAt;
        for (let i = 0; i < stale.length; i += 500) {
            let chunk = stale.slice(i, i + 500);
            try {
                await this.hubDb.doQuery(
                    'DELETE FROM price_snapshots WHERE id IN (' + chunk.map(() => '?').join(',') + ')', chunk);
            } catch (e) {
                getLogger().warn('HubDbSync: price round reconciliation failed for a chunk:', e);
                return;
            }
            let now = Date.now();
            if (this._bootstrapping) {
                this._bootstrapLastProgressAt = now;
                this._bootstrapProgressTicks = (Number(this._bootstrapProgressTicks) || 0) + 1;
            }
            let done = i + chunk.length;
            if (this.bootstrapProgressMs > 0 && done < stale.length &&
                (now - lastReportAt) >= this.bootstrapProgressMs) {
                lastReportAt = now;
                getLogger().info('HubDbSync: removing ' + status + ' price_snapshots rows this hub does not hold: ' +
                    done + ' of ' + stale.length + ' deleted, ' +
                    Math.max(1, Math.round((now - startedAt) / 1000)) + 's elapsed');
            }
        }
        getLogger().warn('HubDbSync: removed ' + stale.length + ' ' + status + ' price_snapshots row(s) this hub ' +
            'does not hold (a repointed or rebuilt hub leaves the previous one\'s rounds behind' +
            (status === 'finalized' ? ', and the newest round_number wins every price read' : '') +
            '); the mirror now holds only what this hub serves');
    },

    // Stage a complete checkpoint page before replacing conflicting natural keys.
    // Remove only pre-pass rows absent from the served set after replacements land.
    async reconcileStateCheckpoints(scope) {
        let allowed;
        try {
            allowed = await this.localColumns('state_checkpoints');
        } catch (e) {
            getLogger().warn('HubDbSync: checkpoint reconciliation skipped (local schema read failed):', e);
            return false;
        }
        // Compatibility with a legacy or reduced mirror schema. Without the natural key,
        // replacement cannot be made safer than the existing filtered INSERT IGNORE path.
        if (!allowed.has('chain') || !allowed.has('network') || !allowed.has('checkpoint_seq')) return true;

        let local;
        try {
            local = await strictHubRead(this.hubDb,
                'SELECT * FROM state_checkpoints' + (scope ? ' WHERE network = ?' : ''),
                scope ? [scope] : undefined);
        } catch (e) {
            getLogger().warn('HubDbSync: checkpoint reconciliation skipped (local read failed):', e);
            return false;
        }
        local = Array.isArray(local) ? local : [];
        if (local.length === 0) return true;

        let served = await this.completeStateCheckpointPage();
        if (served === null) return false;
        let localByKey = new Map(local.map(row => [checkpointKey(row), row]));
        let servedKeys = new Set();
        let replaced = 0;
        try {
            for (let row of served) {
                if (scope && String(row.network) !== String(scope)) continue;
                let key = checkpointKey(row);
                servedKeys.add(key);
                let columns = Object.keys(row).filter(column => column !== 'id' && allowed.has(column));
                if (!columns.includes('chain') || !columns.includes('network') || !columns.includes('checkpoint_seq'))
                    throw new Error('served checkpoint row is missing its natural key');
                let prior = localByKey.get(key);
                if (prior && checkpointRowsEqual(prior, row, columns)) continue;
                let sql = 'REPLACE INTO state_checkpoints (' + columns.map(column => '`' + column + '`').join(', ') +
                    ') VALUES (' + columns.map(() => '?').join(', ') + ')';
                let args = columns.map(column =>
                    coerceMirrorValue(row[column], this.cachedColumnType('state_checkpoints', column)));
                await applyMirrorWrite(this.hubDb, sql, args);
                replaced++;
            }
        } catch (e) {
            getLogger().warn('HubDbSync: checkpoint reconciliation stopped before stale-row removal:', e);
            return false;
        }

        let stale = local.filter(row => !servedKeys.has(checkpointKey(row)))
            .map(row => Number(row.id)).filter(Number.isFinite);
        for (let i = 0; i < stale.length; i += 500) {
            let chunk = stale.slice(i, i + 500);
            try {
                await applyMirrorWrite(this.hubDb,
                    'DELETE FROM state_checkpoints WHERE id IN (' + chunk.map(() => '?').join(',') + ')', chunk);
            } catch (e) {
                getLogger().warn('HubDbSync: checkpoint reconciliation failed during stale-row removal:', e);
                return false;
            }
        }
        if (replaced > 0 || stale.length > 0)
            getLogger().warn('HubDbSync: reconciled state_checkpoints to the serving hub lineage (' + replaced +
                ' conflicting row(s) replaced, ' + stale.length + ' unserved row(s) removed)');
        return true;
    },

    // Return the complete source table, or null without modifying the mirror. A short page
    // is the completion proof. Missing rows, schema refusal, a non-advancing cursor, a fetch
    // failure, or the page-count backstop all leave the existing checkpoint lineage intact.
    async completeStateCheckpointPage() {
        let rows = [];
        let lastId = 0;
        for (let page = 0; page < CHECKPOINT_MAX_PAGES; page++) {
            let result;
            try {
                result = await this.httpGet('/hub-db/snapshot/state_checkpoints?since_id=' + lastId +
                    '&limit=' + CHECKPOINT_PAGE_LIMIT);
                if (!result || !Array.isArray(result.rows) ||
                    !(await this.acceptSnapshotPage('state_checkpoints', result)))
                    return null;
            } catch (e) {
                getLogger().warn('HubDbSync: checkpoint reconciliation page fetch failed:', e);
                return null;
            }
            for (let row of result.rows) {
                let rowId = Number(row && row.id);
                if (!Number.isInteger(rowId) || rowId <= lastId) {
                    getLogger().warn('HubDbSync: checkpoint reconciliation refused a non-advancing source page');
                    return null;
                }
                lastId = rowId;
                rows.push(row);
            }
            if (result.rows.length < CHECKPOINT_PAGE_LIMIT) return rows;
        }
        getLogger().warn('HubDbSync: checkpoint reconciliation reached its page-count backstop; mirror left unchanged');
        return null;
    },

    // Return foreign finalized ids by key, or by round ceiling after key overflow.
    // Return null on read or key-derivation failure; floorTs limits judged rows.
    async staleForeignPriceRoundIds(servedKeys, keysComplete, maxServedRound, floorTs) {
        let floor = (Number(floorTs) > 0) ? [Number(floorTs)] : [];
        let locals, stale;
        if (!keysComplete) {
            // An overflowed key set proves absence only above the highest served
            // round, so leave lower unmatched rows untouched.
            getLogger().warn('HubDbSync: price round reconciliation exceeded its key cap (' +
                PRICE_FINALIZED_KEY_CAP + '); falling back to the round-ceiling rule ' +
                '(rounds above ' + maxServedRound + ' only)');
            try {
                locals = await this.hubDb.doQuery(
                    "SELECT id FROM price_snapshots WHERE status = 'finalized' AND round_number > ?",
                    [maxServedRound]);
            } catch (e) {
                getLogger().warn('HubDbSync: price round reconciliation skipped (read failed):', e);
                return null;
            }
            stale = (locals || []).map(r => Number(r.id)).filter(Number.isFinite);
        } else {
            try {
                locals = await this.hubDb.doQuery(
                    "SELECT id, round_number, coin_pair FROM price_snapshots WHERE status = 'finalized'" +
                    (floor.length ? ' AND block_timestamp >= ?' : ''), floor);
            } catch (e) {
                getLogger().warn('HubDbSync: price round reconciliation skipped (read failed):', e);
                return null;
            }
            locals = locals || [];
            stale = locals
                .filter(r => !servedKeys.has(priceRoundKey(r.round_number, r.coin_pair)))
                .map(r => Number(r.id))
                .filter(Number.isFinite);
            // Refuse when no local finalized row matches a served key; that signals
            // incompatible key derivation and would otherwise empty the mirror.
            if (servedKeys.size > 0 && locals.length > 0 && stale.length === locals.length) {
                getLogger().error('HubDbSync: price round reconciliation refused: the hub served ' +
                    servedKeys.size + ' finalized round(s) but NONE of the ' + locals.length +
                    ' local finalized row(s) matched a served key. That is a key-derivation ' +
                    'mismatch, not contamination; leaving the mirror untouched.');
                return null;
            }
        }
        return stale;
    },

    // Delete pre-drain capability rows omitted by a complete unfiltered drain.
    // Exempt concurrent rows and refuse deletion when served and local keys never match.
    async reconcileForeignCapabilitySnapshots(servedKeys, keysComplete, maxServedBlock, preDrainMaxId) {
        if (!servedKeys) return;
        preDrainMaxId = Number(preDrainMaxId);
        // Nothing predates this drain: an empty mirror has nothing to reconcile, and a
        // read that failed reports 0 (see localMaxId), where deleting on a guess is the
        // one outcome worse than waiting for the next drain.
        if (!Number.isFinite(preDrainMaxId) || preDrainMaxId <= 0) return;
        let stale = await this.staleForeignSnapshotIds(servedKeys, keysComplete, maxServedBlock, preDrainMaxId);
        if (stale === null || stale.length === 0) return;
        // Chunked so one oversized IN list can never blow the statement limit.
        for (let i = 0; i < stale.length; i += 500) {
            let chunk = stale.slice(i, i + 500);
            try {
                await this.hubDb.doQuery(
                    'DELETE FROM capability_snapshots WHERE id IN (' + chunk.map(() => '?').join(',') + ')', chunk);
            } catch (e) {
                getLogger().warn('HubDbSync: capability snapshot reconciliation failed for a chunk:', e);
                return;
            }
        }
        getLogger().warn('HubDbSync: removed ' + stale.length + ' capability_snapshots row(s) this hub does not ' +
            'hold (a repointed or rebuilt hub leaves the previous one\'s validator sets behind, and every ' +
            'read of this table keys on snapshot_block); the mirror now holds only what this hub serves');
    },

    // Return pre-drain foreign snapshot ids by key, or by block ceiling after
    // key overflow. Return null on read or key-derivation failure.
    async staleForeignSnapshotIds(servedKeys, keysComplete, maxServedBlock, preDrainMaxId) {
        let stale;
        if (!keysComplete) {
            // An overflowed key set proves absence only above the highest served
            // snapshot block, so leave lower unmatched rows untouched.
            getLogger().warn('HubDbSync: capability snapshot reconciliation exceeded its key cap (' +
                CAPABILITY_SNAPSHOT_KEY_CAP + '); falling back to the snapshot_block-ceiling rule ' +
                '(boundaries above ' + maxServedBlock + ' only)');
            let rows;
            try {
                rows = await this.hubDb.doQuery(
                    'SELECT id FROM capability_snapshots WHERE id <= ? AND snapshot_block > ?',
                    [preDrainMaxId, maxServedBlock]);
            } catch (e) {
                getLogger().warn('HubDbSync: capability snapshot reconciliation skipped (read failed):', e);
                return null;
            }
            stale = (rows || []).map(r => Number(r.id)).filter(Number.isFinite);
        } else {
            let locals;
            try {
                // Read all local keys to validate derivation; the pre-drain id fence
                // still limits which rows can be deleted.
                locals = await this.hubDb.doQuery(
                    'SELECT id, snapshot_block, capability, signing_pubkey, source FROM capability_snapshots');
            } catch (e) {
                getLogger().warn('HubDbSync: capability snapshot reconciliation skipped (read failed):', e);
                return null;
            }
            locals = locals || [];
            let matched = locals.filter(r => servedKeys.has(capabilitySnapshotKey(r))).length;
            if (servedKeys.size > 0 && locals.length > 0 && matched === 0) {
                getLogger().error('HubDbSync: capability snapshot reconciliation refused: the hub served ' +
                    servedKeys.size + ' row(s) but NONE of the ' + locals.length + ' local row(s) matched ' +
                    'a served key. That is a key-derivation mismatch, not contamination; leaving the ' +
                    'mirror untouched.');
                return null;
            }
            stale = locals
                .filter(r => Number(r.id) <= preDrainMaxId && !servedKeys.has(capabilitySnapshotKey(r)))
                .map(r => Number(r.id))
                .filter(Number.isFinite);
        }
        return stale;
    },

    // Delete pre-drain oracle rows omitted by a complete unfiltered drain from zero.
    // Exempt concurrent rows and refuse deletion when served and local keys never match.
    async reconcileRetractedOracleRows(servedKeys, keysComplete, preDrainMaxId) {
        if (!servedKeys) return;
        preDrainMaxId = Number(preDrainMaxId);
        if (!Number.isFinite(preDrainMaxId) || preDrainMaxId <= 0) return;
        if (!keysComplete) {
            getLogger().warn('HubDbSync: oracle retraction reconciliation exceeded its key cap (' +
                ORACLE_PRICE_KEY_CAP + '); skipped for this drain');
            return;
        }
        let locals;
        try {
            locals = await this.hubDb.doQuery('SELECT id, source_chain, action_index FROM oracle_prices');
        } catch (e) {
            getLogger().warn('HubDbSync: oracle retraction reconciliation skipped (read failed):', e);
            return;
        }
        locals = locals || [];
        let matched = locals.filter(r => servedKeys.has(oraclePriceKey(r))).length;
        if (servedKeys.size > 0 && locals.length > 0 && matched === 0) {
            getLogger().error('HubDbSync: oracle retraction reconciliation refused: the hub served ' +
                servedKeys.size + ' row(s) but NONE of the ' + locals.length + ' local row(s) matched ' +
                'a served key. That is a key-derivation mismatch, not a retraction; leaving the ' +
                'mirror untouched.');
            return;
        }
        let stale = locals
            .filter(r => Number(r.id) <= preDrainMaxId && !servedKeys.has(oraclePriceKey(r)))
            .map(r => Number(r.id))
            .filter(Number.isFinite);
        if (stale.length === 0) return;
        for (let i = 0; i < stale.length; i += 500) {
            let chunk = stale.slice(i, i + 500);
            try {
                await this.hubDb.doQuery(
                    'DELETE FROM oracle_prices WHERE id IN (' + chunk.map(() => '?').join(',') + ')', chunk);
            } catch (e) {
                getLogger().warn('HubDbSync: oracle retraction reconciliation failed for a chunk:', e);
                return;
            }
        }
        getLogger().warn('HubDbSync: removed ' + stale.length + ' oracle_prices row(s) the hub has retracted ' +
            'but this mirror still held (a missed unsigned retraction, converged from a complete re-page)');
        await this.refreshOracleSyncTimestamp();
    },

};
