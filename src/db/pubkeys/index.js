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
 * XChain Indexer - Database mixin: pubkeys
 * 
 * The queries over the pubkeys table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    /*
     * Pubkeys table methods (address → pubkey mapping)
     */

    // Store an address_id → pubkey mapping in the pubkeys table (idempotent)
    async createPubkey(address_id, pubkey){
        if(!address_id || !pubkey) return;
        let query = "INSERT IGNORE INTO pubkeys (address_id, pubkey) VALUES (?, ?)";
        await this.doQuery(query, [address_id, String(pubkey)]);
    },

};
