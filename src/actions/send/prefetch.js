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
 * XChain Platform Action - SEND: prefetch
 *
 * The reads a SEND makes once per action rather than once per leg:
 * token info, preferences, gated packs, destination balances and the
 * SOURCE-side context every leg shares.
 *
 ********************************************************************/

// Installed onto Send.prototype by index.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Token info, address preferences and gated packs for every distinct key the legs name,
    // read once per key. Returns { ticks, preferences, gatedPacks }.
    async prefetchSendContext(sends, data){
        // Get token data for every TICK (reduces duplicated sql queries)
        let ticks = {};
        for(let send of sends){
            let tick = send[0];
            if(ticks[tick] === undefined)
                ticks[tick] = await this.indexerDb.getTokenInfo(tick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }

        // Get address preferences for all destination addresses (used in MEMO requirement check)
        let preferences = {};
        for(let send of sends){
            let destination = send[2];
            if(!preferences[destination])
                preferences[destination] = await this.indexerDb.getAddressPreferences(destination, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }

        // Get active gated key hashes for every TICK (reduces duplicated sql queries).
        // The gate is a property of the TICK, not of the leg, so an N-recipient SEND
        // needs O(distinct ticks) queries, not one per leg. Same dedupe pattern as
        // `ticks` and `preferences` above; SEND runs on every ~5s index tick, so the
        // per-leg form scaled per-block DB work with recipient count.
        let gatedPacks = {};
        for(let send of sends){
            let tick = send[0];
            if(gatedPacks[tick] === undefined)
                gatedPacks[tick] = await this.indexerDb.getGatedPackThresholds(tick);
        }

        return { ticks, preferences, gatedPacks };
    },

    // Gated-file handoff rule: the destination's PRE-SEND balance, snapshotted once here,
    // before any leg of this action settles. Scoping by (BLOCK_INDEX, ACTION_INDEX)
    // is what makes the snapshot base right: it includes every preceding
    // transaction in the block AND every preceding action in this transaction, so
    // two SEND actions of the same tick in one transaction COMPOUND rather than
    // both reading the pre-transaction balance. Validating against pre-tx state
    // would reopen the split-the-amount bypass one level up.
    //
    // Only fetched when the tick actually has gated packs: an ungated SEND must not
    // pay for a destination-balance read on every leg.
    async loadDestinationBalances(sends, gatedPacks, data){
        let destBalances = {};
        for(let send of sends){
            let [tick, , destination] = send;
            if((gatedPacks[tick] || []).length === 0) continue;
            if(destBalances[destination] !== undefined) continue;
            destBalances[destination] = await this.indexerDb.getAddressBalances(
                destination, null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        }
        return destBalances;
    },

    // The SOURCE-side context every leg shares: its balances, the GAS token and its GAS balance,
    // its sleeping state, and the per-tick memo tables the leg checks fill in as they go.
    async loadSourceContext(data){
        // Get source address balances
        let balances = await this.indexerDb.getAddressBalances(data['SOURCE'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // Controller-bound token gas context. A SEND of a token whose `transfer` class is bound to
        // a controller runs that contract's `guard` before settling; the SOURCE pays the (bounded)
        // guard gas. Load the SOURCE's GAS balance once so a multi-send debits it cumulatively
        // across controlled legs (maybeRunControllerGuard reserves the ceiling against it).
        let gasTick      = this.config['GAS'];
        let gasInfo      = await this.indexerDb.getTokenInfo(gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
        let gasBalances  = await this.indexerDb.getAddressBalances(data['SOURCE'], gasTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);

        // SOURCE sleeping-state check is byte-identical for every leg (same SOURCE, same
        // BLOCK_INDEX, tick arg null), so run it once here instead of once per leg. Read-only,
        // so hoisting it out of the loop does not change any leg's validation outcome; each leg
        // still gates on it under its own !error guard below. Same motive as the ticks/
        // preferences/gatedKeyHashes dedupe above: SEND runs on every ~5s index tick and the
        // per-leg form scaled per-block DB work with recipient count.
        let sourceActionAllowed = await this.indexerDb.isActionAllowed(data['SOURCE'], null, data['BLOCK_INDEX']);

        // Memoize the TICK sleeping-state check per distinct tick. The check depends only on
        // (TICK, BLOCK_INDEX); BLOCK_INDEX is fixed for the tx, so a repeated tick reuses the
        // first result. A multi-send of the same tick to N recipients now costs one query, not N.
        let tickActionAllowed = {};

        // Memoize the SOURCE-side allow/block-list check per distinct tick, same motive.
        // It depends only on (SOURCE, TICK): SOURCE is fixed for the whole action (send is
        // an alias of data and only TICK/AMOUNT/DESTINATION are re-set per leg), and the
        // call passes no block_index, so the answer cannot change across legs of one tick.
        // Each miss costs a getTokenInfo plus up to two getList reads, so a Multi-Send
        // (Brief) to N recipients was paying up to 3N round-trips for one answer.
        let sourceTickAllowed = {};

        return { balances, gasTick, gasInfo, gasBalances, sourceActionAllowed, tickActionAllowed, sourceTickAllowed };
    }
};
