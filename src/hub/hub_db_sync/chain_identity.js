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
 * XChain Indexer - Hub DB Sync Client: chain identity fence
 *
 * The Bitcoin block-1 identity the cross-chain tables are fenced to: learning it
 * locally or from the hub, purging the relics of a chain no longer followed,
 * refusing foreign rows, the BTC-only stake re-derivation fence, and the one
 * re-probe a hub-taught consumer makes before refusing a live row.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');
const { CROSS_CHAIN_TABLES } = require('./mirror_tables.js');

module.exports = {

    // ── Chain identity fence for the three CROSS_CHAIN_TABLES ────────────────────

    // Record which Bitcoin chain this mirror's cross-chain rows must belong to.
    //
    // `source` is 'local' (this node read block 1 from its own decoder database) or 'hub'
    // (the value the hub advertises on the snapshot envelopes); see the constructor for why
    // a local id outranks a hub one. Anything else is ignored.
    //
    // A null or malformed id STATES NOTHING and leaves the current expectation alone. A hub
    // that has not yet been told its chain advertises null, and clearing the expectation on
    // that would drop the fence at exactly the moment relics are being served.
    //
    // Returns true when the expectation moved. On the first non-null value, and on every
    // change after it, the local relics are purged (see purgeForeignChainIdRows): rows
    // applied before the identity was known - a freshly re-genesised chain has no block 1
    // while the first bootstrap drains - are otherwise invisible to the apply-time filter
    // for the life of the mirror.
    async setExpectedBtcChainId(id, source) {
        if (source !== 'local' && source !== 'hub') return false;
        let next = (typeof id === 'string') ? id.trim().toLowerCase() : null;
        if (next === null) return false;
        if (!/^[0-9a-f]{64}$/.test(next)) {
            getLogger().warn('HubDbSync: ignoring a malformed btc_chain_id from the ' + source + ' source: ' + id);
            return false;
        }
        // A local measurement is never replaced by a hub value; a disagreement is the hub's
        // to explain, and it is reported rather than acted on.
        if (source === 'hub' && this._btcChainIdSource === 'local') {
            if (next !== this._expectedBtcChainId) this.noteForeignHubChain(next);
            return false;
        }
        if (next === this._expectedBtcChainId) {
            this._btcChainIdSource = source;               // same chain, now measured locally
            return false;
        }
        let previous = this._expectedBtcChainId;
        this._expectedBtcChainId = next;
        this._btcChainIdSource   = source;
        this._chainIdProbedIds.clear();
        getLogger().info('HubDbSync: cross-chain rows are fenced to Bitcoin chain ' + next + ' (block 1, ' +
            (source === 'local' ? 'read from this node\'s own chain' : 'as advertised by the hub') + ')');
        await this.purgeForeignChainIdRows(previous);
        return true;
    },

    // The hub follows a different chain from the one this node indexes. Logged once per
    // process: it is an operator-visible misconfiguration (or a hub that has not caught up
    // with a venue re-genesis), not a per-row event, and the local measurement stands
    // either way, so every row naming the hub's chain is refused.
    noteForeignHubChain(hubChainId) {
        if (this._foreignHubChainNoted) return;
        this._foreignHubChainNoted = true;
        getLogger().warn('HubDbSync: the hub follows a different chain (it advertises btc_chain_id ' + hubChainId +
            ', this node indexes ' + this._expectedBtcChainId + '); its cross-chain rows for that chain are refused');
    },

    // Clear the mirrored cross-chain rows of a chain this mirror no longer follows.
    //
    // Runs when the expectation is first learned and whenever it changes, which is the one
    // window the apply-time filter cannot cover: rows the hub served before block 1 existed
    // were applied with no expectation to check them against, and nothing later re-delivers
    // them for the filter to refuse.
    //
    // Deletion rests on the warrant purgeForeignNetworkRows states: belonging to another
    // chain is a property of the ROW, provable from the row and this mirror's own
    // expectation, with no dependence on what one snapshot response happened to contain. A
    // NULL is not such a property - it means "written before the column existed" - so NULL
    // rows are always left in place.
    async purgeForeignChainIdRows(previous) {
        let expected = this._expectedBtcChainId;
        if (!expected) return 0;
        let total = 0, refreshMatches = false, refreshCalls = false, refreshBridge = false, refreshPolicy = false;
        for (let table of CROSS_CHAIN_TABLES) {
            let result;
            try {
                result = await this.hubDb.doQuery(
                    'DELETE FROM ' + table + ' WHERE btc_chain_id IS NOT NULL AND btc_chain_id <> ?', [expected]);
            } catch (e) {
                getLogger().warn('HubDbSync: could not clear foreign-chain rows from ' + table + ':', e);
                continue;
            }
            // doQuery collapses a non-transactional query error into [], which carries no
            // affectedRows and is otherwise indistinguishable from a clean zero-row delete.
            // Say so: an unreported purge leaves relics that the apply-time filter can never
            // reach again, which is the silent state this method exists to end.
            let removed = Number(result && result.affectedRows);
            if (!Number.isFinite(removed)) {
                getLogger().warn('HubDbSync: foreign-chain purge of ' + table + ' reported no result; ' +
                    'if this mirror keeps holding rows from a dead chain, this read is where to look');
                continue;
            }
            if (removed <= 0) continue;
            total += removed;
            getLogger().warn('HubDbSync: purged ' + removed + ' ' + table + ' row(s) from ' +
                (previous ? ('chain ' + previous) : 'another chain'));
            if (table === 'cross_chain_matches') refreshMatches = true;
            if (table === 'cross_chain_calls')   refreshCalls   = true;
            if (table === 'bridge_transfers')    refreshBridge  = true;
            if (table === 'policy_snapshots')    refreshPolicy  = true;
        }
        // Every one of these barriers caches MAX(effective_time) over its table, so a
        // purge that removed the row holding the maximum must re-read it exactly as a
        // retraction does; a cached scalar left high opens a barrier over rows that are gone.
        try {
            if (refreshMatches) await this.refreshMatchSyncTimestamp();
            if (refreshCalls)   await this.refreshCallSyncTimestamp();
            if (refreshBridge)  await this.refreshBridgeSyncTimestamp();
            if (refreshPolicy)  await this.refreshPolicySyncTimestamp();
            if (refreshMatches || refreshCalls) await this.releaseSnapshotWaiters();
        } catch (e) {
            getLogger().warn('HubDbSync: could not refresh the sync barriers after a foreign-chain purge:', e);
        }
        return total;
    },

    // True when this row belongs to a Bitcoin chain other than the one this mirror follows,
    // and must therefore not be applied.
    //
    // Only the three CROSS_CHAIN_TABLES carry the column. A NULL (or absent) value applies
    // as before, and so does every row while no expectation is known: the fence refuses only
    // on positive evidence that the row names a different chain.
    //
    // A refusal is NOT an apply error. The row is skipped, the cursor moves past it and the
    // drain continues, because a relic is not a hole in the mirror - it is a row the mirror
    // is supposed to be without - and failing the page closed here would wedge every
    // settlement barrier forever against a hub database nobody purged.
    refuseForeignChainRow(table, row) {
        if (CROSS_CHAIN_TABLES.indexOf(table) === -1) return false;
        let expected = this._expectedBtcChainId;
        if (!expected) return false;
        let rowChainId = (row && typeof row.btc_chain_id === 'string') ? row.btc_chain_id.trim().toLowerCase() : null;
        if (!rowChainId || rowChainId === expected) return false;
        let key   = table + '|' + rowChainId;
        let entry = this._refusedChainIdRows.get(key);
        if (entry) entry.count++;
        else this._refusedChainIdRows.set(key, { table: table, hash: rowChainId, count: 1 });
        return true;
    },

    // The authoritative-stake database, resolved lazily. Capability stakes are indexed
    // into the INDEXER db; the mirror db only holds the hub's copy of them, which is the
    // very thing under test here, so re-deriving against it would be self-certification.
    authoritativeStakeDb() {
        if (this.authoritativeDb) return this.authoritativeDb;
        let parent = this.hubDb && this.hubDb.indexer;
        return (parent && parent.indexerDb) ? parent.indexerDb : null;
    },

    // BTC-only re-derivation fence for one mirrored capability_snapshots row.
    // True = refuse the row.
    //
    // capability_snapshots is pulled from the hub over an unauthenticated SELECT and
    // applied with INSERT IGNORE, and it is the verification authority the off-BTC
    // resolvers read for cross_chain, oracle_publish, price and attestation. The full
    // remedy is an SMT membership proof against the BTC state_checkpoints stakes_root;
    // it needs a hub proof endpoint, a pinned trust anchor, a new activation height and
    // a grandfathering watermark, so it is a later spec round. THIS is the first step,
    // and its whole value is falsifiability: a BTC node holds the same stakes the hub
    // built these rows from, so it can catch a forged set instead of mirroring it.
    //
    // Deliberate limits, so nothing downstream reads more into this than it says:
    //   - It only ever runs where the node can prove the claim (BTC). Off BTC the verdict
    //     is 'unknown' and the row applies exactly as before, which is why this buys no
    //     coverage on the chains that actually resolve from the mirror.
    //   - Only CONTRADICTIONS are refused. A row the hub withheld is invisible here.
    //   - Every non-refusal (unreached block, unconfigured capability, truncated set,
    //     a read that threw, no authoritative db wired) applies the row. An unjudgeable
    //     row must never become a permanent mirror hole.
    async refuseUnprovenCapabilitySnapshot(row) {
        let db = this.authoritativeStakeDb();
        // The explorer's vendored display mirror carries no such db and no such method.
        if (!db || typeof db.verifyCapabilitySnapshotRow !== 'function') return false;
        let verdict;
        try {
            verdict = await db.verifyCapabilitySnapshotRow(row);
        } catch (e) {
            // A failed re-derivation is not evidence of a forgery.
            getLogger().warn('HubDbSync: capability_snapshots re-derivation failed, applying row unchecked: ' +
                (e && e.message ? e.message : e));
            return false;
        }
        if (!verdict || verdict.verdict !== 'refused') return false;
        getLogger().error('HubDbSync: REFUSED a capability_snapshots row this node can disprove from its own ' +
            'stakes - ' + verdict.reason + '. The hub is serving a validator set that contradicts the chain; ' +
            'off-BTC nodes cannot see this and will have mirrored it.');
        return true;
    },

    // Report the refusals counted for `table` since the last report, one line per foreign
    // chain, and clear them. Called at the end of that table's drain (so a bootstrap that
    // refused a whole relic table says so once, with the count) and after a refused live row.
    reportRefusedChainRows(table) {
        for (let [key, entry] of Array.from(this._refusedChainIdRows.entries())) {
            if (entry.table !== table) continue;
            this._refusedChainIdRows.delete(key);
            getLogger().warn('HubDbSync: refused ' + entry.count + ' ' + entry.table + ' row(s) carrying btc_chain_id ' +
                entry.hash + ' (this chain is ' + this._expectedBtcChainId + ')');
        }
    },

    // A live row names a chain this mirror does not follow. Decide, ONCE per id, whether the
    // mirror is the stale side.
    //
    // A 'hub' expectation is second-hand: such a consumer has no Bitcoin chain of its own to
    // read, so a venue re-genesis the hub has already adopted reaches it only as rows it
    // would otherwise refuse forever. Re-read ONE envelope; if the hub now advertises the
    // row's id, that is the hub restating its own identity, and the mirror follows it (which
    // purges the previous chain's rows before this row applies). A 'local' expectation is
    // this node's own measurement of the chain it indexes and is never adopted away from.
    async maybeAdoptHubChainId(table, row) {
        if (CROSS_CHAIN_TABLES.indexOf(table) === -1) return;
        let expected = this._expectedBtcChainId;
        if (!expected) return;
        let rowChainId = (row && typeof row.btc_chain_id === 'string') ? row.btc_chain_id.trim().toLowerCase() : null;
        if (!rowChainId || rowChainId === expected) return;
        if (this._btcChainIdSource !== 'hub') { this.noteForeignHubChain(rowChainId); return; }
        if (this._chainIdProbedIds.has(rowChainId)) return;  // asked once for this id already
        this._chainIdProbedIds.add(rowChainId);
        let envelope;
        try {
            envelope = await this.httpGet('/hub-db/snapshot/capability_snapshots?since_id=0&limit=1');
        } catch (e) {
            return;                                          // unreachable hub: refuse, and re-ask on a later id
        }
        let advertised = (envelope && typeof envelope.btc_chain_id === 'string')
            ? envelope.btc_chain_id.trim().toLowerCase() : null;
        if (advertised !== rowChainId) return;               // the hub does not claim this chain: refuse
        await this.setExpectedBtcChainId(advertised, 'hub');
    },

};
