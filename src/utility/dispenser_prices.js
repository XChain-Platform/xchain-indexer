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
 * XChain Indexer - Utility: dispenser settlement and price matching
 *
 * The dispenser settled-state test, the reverse price matches that turn a coin payment into
 * token units (user oracle and FIAT), and the SEND-to-dispenser trigger.
 *
 ********************************************************************/

'use strict';

// Installed onto Utility.prototype by ../utility.js, non-enumerable; each method runs with
// `this` bound to the Utility instance, exactly as the class method it was.
module.exports = {

    // True when a dispenser's LATEST lifecycle status says a settlement already ran.
    //
    // Guards the escrow refund in dispenser_close.js / dispenser_expire.js. GIVE_REMAINING is
    // DERIVED (give_escrow + edits - valid dispenses) and a close/expire writes no row that
    // reduces it, so a second settlement of the same dispenser recomputes the identical non-zero
    // remaining and refunds it AGAIN: the recipient is double-credited and the global escrow sum
    // goes negative, tripping the supply SanityError in updateAddressBalances and crash-looping
    // the indexer. No caller reaches that today (getExpiredItems filters 'open',
    // findCancelledDispensers filters 'cancelling'), so this changes no live path; it moves the
    // once-only invariant from the callers into the code that actually moves escrow, next to the
    // ownership branch's getTokenEscrow===ACTION_INDEX guard.
    //
    // Stated as terminal states rather than as the live set ('open','cancelling', the pair
    // findMatchingDispensers uses): a status this list has not heard of must still be REFUNDED,
    // because skipping a legitimate first refund strands a user's escrow and forks the chain,
    // while missing a novel terminal state only leaves today's latent hazard in place. Any new
    // status a settlement handler writes belongs here; dispenser_settlement_idempotency.test.js
    // pins the four that exist, and ONLY those four belong here. A status no handler writes
    // buys nothing and points the guard the wrong way: it can only ever suppress a legitimate
    // first refund. 'closed' was such an entry (never written to dispenser_statuses by any
    // version; the tree's other 'closed' rows are order and BET-feed statuses) and is gone.
    isDispenserSettled(status){
        return ['cancelled', 'empty', 'expired', 'max_dispenses_reached'].includes(String(status));
    },

    // Reverse price match for user TOKEN/FIAT oracles (PRICE v1)
    // Given a coin payment amount and a user oracle reference, find the most recent oracle
    // price within the window where the buyer can afford at least 1 token unit.
    //
    // The conversion uses BOTH a user oracle (TOKEN/FIAT) and a validator oracle (COIN/FIAT)
    // for the same FIAT currency:
    //   tokens_per_coin = (coin_amount × coin_fiat_price) / token_fiat_price
    //
    // Example: dispenser sells PEPECASH for BTC, denominated in JPY
    //   user oracle:      1 PEPECASH = ¥7.50
    //   validator oracle: 1 BTC      = ¥15,000,000
    //   payment:          0.001 BTC
    //   tokens = (0.001 × 15000000) / 7.50 = 2000 PEPECASH
    //
    // Returns { units, oraclePrice, coinFiatPrice } or null if no match found.
    // `coin` and `payCoin` are two DIFFERENT things and must not be conflated:
    //   coin    - which chain's token the oracle prices, i.e. the dispenser's
    //             GIVE_COIN. Selects the oracle_prices row.
    //   payCoin - the coin the BUYER actually pays in, i.e. the dispenser's
    //             GET_COIN. Selects the validator COIN/FIAT pair below.
    // They are equal on every dispenser that can exist today, because
    // actions/dispenser.js guards BOTH GIVE_COIN and GET_COIN to the indexer's
    // own chain (lines 146-153), so passing one for the other was inert. It was
    // still a trap: cross-chain dispensers are only shelved, not refused forever
    // (shelved behind a fiat-oracle decision of its own), and the day
    // GIVE_COIN != GET_COIN becomes possible, a single `coin` argument would
    // silently price the payment against the wrong validator pair. Mode A already
    // builds its pair from GET_COIN; this makes Mode B agree.
    // payCoin falls back to coin so the argument stays optional for callers that
    // genuinely have only one.
    async reverseOraclePriceMatch(coinAmount, oracleAddress, coin, tick, fiat, blockTime, priceWindow, db, payCoin){
        let priceDb = (db.indexer && db.indexer.hubDb) ? db.indexer.hubDb : db;
        let startTime = blockTime - priceWindow;

        // Walk historical user oracle prices newest-first within the window
        let oraclePrices = await priceDb.getOraclePricesInTimeRange(oracleAddress, coin, tick, fiat, startTime, blockTime);
        if(!oraclePrices || oraclePrices.length === 0) return null;

        // Fetch the validator's COIN/FIAT prices ONCE, then pair each oracle row in memory.
        //
        // One batched read, not one per oracle row: the oracle publisher decides how many PRICE v1
        // rows land inside the window (each a cheap wallet broadcast), so a per-row query let a
        // counterparty scale the DB round-trips this settlement path costs on every later DISPENSE.
        //
        // The batched window is [startTime - priceWindow, blockTime] because each oracle row's own
        // lower bound reaches priceWindow behind its effective_at, and the OLDEST row this loop can
        // see sits at startTime. Consensus-equivalence: the per-row result was this same query
        // narrowed to [effectiveAt - priceWindow, effectiveAt], i.e. an order-preserving subsequence
        // of the batched result, so the first batched row inside those bounds IS the row the per-row
        // query returned at [0]. That holds whatever order the query returns and does not re-derive
        // "newest", so it cannot fork on an ordering assumption.
        let coinPair = (this.isNull(payCoin) ? coin : payCoin) + '/' + fiat;
        let validatorPrices = await priceDb.getPricesInTimeRange(coinPair, startTime - priceWindow, blockTime);
        if(!validatorPrices || validatorPrices.length === 0) return null;
        for(let op of oraclePrices){
            // Keep the per-row LOWER bound: a validator price older than effectiveAt - priceWindow
            // is inside the batched fetch but was never eligible, and settling on it would price the
            // dispense at a stale rate.
            let match = validatorPrices.find(p => p.timestamp <= op.effectiveAt && p.timestamp >= op.effectiveAt - priceWindow);
            if(!match) continue;
            let coinFiatPrice = match.price;

            // Compute: tokens = (coin_amount × coin_fiat_price) / token_fiat_price
            let coinFiatTotal = this.bcmul(coinAmount, coinFiatPrice, 18);
            let rawTokens     = this.bcdiv(coinFiatTotal, op.price, 64);
            // Saturating, not throwing: a throw here wedges the block loop.
            let units         = this.bcfloorSaturating(rawTokens);
            if(units >= 1){
                return {
                    units:         units,
                    // The SAME affordability, un-floored. `units` is whole tokens, which is
                    // the right granularity for a caller that hands out one token at a time,
                    // but the per-token settlement rule
                    // (DISPENSER_ORACLE_PER_TOKEN_PRICE in actions/dispense.js) divides this
                    // by GIVE_AMOUNT to get a FILL count, and flooring to whole tokens first
                    // silently under-credits whenever GIVE_AMOUNT is below 1: a buyer who can
                    // afford 1.75 tokens of a dispenser giving 0.5 per fill is owed 3 fills,
                    // and floor(floor(1.75)/0.5) is 2. Dividing the raw value and flooring
                    // ONCE is the only rounding the rule intends. Rendered through bcstr, so
                    // it is the exact plain-decimal string the division produced and never a
                    // JS number (and never String()'s exponential form).
                    rawUnits:      this.bcstr(rawTokens),
                    oraclePrice:   op,
                    coinFiatPrice: coinFiatPrice
                };
            }
        }
        return null;
    },

    // Reverse price match for FIAT dispensers
    // Given a coin payment amount, find the most recent price snapshot where the buyer can afford at least 1 unit
    // Returns { units, snapshot } or null if no match found
    // Prefers the local hub DB (where price_snapshots is synced from xchain-hub) when available.
    async reversePriceMatch(coinAmount, fiatAmount, coinPair, blockTime, priceWindow, db){
        let startTime = blockTime - priceWindow;
        let priceDb = (db.indexer && db.indexer.hubDb) ? db.indexer.hubDb : db;
        let snapshots = await priceDb.getPricesInTimeRange(coinPair, startTime, blockTime);
        for(let snapshot of snapshots){
            // Calculate BTC cost per token unit at this snapshot's price
            // btc_per_token = fiat_amount / snapshot.price
            let btcPerToken = this.bcdiv(fiatAmount, snapshot.price, 18);
            // Calculate how many units the buyer's coin amount covers
            // raw_multiplier = coin_amount / btc_per_token
            let rawMultiplier = this.bcdiv(coinAmount, btcPerToken, 64);
            // Saturating, not throwing: a throw here wedges the block loop.
            let units = this.bcfloorSaturating(rawMultiplier);
            if(units >= 1){
                return {
                    units:        units,
                    snapshot:     snapshot,
                    btcPerToken:  btcPerToken
                };
            }
        }
        return null;
    },

    // Handle checking if any sends were to an active dispenser address
    //
    // VALUE SCOPE (BATCH_ISSUANCE_LIMITS, spec row 20). Each DISPENSE below is settled
    // against send.amount, the tokens THAT send moved, and each SEND debits the source
    // separately. That stays true when a BATCH emits several SENDs: two batched SENDs are
    // two independent debits, not two claims on one value, so they are the one shape the
    // batch-cumulative rule must NOT collapse.
    //
    // So info['BATCH_VALUE_LEDGER'] is deliberately NOT threaded onto the object below,
    // and the strip makes that hold by construction rather than by the accident of the
    // object being built field by field (a later refactor to a spread/Object.assign of
    // `info` would otherwise inherit it silently). Threading it would be a units error as
    // well as a scope error: that tally counts the TRANSACTION's coin settlement value,
    // drawn down by COINPAY and by coin-paid DISPENSE, while these dispenses are priced
    // in the SEND's token.
    //
    // The one-value-N-settlements property still holds here, and by construction, not by
    // luck: with the key absent, actions/dispense.js opens its own transaction-scoped
    // tally over this send.amount whenever the flag is active, so several dispensers
    // behind one paid address can no longer each buy a full multiplier off the same SEND.
    // A future batched SEND therefore cannot reintroduce the defect: it would arrive here
    // exactly as an ordinary SEND does, and be tallied the same way.
    async processDispenserSends(actions, db, info){
        // BLOCK_INDEX is the block context the affordability flag-day is keyed on
        // (dispenser_send_amount_compare_activation.js); without it the query stays
        // on the legacy string compare.
        let sends = await db.findDispenserSends(info['ACTION_INDEX'], info['BLOCK_INDEX']);
        for(let send of sends){
            // Define basic DISPENSE transaction data object
            let action = 'DISPENSE';
            let data = {};
            data['ACTION']           = action;
            data['SOURCE']           = send.source;
            data['COIN']             = send.coin;
            data['COIN_TICK']        = send.tick
            data['COIN_AMOUNT']      = send.amount;
            data['COIN_DESTINATION'] = send.destination;
            data['BLOCK_INDEX']      = info['BLOCK_INDEX'];
            data['BLOCK_TIME']       = info['BLOCK_TIME'];
            data['TX_INDEX']         = info['TX_INDEX'];
            data['DISPENSE_TYPE']    = 'SEND';
            // See the VALUE SCOPE note above: a SEND-triggered dispense never inherits the
            // enclosing batch's value tally. A no-op on the object as built today.
            delete data['BATCH_VALUE_LEDGER'];
            await actions.processAction(action, null, data, null);
        }
    }
};
