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
 * schema lacks the table (1146) or column (1054). Any other numeric errno
 * rethrows; errors without a numeric errno are swallowed as before.
 *
 ********************************************************************/

async function tolerantQuery(db, sql, args){
    try {
        return await db.doQuery(sql, args);
    } catch(e){
        if(e && typeof e.errno === 'number' && e.errno !== 1146 && e.errno !== 1054) throw e;
        return [];
    }
}

module.exports = { tolerantQuery };
