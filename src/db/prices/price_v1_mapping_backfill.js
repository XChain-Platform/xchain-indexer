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
 * XChain Indexer - Database mixin part: PRICE v1 SOURCE mapping backfill
 *
 * The one lookup query bin/backfill-price-v1-mappings.js needs: every stored PRICE v1
 * action (valid or invalid; the `prices` table logs both) whose SOURCE has no
 * mappings_actions row of its own yet, because it was indexed before 9fed3912 wired
 * SOURCE into addAddressTicker. Not one of the mixin files db/index.js installs onto
 * Database.prototype (that list is the live parse path's declared membership); the
 * backfill CLI calls this method bound to a Database instance instead. SQL still lives
 * under src/db/, where every query in this codebase belongs.
 *
 ********************************************************************/

module.exports = {

    // Every PRICE v1 SOURCE (type_id=2 in mappings_actions; see src/sql/mappings_actions.sql)
    // missing its own mapping row. Scoped per action_index, not per address: an address can
    // already carry mapping rows from OTHER actions, so existence is checked against the
    // exact (action_index, type_id, id) tuple createActionMapping/createActionMappings key on.
    async findUnmappedPriceV1MappingSources(){
        let query = `SELECT p.action_index AS action_index, p.source_id AS source_id, ia.address AS source_address
                     FROM prices p
                     JOIN index_addresses ia ON ia.id = p.source_id
                     WHERE p.version = 1
                       AND NOT EXISTS (
                            SELECT 1 FROM mappings_actions ma
                            WHERE ma.action_index = p.action_index AND ma.type_id = 2 AND ma.id = p.source_id
                       )
                     ORDER BY p.action_index ASC`;
        let rows = await this.doQuery(query);
        return rows.map(row => ({
            actionIndex:   Number(row.action_index),
            sourceId:      Number(row.source_id),
            sourceAddress: row.source_address
        }));
    },

};
