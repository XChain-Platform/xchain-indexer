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
 * by a repointed or rebuilt hub.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');
const { PRICE_FINALIZED_KEY_CAP, priceRoundKey, CAPABILITY_SNAPSHOT_KEY_CAP,
        capabilitySnapshotKey } = require('./mirror_bounds.js');

module.exports = {

    // Converge the half of a retract/revive the bootstrap cannot re-deliver (#3211).
    //
    // The hub never DELETEs a retracted match: retractMatchesForReorg UPDATEs it to
    // status='retracted' and broadcasts a deletion event, and the snapshot endpoint then
    // filters those rows out (`status <> 'retracted'`) so a bootstrapping mirror matches a
    // streamed one. That works only while the mirror SAW the deletion. A mirror that was
    // disconnected across the retraction - or that legitimately refused the event under the
    // receive-side guards - holds a finalized row the hub has retracted, and
    // no later delivery can fix it: the row is absent from every bootstrap page, so the
    // convergence ODKU never gets a version to compare against. The mirror keeps settling a
    // match the hub retracted, which is a money-bearing fork from a streamed peer.
    //
    // After a COMPLETE re-page, a local finalized row whose id is at or below the highest id
    // the hub served, and whose match_id the hub did not serve at all, can only be such a
    // retraction: ids are hub-parity and ascending, the hub never deletes, and the pages
    // covered every non-retracted row up to that ceiling. Rows ABOVE the ceiling are exempt -
    // they are newer than this snapshot and may simply have arrived after it.
    //
    // Converge by marking status='retracted', NOT by deleting:
    //   - consensus reads filter status='finalized' (db.getEffectiveUnsettledMatches), so the
    //     settlement effect is identical to the DELETE the streamed path applies;
    //   - a REVIVE is still able to win it back, because the convergence ODKU compares a
    //     later effective_time (a delete would leave the revive to INSERT, which is also
    //     fine, but marking keeps the row's provenance and matches AnchorRecovery's already
    //     documented retracted-row carve-out);
    //   - a mistaken mark is fail-CLOSED (a match stops settling), where a mistaken delete
    //     would also lose the signed row itself.
    async reconcileRetractedMatches(servedMatchIds, maxServedId) {
        if (!Number.isFinite(maxServedId) || maxServedId <= 0) return;   // nothing served, nothing to judge
        let locals;
        try {
            locals = await this.hubDb.doQuery(
                "SELECT id, match_id FROM cross_chain_matches WHERE id <= ? AND status = 'finalized'", [maxServedId]);
        } catch (e) {
            getLogger().warn('HubDbSync: match retraction reconciliation skipped (read failed):', e);
            return;
        }
        let stale = (locals || []).filter(r => !servedMatchIds.has(String(r.match_id))).map(r => Number(r.id));
        if (stale.length === 0) return;
        // Chunked so one oversized IN list can never blow the statement limit.
        for (let i = 0; i < stale.length; i += 500) {
            let chunk = stale.slice(i, i + 500);
            try {
                await this.hubDb.doQuery(
                    "UPDATE cross_chain_matches SET status = 'retracted' WHERE id IN (" +
                    chunk.map(() => '?').join(',') + ") AND status = 'finalized'", chunk);
            } catch (e) {
                getLogger().warn('HubDbSync: match retraction reconciliation failed for a chunk:', e);
                return;
            }
        }
        getLogger().warn('HubDbSync: reconciled ' + stale.length + ' cross_chain_matches row(s) the hub has retracted ' +
                     'but this mirror still held as finalized (missed retraction converged, #3211)');
        await this.refreshMatchSyncTimestamp();
    },

    // Clear finalized price rounds this hub does not hold.
    //
    // Repointing an indexer at a different hub - another network, a rebuilt database, a
    // re-genesised testnet - leaves every round the previous hub served sitting in the
    // mirror. price_snapshots is the one mirrored table with NO defence against that.
    // It carries no `network` column, so mirrorNetworkScope returns null and both
    // purgeForeignNetworkRows and purgeRebuiltSourceRows are unreachable for it; and
    // being a FULL_REPAGE table its cursor is forced to 0, so the id-ceiling fence that
    // detects a retired id space never runs. The re-page then converges only the keys the
    // two hubs SHARE, because applyRow's upsert is keyed on (round_number, coin_pair):
    // a foreign round the new hub has never reached is simply never addressed.
    //
    // Those survivors are not inert. Every consensus read takes the NEWEST finalized row
    // by round_number - db.getLatestPrice (ORDER BY round_number DESC LIMIT 1, the native
    // fee gate's price source) and the getPrice() preload (MAX(round_number) per pair) -
    // so a foreign round numbered above anything the new hub has reached wins every read
    // for the life of the mirror, and its old block_timestamp then fails the staleness
    // guard. That is the observed shape: a correctly-configured LTC testnet indexer
    // serving a 4.4-day-old XCHAIN/USD and a frozen LTC/USD with the fee gate shut, on a
    // mirror that was never going to converge, until the table was purged by hand.
    //
    // What makes the delete provable, and why it is a stronger warrant than the two
    // purges above rather than a weaker one: the hub's price_snapshots snapshot endpoint
    // applies NO filter (`SELECT * FROM price_snapshots WHERE id > ?`), unlike the
    // status-filtered match/call feeds. So a COMPLETE drain - short final page, zero apply
    // errors, which is the only state this runs in - has seen every row the hub holds. A
    // local finalized row at a key that drain did not serve as finalized is therefore a
    // row the hub does not have: either a round it never produced, or one it holds as
    // skipped/disputed, which the status-gated upsert deliberately refuses to downgrade.
    // Neither is recoverable by any later delivery, exactly like the retraction
    // reconcileRetractedMatches converges.
    //
    // Delete rather than mark: unlike a match, a price round has no status consensus
    // treats as a tombstone (a 'skipped' row IS a legitimate hub row), and the hub's own
    // row for that key re-arrives on the next drain if it exists. Local `skipped` rows are
    // left alone: no consensus read sees them, and the upsert converges them in place.
    async reconcileForeignPriceRounds(servedKeys, keysComplete, maxServedRound) {
        if (!servedKeys) return;
        let stale = await this.staleForeignPriceRoundIds(servedKeys, keysComplete, maxServedRound);
        if (stale === null || stale.length === 0) return;
        // Chunked so one oversized IN list can never blow the statement limit.
        for (let i = 0; i < stale.length; i += 500) {
            let chunk = stale.slice(i, i + 500);
            try {
                await this.hubDb.doQuery(
                    'DELETE FROM price_snapshots WHERE id IN (' + chunk.map(() => '?').join(',') + ')', chunk);
            } catch (e) {
                getLogger().warn('HubDbSync: price round reconciliation failed for a chunk:', e);
                return;
            }
        }
        getLogger().warn('HubDbSync: removed ' + stale.length + ' finalized price_snapshots row(s) this hub does ' +
            'not hold (a repointed or rebuilt hub leaves the previous one\'s rounds behind, and the newest ' +
            'round_number wins every price read); the mirror now holds only what this hub serves');
        await this.refreshPriceSyncHeight();
    },

    // The local finalized rows the drain proves foreign, by natural key when the served
    // set is complete and by the round ceiling when it overflowed. Null when the pass
    // must not run at all: a read failed, or the key derivation itself looks broken.
    async staleForeignPriceRoundIds(servedKeys, keysComplete, maxServedRound) {
        let locals, stale;
        if (!keysComplete) {
            // The set overflowed its memory cap, so absence from it proves nothing. Fall
            // back to the weaker half that needs no set: the drain saw every row the hub
            // holds, so no round above the highest it served exists there. This still
            // clears the shape that poisons the ORDER BY round_number DESC readers, and
            // leaves any lower-numbered foreign round for the operator.
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
                    "SELECT id, round_number, coin_pair FROM price_snapshots WHERE status = 'finalized'");
            } catch (e) {
                getLogger().warn('HubDbSync: price round reconciliation skipped (read failed):', e);
                return null;
            }
            locals = locals || [];
            stale = locals
                .filter(r => !servedKeys.has(priceRoundKey(r.round_number, r.coin_pair)))
                .map(r => Number(r.id))
                .filter(Number.isFinite);
            // Sanity fence on the KEY DERIVATION itself, not on the data. Every finalized
            // row this drain served was applied to the local table moments ago, so it must
            // read back into the served set. If the hub served finalized rounds and NOT ONE
            // local finalized row matched, the two sides are not producing the same key
            // (a column rename, a driver type change) and this pass would empty a healthy
            // mirror. Refuse, loudly: a stalled reconciliation is recoverable, a wiped
            // price history under a mirror the operator believes is converging is not.
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

    // Clear capability snapshots this hub does not hold (#1837).
    //
    // capability_snapshots is defenceless against a repoint for exactly the reasons
    // price_snapshots is: no `network` column (so mirrorNetworkScope returns null and
    // both purges are unreachable), and a FULL_REPAGE cursor forced to 0 (so the
    // id-ceiling fence never runs). The re-page then converges only the uq_cap_snap keys
    // the two hubs SHARE, and a row from the previous hub at a block boundary the new one
    // has never reached is simply never addressed. MEASURED 2026-08-28: both testnet
    // indexer mirrors still held 43 rows at snapshot_block 957439 - a BTC MAINNET height -
    // inherited from the retired first-generation mainnet hub.
    //
    // Those survivors are not inert. snapshot_block is the plane every read of this table
    // keys on: db.getStakeWeightsByCapability / getValidatorsByCapability resolve a
    // validator set at a block boundary, and applyRetraction gates the RETRACTION_SIGNING
    // era on MAX(snapshot_block) over the mirror itself, so a mainnet height sitting in a
    // testnet mirror both offers a mainnet stake set to any future capability whose
    // boundary lands on it and holds a flag-day gate open from the wrong chain's height.
    //
    // What makes the delete provable is the same warrant reconcileForeignPriceRounds
    // rests on, and it is the stronger kind: the hub's snapshot endpoint for this table is
    // UNFILTERED (hub api.js: SELECT * FROM capability_snapshots WHERE id > ?), and the hub
    // never deletes or prunes a row it has written, so a COMPLETE drain - short final page,
    // zero apply errors, the only state this runs in - has seen every row the hub holds. A
    // local row at a key that drain did not serve is a row this hub does not have, and no
    // later delivery can address it.
    //
    // TWO FENCES on top of that warrant, because this table is consensus-bearing:
    //   - only rows that PREDATE the drain are judged (id <= preDrainMaxId). The ids are
    //     locally assigned, so a row applied while the drain ran - a live WS event on this
    //     table applies immediately rather than buffering, unlike the price path - carries a
    //     higher id and is exempt; the next drain judges it once the pages cover it.
    //   - if the hub served rows and NOT ONE local row matched a served key, the two sides
    //     are not deriving the same key (a column rename, a driver type change) and this
    //     pass would empty a healthy mirror. Refuse, loudly: a stalled reconciliation is
    //     recoverable, a wiped validator-set history under a mirror the operator believes
    //     is converging is not.
    //
    // Delete rather than mark: presence of the row IS the qualification statement (there is
    // no status column and no tombstone consensus honours), and the hub's own row for that
    // key re-arrives on the next drain if it exists.
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

    // The local rows that predate the drain and that the drain proves foreign, by natural
    // key when the served set is complete and by the snapshot_block ceiling when it
    // overflowed. Null when the pass must not run: a read failed, or the key derivation
    // itself looks broken.
    async staleForeignSnapshotIds(servedKeys, keysComplete, maxServedBlock, preDrainMaxId) {
        let stale;
        if (!keysComplete) {
            // The set overflowed its memory cap, so absence from it proves nothing. Fall back
            // to the weaker half that needs no set: the drain saw every row the hub holds, so
            // no boundary above the highest it served exists there. That still clears the
            // shape this pass exists for (a foreign chain's height sits ABOVE anything a
            // younger network has reached) and leaves any lower foreign boundary alone.
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
                // Unrestricted read: the id fence decides what may be DELETED, but the
                // key-derivation fence below has to weigh every local row, including the ones
                // this drain just applied. On a mirror whose whole pre-drain content is
                // foreign - the repoint case - those fresh rows are the only proof that the
                // two sides still derive the same key.
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

};
