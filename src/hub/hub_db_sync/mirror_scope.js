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
 * XChain Indexer - Hub DB Sync Client: mirror scope
 *
 * Which rows a mirror may hold: the proven network scope and the foreign-network
 * purge and refusal paths.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');
const { REFUSED_ROW_NAMES, REFUSED_ROW_NAME_LIMIT } = require('./mirror_tables.js');

module.exports = {

    // The network this mirror may hold rows for, or null when that cannot be proven.
    //
    // A hub is deployed per network and stamps its own network on every federation-state
    // row it serves, so a mirrored row carrying a different one was served by a hub this
    // mirror no longer follows. Two conditions must both hold before anything is scoped
    // on that basis: the consumer told this client which network it serves (the display
    // mirror in the explorer does not, and a null return leaves the unscoped behavior
    // exactly as it is), and the LOCAL mirror table actually carries the column. The
    // second check reads the primed column cache rather than a hardcoded table list, so
    // a table that gains or loses the column is picked up from the schema itself.
    async mirrorNetworkScope(table) {
        if (typeof this.network !== 'string' || this.network === '') return null;
        let cols;
        try { cols = await this.localColumns(table); } catch (e) { return null; }
        return (cols && typeof cols.has === 'function' && cols.has('network')) ? this.network : null;
    },

    // Highest local surrogate id, used only to bound capability reconciliation rows that
    // predate the current drain. It is never a snapshot cursor.
    async localMaxId(table, scope) {
        try {
            let sql  = 'SELECT MAX(id) AS max_id FROM ' + table + (scope ? ' WHERE network = ?' : '');
            let rows = await this.hubDb.doQuery(sql, scope ? [scope] : undefined);
            if (rows && rows.length > 0 && rows[0].max_id) return Number(rows[0].max_id);
        } catch (e) {
            // Table may not exist yet; the caller starts at 0.
        }
        return 0;
    },

    // Remove rows that cannot satisfy readers scoped to this mirror's network.
    // Network identity comes from each row, independent of snapshot completeness.
    async purgeForeignNetworkRows(table, network) {
        let names = await this.foreignNetworkRowNames(table, network);
        let result;
        try {
            result = await this.hubDb.doQuery('DELETE FROM ' + table + ' WHERE network <> ?', [network]);
        } catch (e) {
            getLogger().warn('HubDbSync: could not clear foreign-network rows from ' + table + ':', e);
            return 0;
        }
        // doQuery collapses a non-transactional query error into [], which carries no
        // affectedRows and is otherwise indistinguishable from a clean zero-row delete.
        // Say so: an unreported purge leaves the cursor poisoned and the table draining
        // zero rows, which is precisely the silent stall this method exists to end.
        let removed = Number(result && result.affectedRows);
        if (!Number.isFinite(removed)) {
            getLogger().warn('HubDbSync: foreign-network purge of ' + table + ' reported no result; ' +
                'if the mirror keeps draining zero rows, this read is where to look');
            return 0;
        }
        if (removed <= 0) return 0;
        getLogger().warn('HubDbSync: removed ' + removed + ' row(s) from ' + table + ' belonging to a network ' +
            'other than ' + network + '; a mirror holds only rows for its configured network' +
            this.nameRefusedRows(table, names, removed));
        return removed;
    },

    // The names of the rows purgeForeignNetworkRows is about to delete, read first so its line
    // can say which rows went. A bounded read; a failure names nothing and deletes as before.
    async foreignNetworkRowNames(table, network) {
        let spec = REFUSED_ROW_NAMES[table];
        let column = spec ? spec.column : 'id';
        try {
            let rows = await this.hubDb.doQuery('SELECT ' + column + ' AS name FROM ' + table +
                ' WHERE network <> ? ORDER BY id LIMIT ' + (REFUSED_ROW_NAME_LIMIT * 5), [network]);
            return (Array.isArray(rows) ? rows : []).map(r => r && r.name)
                .filter(n => n !== null && n !== undefined && n !== '').map(String);
        } catch (e) {
            return [];
        }
    },

    // True when a row the hub served names a network other than the one this mirror serves,
    // and must therefore not be applied. The apply-time twin of purgeForeignNetworkRows, on
    // the same proof (mirrorNetworkScope: the consumer named its network and the local table
    // carries the column) and for the same reason. Without it such a row was MIRRORED on
    // arrival and removed only by the purge at the next bootstrap, so between the two it sat
    // in the mirror unrefused, and no line ever said a row had been kept out (bridge rail
    // policy AT4, 2026-09-29). A NULL or absent network applies as before, like the purge's
    // `network <> ?`. Refusals are counted for reportRefusedNetworkRows, like the chain fence.
    async refuseForeignNetworkRow(table, row) {
        let rowNetwork = (row && typeof row.network === 'string') ? row.network : null;
        if (!rowNetwork) return false;
        let scope = await this.mirrorNetworkScope(table);
        if (!scope || rowNetwork === scope) return false;
        if (!this._refusedNetworkRows) this._refusedNetworkRows = new Map();
        let key   = table + '|' + rowNetwork;
        let entry = this._refusedNetworkRows.get(key);
        if (entry) entry.count++;
        else this._refusedNetworkRows.set(key, entry = { table: table, network: rowNetwork, scope: scope, count: 1, names: [] });
        this.noteRefusedRowName(entry, table, row);
        return true;
    },

    // Report the foreign-network refusals counted for `table` since the last report, one line
    // per foreign network, naming the rows, and clear them. Called wherever the chain fence
    // reports: at the end of a table's drain and after a refused live row.
    reportRefusedNetworkRows(table) {
        if (!this._refusedNetworkRows) return;
        for (let [key, entry] of Array.from(this._refusedNetworkRows.entries())) {
            if (entry.table !== table) continue;
            this._refusedNetworkRows.delete(key);
            getLogger().warn('HubDbSync: refused ' + entry.count + ' ' + entry.table + ' row(s) for network ' +
                entry.network + ' (this mirror serves ' + entry.scope + ')' +
                this.nameRefusedRows(entry.table, entry.names, entry.count));
        }
    },

};
