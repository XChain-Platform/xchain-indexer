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
 * XChain Indexer - Database mixin: orders
 * 
 * The queries over the orders table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>(). The family is split by behaviour into
 * parts under orders/, and this file is the entry that merges them into the one method set
 * it exports.
 *
 ********************************************************************/

const path    = require('path');

const { emptyMarketData, readMarketRow, readLastTradePrices, readDayAgoPrices,
        readBestBids, readBestAsks, readDayStats, applyDayChanges } = require('./market_reads.js');
const orderRows        = require('./order_rows.js');
const orderInfo        = require('./order_info.js');
const matchRows        = require('./match_rows.js');
const crossChainOffers = require('./cross_chain_offers.js');

// getMarketInfo stays in the entry because it reads the class for its statics, and only the
// entry can require the class below its own finished export (the note at the bottom): a part
// that did so would reach db/index.js before this file had exported anything.
module.exports = Object.assign({

    // Handle getting information on a given market
    async getMarketInfo(market_id, block_time){
        // Define response object
        let data = emptyMarketData();
        // Get the time right now and the time 24 hours ago
        let time_now  = block_time,
            time_24hr = this.util.bcsub(time_now, 86400);
        // Set the last time this info was updated to now
        data.last_updated = time_now;
        // A side's tick id as `markets` keys it. orders/order_matches store NULL where
        // the side is the native coin, so every comparison against a markets-side id
        // below has to translate first or it silently matches nothing.
        const sideOf = (tick_id) => Database.marketTickId(tick_id);
        await readMarketRow(this, Database, data, market_id, sideOf);
        await readLastTradePrices(this, data, sideOf);
        await readDayAgoPrices(this, data, time_24hr, sideOf);
        await readBestBids(this, data, sideOf);
        await readBestAsks(this, data, sideOf);
        await readDayStats(this, data, time_24hr, sideOf);
        applyDayChanges(this, data);
        // Sort the market data object 
        data = this.util.ksort(data);
        return data;
    },

}, orderRows, orderInfo, matchRows, crossChainOffers);

// The class these methods install onto, read for its statics. The require sits below
// module.exports so the two files load in either order: whichever runs first, the
// other already sees a finished export by the time a method body runs.
const Database = require('../index.js');
