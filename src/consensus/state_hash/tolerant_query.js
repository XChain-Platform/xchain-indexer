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
 * Runs one state-section query, degrading to an empty class when an older
 * schema lacks the table (1146) or column (1054). Every other error rethrows,
 * errors without a numeric errno included, so a fault never hashes as no rows.
 *
 ********************************************************************/

async function tolerantQuery(db, sql, args){
    try {
        // Read through doQueryStrict: plain doQuery turns a read error outside a transaction into [].
        // Both Database classes carry it; only a canned-row test double falls back to doQuery.
        if(typeof db.doQueryStrict === 'function') return await db.doQueryStrict(sql, args);
        return await db.doQuery(sql, args);
    } catch(e){
        // Degrade only a schema gap; a fence, driver or plain Error must stop the hash.
        if(e && (e.errno === 1146 || e.errno === 1054)) return [];
        throw e;
    }
}

module.exports = { tolerantQuery };
