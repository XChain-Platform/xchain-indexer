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
 * XChain Indexer - Hub DB Sync Client: table bootstrap, the owed re-page
 *
 * Which tables must re-page from zero before the mirror certifies again. A stored
 * wire position covers appends only, so a new connection, a forced resync or a
 * refused live row owes the affected tables one complete page, and that page is
 * what runs their reconciliation passes. Also the oracle_prices served-key state
 * that pass reads.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { MIRRORED_TABLES } = require('../mirror_tables.js');

module.exports = {

    // Require each named table to re-page from zero before the mirror certifies again. Every
    // mark takes a fresh sequence number, so a drain opened before the mark (one that may
    // have paged past the changed row already) cannot settle it.
    markRepageOwed(tables) {
        if (!(this._repageOwed instanceof Map)) this._repageOwed = new Map();
        for (let table of tables) {
            this._repageOwedSeq = (Number(this._repageOwedSeq) || 0) + 1;
            this._repageOwed.set(table, this._repageOwedSeq);
        }
    },

    // The sequence number of the mark a table is owed under, or undefined when it owes none.
    repageOwedSeq(table) {
        return (this._repageOwed instanceof Map) ? this._repageOwed.get(table) : undefined;
    },

    // Clear the table's mark when this drain was opened under it.
    settleRepageOwed(drain) {
        if (drain.repageSeq !== undefined && this.repageOwedSeq(drain.table) === drain.repageSeq)
            this._repageOwed.delete(drain.table);
    },

    // The tables still owed a re-page, in no particular order.
    repageOwedTables() {
        return (this._repageOwed instanceof Map) ? Array.from(this._repageOwed.keys()) : [];
    },

    // A forced resync is a full re-page of every table. Its terminate() closes with 1006,
    // which on its own keeps the positions of a same-instance hub, so forget the instance
    // and the positions, and owe every table a page from zero so a direct re-bootstrap
    // without a socket starts from zero as well.
    forgetPositionsForResync() {
        this._lastHubInstanceId = null;
        this._drainPositions = Object.create(null);
        this._priceRepageFloor = null;
        this.markRepageOwed(MIRRORED_TABLES);
    },

    // price_snapshots only, and only on a consumer with a mirror bound (the indexer). A
    // bounded drain never applies a row below the floor, so the re-page a same-instance
    // reconnect owes may start at the lowest wire id the last complete drain applied: every
    // row at or above the floor sits at or above that id, because ids only grow and a row
    // that was below the floor then is below it now. Kept to the case that is provably
    // equivalent: a recorded start from this hub instance, an active bound, a floor that
    // has not moved down, and a start inside the hub's advertised id space. An instance
    // change, a forced resync, a schema refusal or a refused bound clear the record, so
    // those re-page from zero. A floor-started drain counts as the owed re-page, and its
    // reconciliation judges only rows at or above the floor.
    choosePriceRepageStart(drain) {
        let mark = this._priceRepageFloor;
        if (drain.table !== 'price_snapshots' || drain.lastId !== 0 || drain.repageSeq === undefined || !mark) return;
        if (!(drain.priceHorizon > 0) || !(drain.priceFloor >= mark.floorTs)) return;
        if (Number.isFinite(drain.readyCeiling) && mark.wireId - 1 > drain.readyCeiling) return;
        drain.lastId = mark.wireId - 1;
        this._drainPositions[drain.table] = drain.lastId;
        drain.fullTable = false;
        drain.floorStart = true;
    },

    // Record where the next same-instance price re-page may start, after a complete drain
    // that saw every row at or above the floor (from zero, or itself from the floor).
    notePriceRepageFloor(drain) {
        if (drain.table !== 'price_snapshots' || !(drain.fullTable || drain.floorStart)) return;
        this._priceRepageFloor = (drain.priceHorizon > 0 && Number.isFinite(drain.minAppliedWireId))
            ? { wireId: drain.minAppliedWireId, floorTs: drain.priceFloor } : null;
    },

    // oracle_prices only. The hub DELETEs a retracted oracle row and its deletion event is
    // unsigned, so it is never replayed to a mirror that missed it. The snapshot endpoint is
    // UNFILTERED (hub db/oracle.js findOraclePricesAfterId), so a complete re-page is the
    // hub's whole table: collect the natural keys it served so reconcileRetractedOracleRows
    // can clear what it did not. Its live events apply immediately, so a row that lands after
    // the last page is local but unserved; the local id high-water read here, before the
    // first page, fences those rows out of the judgement.
    async newOracleReconcileState(drain, scope) {
        let oracle = (drain.table === 'oracle_prices');
        drain.servedOracleKeys    = oracle ? new Set() : null;
        drain.oracleKeysComplete  = true;
        drain.oraclePreDrainMaxId = oracle ? await this.localMaxId(drain.table, scope) : 0;
    },
};
