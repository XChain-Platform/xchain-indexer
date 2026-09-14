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
 * DISPENSE handler part: the THREE PRICING PATHS.
 *
 * Mode B (a user PRICE v1 oracle prices the token), v0 FIAT (the validator
 * COIN/FIAT snapshot prices it), and the non-FIAT path where the dispenser names
 * its own COIN price. Each is the branch body it was in the else-if chain that
 * pricing.js still holds, so which branch runs and in what order the conditions are
 * evaluated is unchanged. Split from pricing.js only because the two together
 * passed the 400-line file limit.
 *
 ********************************************************************/

'use strict';

// Installed onto Dispense.prototype by dispense.js; each method runs with `this`
// bound to the handler, exactly as the inline code it was.
module.exports = {

    // Mode B: a user oracle (PRICE v1) prices the dispensed token directly.
    async priceFromOracle(ctx, row){
    let { data } = ctx;
        let { dispenser, available } = row;
        let error = row.error;

                // User oracle path: combines PEPECASH/JPY (oracle) with BTC/JPY (validator) for cross-conversion
                let priceMatch = await this.util.reverseOraclePriceMatch(
                    available,
                    dispenser['ORACLE_ADDRESS'],
                    dispenser['GIVE_COIN'],
                    dispenser['GIVE_TICK'],
                    dispenser['FIAT'],
                    data['BLOCK_TIME'],
                    this.config['FIAT_DISPENSER_PRICE_WINDOW'],
                    this.indexerDb,
                    // Validator pair is keyed on what the BUYER pays (GET_COIN),
                    // not on the chain of the token being priced (GIVE_COIN above).
                    // Equal today under the same-chain guard; see the note on
                    // reverseOraclePriceMatch.
                    dispenser['GET_COIN']
                );
                if(priceMatch){
                    await this.applyOracleFill(ctx, row, priceMatch);
                } else {
                    error = 'invalid: no matching oracle price';
                }

        row.error = error;
    },

    // The fill count a Mode B match buys, then its unit price.
    async applyOracleFill(ctx, row, priceMatch){
    let { block_index } = ctx;
        let { dispenser } = row;
        let multiplier = row.multiplier;

                    // priceMatch.units is how many TOKENS the payment buys at the oracle's
                    // published price. `multiplier` further down is a FILL count: it is
                    // multiplied by the dispenser's GIVE_AMOUNT to get the tokens credited.
                    // Assigning one to the other equates a token with a fill, so a dispenser
                    // giving N tokens per fill sold each token at 1/N of the published price.
                    // Measured on chain (LTC regtest 2026-07-31, DISPENSE 1956): oracle 1.5
                    // USD per XCHAIN, GIVE_AMOUNT 5, a 0.37 LTC payment worth $11.10 credited
                    // 35 XCHAIN, i.e. 7 fills at $1.50 each and $0.317 a token.
                    //
                    // A PRICE v1 oracle publishes the price of one TOKEN, and that reading is
                    // canonical: the docs, the oracle-fee base (`oracle_price x GIVE_ESCROW`,
                    // which only holds if the fiat cost of one dispense is `oracle_price x
                    // GIVE_AMOUNT`) and the wallet's publishing form all state it, and two of
                    // those are what an oracle operator is paid on. So SETTLEMENT is the side
                    // that moves:
                    // divide the affordable tokens by GIVE_AMOUNT to get whole fills.
                    //
                    // Gated because it is consensus: the same payment against the same
                    // dispenser credits a different number of tokens either side of the
                    // boundary, so an ungated flip forks a heterogeneous fleet on the first
                    // Mode B dispense with GIVE_AMOUNT != 1. Invisible at GIVE_AMOUNT 1,
                    // where fills and tokens coincide, which is why it survived every prior
                    // example and test.
                    //
                    // Divide priceMatch.rawUnits (un-floored) rather than .units so the value
                    // is floored exactly ONCE; see the note on reverseOraclePriceMatch. Fall
                    // back to .units when the matcher did not supply it.
                    //
                    // The giveAmountPositive guard is for a BALANCE dispenser carrying an
                    // empty or '0' GIVE_AMOUNT, which a format-0 create still accepts below
                    // dispenser_give_amount_activation (armed at genesis on mainnet too by
                    // the 2026-09-09 ruling, so this path is legacy-only history now).
                    // bcdiv returns 0 on a zero divisor, so dividing there would silently
                    // reject every such dispense as insufficient funds instead of leaving
                    // the legacy behavior in place.
                    //
                    // An ownership dispenser is NOT that case. `dispenser` reaches this
                    // handler only from getDispenserInfo, which virtualizes GIVE_AMOUNT to
                    // '1' on the GIVE_OWNERSHIP == 1 branch, so giveAmountPositive is always
                    // true for one and this per-token divide DOES run for it.
                    multiplier = priceMatch.units;

        row.multiplier = multiplier;
        await this.applyPerTokenOracleFill(ctx, row, priceMatch);
        await this.priceOracleUnitCost(ctx, row, priceMatch);
    },

    // The per-token reading of a Mode B price: affordable tokens divided by the tokens
    // one fill hands out.
    async applyPerTokenOracleFill(ctx, row, priceMatch){
    let { block_index } = ctx;
        let { dispenser } = row;
        let multiplier = row.multiplier;

                    let perTokenOracle = await this.actions.protocolChanges.isEnabled('DISPENSER_ORACLE_PER_TOKEN_PRICE', block_index);
                    let giveAmountPositive = !this.util.isNull(dispenser['GIVE_AMOUNT']) &&
                                             this.util.bcgt(dispenser['GIVE_AMOUNT'], '0');
                    if(perTokenOracle && giveAmountPositive){
                        let affordable = this.util.isNull(priceMatch.rawUnits)
                            ? String(priceMatch.units)
                            : priceMatch.rawUnits;
                        // Saturating, not throwing: a throw here wedges the block loop, and a
                        // sub-1 GIVE_AMOUNT can lift the fill count above the affordable token
                        // count by orders of magnitude.
                        multiplier = this.util.bcfloorSaturating(
                            this.util.bcdiv(affordable, dispenser['GIVE_AMOUNT'], 64));
                    }

        row.multiplier = multiplier;
        row.perTokenOracle = perTokenOracle;
        row.giveAmountPositive = giveAmountPositive;
    },

    // One fill priced in COIN, out of the affordability the matcher just computed.
    async priceOracleUnitCost(ctx, row, priceMatch){
    let { ledger } = ctx;
        let { dispenser, available, perTokenOracle, giveAmountPositive } = row;
        let unitCoinCost = row.unitCoinCost;

                    // Price one fill in COIN from the affordability this matcher just
                    // computed rather than from a second price lookup, so the two can
                    // never disagree: `available` bought priceMatch.rawUnits tokens, so
                    // one token cost available/rawUnits, and a fill costs that times the
                    // tokens one fill hands out - GIVE_AMOUNT under the per-token rule,
                    // and exactly one token under the legacy reading, where the multiplier
                    // IS a token count priced one token per fill.
                    if(ledger){
                        let rawTokens = this.util.isNull(priceMatch.rawUnits)
                            ? String(priceMatch.units)
                            : priceMatch.rawUnits;
                        let coinPerToken = this.util.bcdiv(available, rawTokens, 64);
                        unitCoinCost = (perTokenOracle && giveAmountPositive)
                            ? this.util.bcmul(coinPerToken, dispenser['GIVE_AMOUNT'], 64)
                            : coinPerToken;
                    }

        row.unitCoinCost = unitCoinCost;
    },

    // v0 FIAT: the validator COIN/FIAT snapshot prices the fill.
    async priceFromValidatorSnapshot(ctx, row){
    let { data, ledger, tallyScale } = ctx;
        let { dispenser, available } = row;
        let multiplier = row.multiplier;
        let unitCoinCost = row.unitCoinCost;
        let error = row.error;

                let coinPair = dispenser['GET_COIN'] + '/' + dispenser['FIAT'];
                let priceMatch = await this.util.reversePriceMatch(
                    available,
                    dispenser['FIAT_AMOUNT'],
                    coinPair,
                    data['BLOCK_TIME'],
                    this.config['FIAT_DISPENSER_PRICE_WINDOW'],
                    this.indexerDb
                );
                if(priceMatch){
                    multiplier = priceMatch.units;
                    // v0 FIAT prices one fill directly: btcPerToken IS the coin cost of a
                    // single unit at the matched snapshot.
                    if(ledger)
                        unitCoinCost = priceMatch.btcPerToken;
                } else {
                    error = 'invalid: no matching price snapshot';
                }

        row.multiplier = multiplier;
        row.unitCoinCost = unitCoinCost;
        row.error = error;
    },

    // Non-FIAT: the dispenser names its own COIN price.
    async priceFromNativeAmount(ctx, row){
    let { ledger, tallyScale } = ctx;
        let { dispenser, available } = row;
        let multiplier = row.multiplier;
        let unitCoinCost = row.unitCoinCost;
        let error = row.error;

                if(this.util.bclt(available, dispenser['GET_AMOUNT']))
                    error = 'invalid: GET_AMOUNT (insufficient funds)';
                // Only work out the fill multiplier once the funds check above has passed
                if(!error){
                    // Saturating, not throwing: this ratio is attacker-chosen on both sides.
                    // GET_AMOUNT is validated only against GET_TICK's DECIMALS, and a tick may
                    // be issued with up to MAX_TOKEN_DECIMALS (18), so a dispenser priced at
                    // 1e-18 triggered by a token SEND of ~0.01 (utility.js processDispenserSends
                    // puts the SEND's own amount in COIN_AMOUNT) drives available/GET_AMOUNT past
                    // 2^53-1. A throw here fires BEFORE any status is recorded, escapes parse()
                    // into the block loop, and that loop rolls back and retries the same block
                    // forever - every indexer on the chain wedged for the price of two
                    // transactions. Saturating needs no activation gate: the two helpers agree on
                    // every input that does not overflow, and the behavior it replaces on the
                    // inputs that do is "no node commits this block at all", so no committed
                    // history can contain one. The GIVE_REMAINING clamp below bounds the
                    // saturated count to the dispenser's real capacity.
                    // Reject a GET_AMOUNT bcdiv cannot divide by, which a native-coin create
                    // accepted unchecked (dispenser_amount_positivity_activation.js).
                    // Catch, not pre-screen: throw-exact by construction, so it changes only
                    // the inputs that wedge the block loop, and ungated for the same reason
                    // as bcfloorSaturating above. An isNumeric() screen is NOT equivalent (it
                    // rejects 'Infinity'/'NaN', which divide to 0 and settle today).
                    let priced = null;
                    try {
                        priced = this.util.bcdiv(available, dispenser['GET_AMOUNT'], 64);
                    } catch(e){
                        error = 'invalid: GET_AMOUNT (format)';
                    }
                    if(!error){
                        multiplier = this.util.bcfloorSaturating(priced);
                        // Non-FIAT prices a fill directly in coin: GET_AMOUNT per fill.
                        if(ledger)
                            unitCoinCost = dispenser['GET_AMOUNT'];
                    }
                }

        row.multiplier = multiplier;
        row.unitCoinCost = unitCoinCost;
        row.error = error;
    },

};

