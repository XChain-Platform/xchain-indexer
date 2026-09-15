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
 * XChain Indexer - Hub DB Sync Client: mirror scope and rebuilt sources
 *
 * Which rows a mirror may hold: the proven network scope, the local id cursor,
 * the foreign-network purge, and the two fences against a hub whose id space was
 * replaced (the ceiling comparison and the content probe).
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');
const { HUB_SCHEMA_VERSION } = require('../hub-schema-version');
const { REBUILT_SOURCE_IDENTITY_COLUMNS, REBUILT_SOURCE_PROBE_ROWS } = require('./mirror_tables.js');

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

    // Highest local id for a mirrored table, restricted to `scope`'s network when one was
    // proven. Returns 0 when nothing matches or the read fails (the table may not exist
    // yet), which starts the caller's cursor at the beginning of the hub's table.
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

    // Delete mirrored rows belonging to a network other than the one this mirror serves.
    //
    // Pointing an indexer at a hub for a different network leaves every row the earlier
    // hub served sitting in the mirror, carrying that hub's id space, and three separate
    // things break while they are there. Readers scope every query by network
    // (db.getPendingAnchorRewardAttestations), so the rows can never be consumed. The
    // bootstrap cursor is a MAX(id) over the table, so a foreign row with a higher id
    // than anything the current hub holds makes since_id ask for rows past the end of the
    // hub's table and the drain reports zero rows on every bootstrap for the life of the
    // mirror. And those foreign ids SIT ON the ids the current hub's own rows carry, where
    // the id-parity INSERT IGNORE apply drops the real row without an error, so scoping
    // the cursor on its own would still leave the mirror empty of the rows it should hold.
    //
    // Deletion is safe here in a way that "delete what the hub did not serve" is not:
    // belonging to another network is a property of the ROW, provable from the row and
    // this mirror's own configuration, with no dependence on what one snapshot response
    // happened to contain. A filtered snapshot endpoint, a paging hole or a partial drain
    // can each make a valid row look unserved; none of them can make it change network.
    async purgeForeignNetworkRows(table, network) {
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
            'other than ' + network + '; a mirror holds only what the hub it follows serves, and those rows ' +
            'block both the id cursor and the id-parity apply');
        return removed;
    },

    // Clear a mirrored table whose local rows belong to an id space the hub no longer has.
    //
    // The trigger is the caller's ceiling comparison: the hub advertised its own MAX(id)
    // for this table and the local cursor sits above it. On an append-only, never-retracted
    // table (the only kind this fence governs) that is not possible while both sides share
    // an id space, so the source's has been replaced - a rebuilt hub database restarting
    // its auto-increment at 1, or a different hub on the same network.
    //
    // Why the whole scope and not just the rows above the ceiling. The rows above it are
    // provably gone from the source, but the ones at or below it are the worse half: after
    // a rebuild, local id 5 and hub id 5 are DIFFERENT ROWS that merely share a number, and
    // the id-parity INSERT IGNORE apply then drops the hub's real row on arrival without an
    // error. Leaving them would re-page the whole table and still mirror almost none of it.
    //
    // Scoped exactly like the cursor that detected the problem, so on a mirror serving one
    // network this touches only that network's rows and leaves a null scope unscoped rather
    // than widening the delete beyond what was proven.
    // Compare the hub's first page against the mirror's rows at the SAME ids, and report the
    // first contradiction. A contradiction is the only evidence this method will return: a
    // row the hub does not serve at an id the mirror holds proves nothing (page windows,
    // filters and paging holes all produce that), while a DIFFERENT natural key at an id the
    // hub itself served cannot be produced by any of them on an append-only, id-parity table.
    //
    // Returns { id, column, local, hub } for the first such id, or null for "no evidence" -
    // which is also what every read that could not answer returns (no identity columns for
    // this table, no proven scope, a page the hub refused or shaped differently, a schema
    // version this build does not mirror, a local read that threw). Nothing is deleted on a
    // question that could not be asked.
    async detectRebuiltSourceByContent(table, scope, localMax) {
        let identity = REBUILT_SOURCE_IDENTITY_COLUMNS[table];
        if (!identity || !scope || !(localMax > 0)) return null;

        // The local table must actually carry every identity column; a schema that has
        // drifted from this build's expectation is not something to delete rows over.
        let cols;
        try { cols = await this.localColumns(table); } catch (e) { return null; }
        if (!cols || typeof cols.has !== 'function' || !identity.every((c) => cols.has(c))) return null;

        let page;
        try {
            page = await this.httpGet('/hub-db/snapshot/' + table +
                '?since_id=0&limit=' + REBUILT_SOURCE_PROBE_ROWS);
        } catch (e) {
            getLogger().warn('HubDbSync: rebuilt-source content probe of ' + table + ' could not fetch page 1:', e);
            return null;
        }
        if (!page || !Array.isArray(page.rows) || page.rows.length === 0) return null;
        // Same fail-closed rule the page loop applies: a row shape this build does not mirror
        // is not a row this build may judge.
        if (page.schema_version != null && page.schema_version !== HUB_SCHEMA_VERSION) return null;

        // Only ids the mirror could already hold, and only rows in this mirror's scope - the
        // local read below is network-scoped, so a hub row for another network has no local
        // counterpart to contradict and must not be compared against one.
        let hubById = new Map();
        for (let r of page.rows) {
            let id = Number(r && r.id);
            if (!Number.isFinite(id) || id <= 0 || id > localMax) continue;
            if (r.network != null && String(r.network) !== String(scope)) continue;
            hubById.set(id, r);
        }
        if (hubById.size === 0) return null;

        let ids = Array.from(hubById.keys());
        let local;
        try {
            local = await this.hubDb.doQuery(
                'SELECT id, ' + identity.join(', ') + ' FROM ' + table +
                ' WHERE network = ? AND id IN (' + ids.map(() => '?').join(',') + ')',
                [scope].concat(ids));
        } catch (e) {
            return null;
        }
        if (!Array.isArray(local) || local.length === 0) return null;

        for (let lr of local) {
            let hr = hubById.get(Number(lr.id));
            if (!hr) continue;
            for (let col of identity) {
                let mine  = this.identityText(lr[col]);
                let theirs = this.identityText(hr[col]);
                if (mine === theirs) continue;
                return { id: Number(lr.id), column: col, local: mine, hub: theirs };
            }
        }
        return null;
    },

    // Compare-only rendering of one identity value. The two sides arrive by different routes
    // (a driver row and a JSON wire row), so a BIGINT read back as a BigInt and the same
    // number on the wire must compare EQUAL or every bootstrap would report a contradiction.
    identityText(value) {
        if (value === null || value === undefined) return '';
        if (Buffer.isBuffer(value)) return value.toString('hex');
        return String(value);
    },

    // `evidence` names what proved the id space is retired, for the logs; the caller that
    // compares against the advertised ceiling leaves it out and gets that wording.
    async purgeRebuiltSourceRows(table, scope, localMax, ceiling, evidence) {
        let why = evidence || ('the local cursor ' + localMax + ' sits above the hub ceiling ' + ceiling);
        // NO PROVEN SCOPE, NO DELETE. Without a network this would be an unqualified
        // DELETE FROM <table>, and the caller reaches here on evidence about an ID SPACE,
        // which is a far thinner warrant than a whole-table wipe. Two consumers land here
        // with a null scope: one that named no network (the explorer's display mirror) and
        // one whose mirror table has no network column, and neither has proven which rows
        // are even in scope. mirrorNetworkScope and purgeForeignNetworkRows already take
        // exactly this position, and it would be strange for the more speculative delete to
        // be the bolder one. The cursor still restarts, which is the pre-existing behaviour
        // for these consumers and leaves them no worse than before.
        if (!scope) {
            getLogger().warn('HubDbSync: ' + table + ': ' + why + ', but this mirror has no proven network scope, ' +
                'so the retired rows are LEFT IN PLACE (an unscoped delete here would clear the whole table). ' +
                'Re-paging only; if this mirror keeps serving rows the hub does not have, give it a network.');
            return 0;
        }
        let result;
        try {
            result = await this.hubDb.doQuery('DELETE FROM ' + table + ' WHERE network = ?', [scope]);
        } catch (e) {
            getLogger().warn('HubDbSync: could not clear the stale id space from ' + table + ':', e);
            return 0;
        }
        // Same reasoning as the foreign-network purge: doQuery collapses a non-transactional
        // error into [], which is indistinguishable from a clean zero-row delete. Say so,
        // because an unreported purge here leaves the id-parity collision in place and the
        // re-page below then applies almost nothing, which is the silent stall this exists to end.
        let removed = Number(result && result.affectedRows);
        if (!Number.isFinite(removed)) {
            getLogger().warn('HubDbSync: rebuilt-source purge of ' + table + ' reported no result; ' +
                'if the mirror keeps serving rows the hub does not have, this read is where to look');
            return 0;
        }
        if (removed <= 0) return 0;
        getLogger().warn('HubDbSync: removed ' + removed + ' row(s) from ' + table + ' carrying a retired id space (' +
            why + '); the mirror will be rebuilt from the hub in full');
        return removed;
    },

};
