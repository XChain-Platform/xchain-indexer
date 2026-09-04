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
 * XChain Platform Action - DISPENSE
 * 
 * This action dispenses tokens from dispensers when they are triggered
  *
 ********************************************************************/

const divergenceMetrics = require('../dispenserDivergenceMetrics.js');
const dispenserCaps = require('../dispenser_caps_activation.js');
const dispenserAmountPositivity = require('../dispenser_amount_positivity_activation.js');

class Dispense {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
    }

    async parse(params, data, error){

        // Save some details from the dispense request
        let block_index = data['BLOCK_INDEX'];
        let block_time  = data['BLOCK_TIME'];
        let tx_index    = data['TX_INDEX'];

        // Placeholder for valid dispenses
        let dispenses  = [];

        // Placeholder for dispenser info
        let dispenserInfo = {}; 

        // Lookup any dispensers that are triggered by this action
        let action_indexes = await this.indexerDb.findMatchingDispensers(data);

        // If we found no valid dispensers, delete the action_index that we created for this DISPENSE
        if(action_indexes.length==0){
            await this.indexerDb.deleteActionIndex(data['ACTION_INDEX']);

            // Observability: a DISPENSE trigger that matches no open dispenser is dropped.
            // When the paid address DID have a dispenser that is now cancelled or expired,
            // this is the upstream decoder still proposing DISPENSE for a dispenser the
            // indexer already closed/re-dated. Tag the reason and count it so the volume of
            // this split can be sized from logs. Measurement only - the drop above is
            // unchanged; this adds no accept/reject behavior.
            let closed = await this.indexerDb.getClosedDispenserAtAddress(data['COIN'], data['COIN_DESTINATION']);
            if(closed)
                divergenceMetrics.recordRejectedDispense(data['COIN'], block_index, data['COIN_DESTINATION'], closed['ACTION_INDEX'], closed['REASON']);
        }

        // Batch-cumulative settlement-value accounting (BATCH_ISSUANCE_LIMITS).
        //
        // COIN_AMOUNT is TRANSACTION-level state that the batch loop preserves across
        // every sub-command, and nothing decrements it. So before this, each DISPENSE
        // sub-command re-ran against the SAME untouched payment from zero and bought a
        // full multiplier off it: N sub-commands spent one payment N times. batch.js seeds
        // data['BATCH_VALUE_LEDGER'] (only when the flag is active, and only before its
        // baseKeys snapshot so the per-command field clear preserves it), and the tally is
        // shared with COINPAY: both consume the same transaction settlement value.
        //
        // The key's PRESENCE is what says "I am inside a batch" to every reader; its
        // absence is the not-a-batch case.
        //
        // data['FEE_PROBE'] marks the read-only dry-run surfaces; a probe must neither
        // read nor write the ledger.
        let ledger = (!data['FEE_PROBE'] && data['BATCH_VALUE_LEDGER'] && typeof data['BATCH_VALUE_LEDGER'] === 'object')
                        ? data['BATCH_VALUE_LEDGER'] : null;

        // The SAME one-payment-N-settlements shape exists OUTSIDE a batch, and the batch
        // ledger cannot close it because the key is absent there (spec row 19).
        //
        // findMatchingDispensers returns EVERY open dispenser sitting behind the paid
        // address, and the loop below runs once per dispenser. Nothing decremented the
        // payment between iterations, so each dispenser priced itself against the same
        // untouched COIN_AMOUNT and bought a full multiplier off it: one payment, N
        // settlements, in an ordinary single-command transaction. Anyone may open a second
        // dispenser at an address they control, so this is reachable without a batch.
        //
        // This is a CONSENSUS TIGHTENING on the ordinary path, so it activates with this
        // spec's flag (operator decision 2026-08-13: ship it here rather than mint a
        // second flag). Below the flag no tally exists, `available` IS data['COIN_AMOUNT']
        // on every iteration, and the defect replays byte for byte.
        //
        // A LOCAL object, deliberately never written to data['BATCH_VALUE_LEDGER']: that
        // key's presence means "inside a batch" to batch.js, coinpay.js and
        // validateOracleFee, so fabricating one on non-batch data would tell three other
        // readers something untrue. Same field name and same semantics as the batch
        // ledger's coinAmountConsumed, so the drain below is one code path for both; the
        // only difference is the SCOPE it tallies over (this transaction's dispense, not
        // the whole batch). Only coinAmountConsumed is carried, because this handler
        // consumes no native fee and pays no oracle fee.
        //
        // Scoped to this parse() call, which for a non-batch transaction IS the
        // transaction: a fresh DISPENSE action gets a fresh tally, so nothing leaks
        // between transactions or between blocks.
        //
        // A FEE_PROBE gets no tally at all, matching the batch path: the quote surfaces
        // must keep reading the un-drained payment.
        //
        // This also covers the SEND-triggered dispense path
        // (util.processDispenserSends), which builds its own data object carrying the
        // SEND's own amount and deliberately no batch ledger: it lands here with the key
        // absent and gets a tally scoped to that one SEND's value, which is exactly the
        // value its dispensers may spend. See the note at processDispenserSends.
        if(!ledger && !data['FEE_PROBE'] && this.util.isNull(data['BATCH_VALUE_LEDGER']) && action_indexes.length > 0){
            let batchIssuanceLimits = await this.actions.protocolChanges.isEnabled('BATCH_ISSUANCE_LIMITS', block_index);
            if(batchIssuanceLimits)
                ledger = { coinAmountConsumed: '0' };
        }

        // Loop through dispensers and generate a list of valid DISPENSE actions
        // Note: Dispense transactions which do not match an valid dispenser are ignored
        for(let action_index of action_indexes){

            // Reset the error to false for each dispenser
            let error = false;

            // Get full dispenser info including GIVE_REMAINING
            let dispenser = await this.indexerDb.getDispenserInfo(this.config['COIN'], action_index, data['BLOCK_TIME']);

            // Unknown dispenser: no dispenserInfo entry exists to settle against, so
            // skip this action_index entirely rather than pushing a dispense record
            // that references a missing dispenser (no settlement occurs). This replaced
            // a sentinel-string round-trip through `error` with two provably-dead !error
            // branches; `error` is false here, so behavior is unchanged.
            if(!dispenser)
                continue;

            // Store the dispenser info for easy reference
            dispenserInfo[dispenser['ACTION_INDEX']] = dispenser;

            // What is left of the payment for THIS dispenser, re-read every iteration so
            // an earlier dispenser in this same loop (several dispensers can sit behind
            // one paid address) sees its spend reflected too. Every pricing path below
            // reads `available`, never the raw payment.
            let available = ledger ? this.util.bcsub(data['COIN_AMOUNT'], ledger['coinAmountConsumed'], 8) : data['COIN_AMOUNT'];

            // Coin cost of ONE fill on whichever pricing path runs, filled in by that path
            // and used only to drain the pool at the end of this iteration. Left null when
            // no ledger is in play (nothing to drain) or when no path priced a fill.
            let unitCoinCost = null;

            // What this dispense was actually charged, written by the drain below and
            // recorded as the row's GET_AMOUNT. Null means nothing was attributed (no
            // tally in play, or this dispense settled nothing), and the row keeps the
            // legacy whole-payment figure.
            let attributedCost = null;

            // FIAT dispenser: reverse price match to determine effective GET_AMOUNT
            // Two pricing modes:
            //   - With ORACLE_ADDRESS: use a user oracle (PRICE v1) for TOKEN/FIAT pricing.
            //     The oracle prices the dispensed token directly; FIAT_AMOUNT is ignored.
            //   - Without ORACLE_ADDRESS: use the validator COIN/FIAT snapshot (PRICE v0).
            //     FIAT_AMOUNT defines how much of the FIAT currency 1 GIVE unit costs.
            //
            // FIAT_DISPENSER_PRICING gate (protocol_changes.js). Genesis-active on every
            // network today, so this reads true in production and the reverse-match paths
            // below behave exactly as before. It exists so the settlement path appears in
            // the activation inventory alongside every sibling dispenser rule, and so a
            // future correction to the matching algorithm has a height to hang off. Below
            // activation a FIAT dispenser cannot settle: rejecting is the only well-defined
            // "off" state, because the pre-FIAT code would have divided by the GET_AMOUNT
            // of 0 that FIAT dispensers carry by convention.
            let multiplier = 0;
            let fiatPricingActive = this.util.isNull(dispenser['FIAT'])
                ? true
                : await this.actions.protocolChanges.isEnabled('FIAT_DISPENSER_PRICING', block_index);
            if(!error && !this.util.isNull(dispenser['FIAT']) && !fiatPricingActive){
                error = 'invalid: FIAT dispenser pricing not active';
            } else if(!error && !this.util.isNull(dispenser['FIAT']) && !this.util.isNull(dispenser['ORACLE_ADDRESS'])){
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
                    // dispenser_give_amount_activation (mainnet still on the UNARMED
                    // sentinel). bcdiv returns 0 on a zero divisor, so dividing there would
                    // silently reject every such dispense as insufficient funds instead of
                    // leaving the legacy behavior in place.
                    //
                    // An ownership dispenser is NOT that case. `dispenser` reaches this
                    // handler only from getDispenserInfo, which virtualizes GIVE_AMOUNT to
                    // '1' on the GIVE_OWNERSHIP == 1 branch, so giveAmountPositive is always
                    // true for one and this per-token divide DOES run for it.
                    multiplier = priceMatch.units;
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
                } else {
                    error = 'invalid: no matching oracle price';
                }
            } else if(!error && !this.util.isNull(dispenser['FIAT'])){
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
            }

            // Non-FIAT dispenser: verify COIN_AMOUNT >= GET_AMOUNT and calculate multiplier
            if(!error && this.util.isNull(dispenser['FIAT'])){
                if(this.util.bclt(available, dispenser['GET_AMOUNT']))
                    error = 'invalid: GET_AMOUNT (insufficient funds)';
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
            }

            // Ignore if DISPENSE is being triggered by GET_ADDRESS (dispenser can't trigger itself)
            if(!error && data['SOURCE']==dispenser['GET_ADDRESS'])
                error = 'invalid: SOURCE and GET_ADDRESS can not be same';

            // Ownership dispensers are single-shot: cap multiplier at 1 regardless of overpayment
            // (extra coin is absorbed as a tip, matching the existing overpayment behavior).
            let isOwnershipDispenser = (Number(dispenser['GIVE_OWNERSHIP']||0) == 1);
            if(isOwnershipDispenser && multiplier > 1)
                multiplier = 1;

            // Give out the maximum amount allowed by the dispenser and payment amount:
            // clamp the multiplier to what the dispenser can actually still give.
            //
            // This replaces a decrement loop (multiplier--, with a bignumber multiply
            // per iteration) that was O(multiplier). On a FIAT dispenser the multiplier
            // scales with an externally-chosen price rather than with GET_AMOUNT, so it
            // can be many orders of magnitude larger: a payment worth ~1e7 units against
            // a nearly-empty dispenser spun ten million bignumber multiplies inside one
            // block and could blow BLOCK_PROCESS_TIMEOUT.
            //
            // Identical by construction, not merely equivalent: the loop stopped at the
            // largest m <= multiplier with m * GIVE_AMOUNT <= GIVE_REMAINING, and that is
            // exactly min(multiplier, floor(GIVE_REMAINING / GIVE_AMOUNT)).
            //
            // Two guards keep the rewrite byte-identical on the edges:
            //   - GIVE_AMOUNT is empty or '0' on a BALANCE dispenser created below
            //     dispenser_give_amount_activation (mainnet still on the UNARMED
            //     sentinel), where bcmul() coerced it to 0 so `0 > GIVE_REMAINING` was
            //     false and the loop never ran. Skip the clamp there rather than
            //     dividing by zero. An ownership dispenser is NOT that case and must
            //     not be bypassed here: getDispenserInfo virtualizes its GIVE_AMOUNT to
            //     '1' and its GIVE_REMAINING to '1' before a dispense / '0' once one is
            //     recorded, so this clamp DOES run for it and is the second line of
            //     defense on the single-shot rule - with GIVE_REMAINING '0' it drives
            //     multiplier to 0 and the check below refuses with 'invalid:
            //     insufficient funds ', even if the cap above and the DISPENSER_CLOSE
            //     auto-close both failed to fire.
            //   - capacity is only computed when the overspill test says the multiplier
            //     does NOT fit, which means capacity < multiplier, and multiplier is
            //     already a safe JS integer. So this bcfloor can never be the one that
            //     overflows.
            let giveAmountIsPositive = !this.util.isNull(dispenser['GIVE_AMOUNT']) &&
                                       this.util.bcgt(dispenser['GIVE_AMOUNT'], '0');
            let give_amount = this.util.bcmul(multiplier, dispenser['GIVE_AMOUNT'], 64);
            if(multiplier > 0 && giveAmountIsPositive &&
               this.util.bcgt(give_amount, dispenser['GIVE_REMAINING'])){
                multiplier  = this.util.bcfloor(
                    this.util.bcdiv(dispenser['GIVE_REMAINING'], dispenser['GIVE_AMOUNT'], 64));
                give_amount = this.util.bcmul(multiplier, dispenser['GIVE_AMOUNT'], 64);
            }

            // Verify at least one unit can be dispensed (multiplier > 0). The legacy
            // reading tests equality, so a NEGATIVE count settles valid having skipped every
            // downstream guard, and the GIVE_REMAINING recompute then subtracts a negative
            // (dispenser_amount_positivity_activation.js carries the chain and the gating
            // argument). Guard the fill COUNT, not a price field: three producers feed it.
            let rejectNonPositiveFill = dispenserAmountPositivity.isDispenserAmountPositivityActive(block_time, this.config['NETWORK']);
            if(!error && (rejectNonPositiveFill ? !this.util.bcgt(multiplier, '0') : multiplier == 0))
                error = 'invalid: insufficient funds ';

            // Only create dispensee if we are able to dispense at least 1 GIVE_AMOUNT
            if(!error){

                // Get information on the tokens involved in the dispense
                let getTokenInfo  = await this.indexerDb.getTokenInfo(dispenser['GET_TICK'],  data['BLOCK_INDEX'], data['ACTION_INDEX']);
                let giveTokenInfo = await this.indexerDb.getTokenInfo(dispenser['GIVE_TICK'], data['BLOCK_INDEX'], data['ACTION_INDEX']);

                // List of addresses allowed or blocked from holding GET_TICK
                let getTokenAllowList = (getTokenInfo && !this.util.isNull(getTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(getTokenInfo['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
                let getTokenBlockList = (getTokenInfo && !this.util.isNull(getTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(getTokenInfo['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

                // List of addresses allowed or blocked from holding GIVE_TICK
                let giveTokenAllowList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['ALLOW_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
                let giveTokenBlockList = (giveTokenInfo && !this.util.isNull(giveTokenInfo['BLOCK_LIST'])) ? await this.indexerDb.getList(giveTokenInfo['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

                // List of addresses allowed or blocked from matching with this ORDER
                let dispenserAllowList = (!this.util.isNull(dispenser['ALLOW_LIST'])) ? await this.indexerDb.getList(dispenser['ALLOW_LIST'], data['BLOCK_INDEX']) : [];
                let dispenserBlockList = (!this.util.isNull(dispenser['BLOCK_LIST'])) ? await this.indexerDb.getList(dispenser['BLOCK_LIST'], data['BLOCK_INDEX']) : [];

                // Handle validating both sides of dispense are allowed (ALLOW/BLOCK list support)
                if(!error){
                    // Get Token Allow List
                    if(getTokenAllowList.length){
                        if(!error && !getTokenAllowList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GET_TOKEN allow list)';
                        if(!error && !getTokenAllowList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GET_TOKEN allow list)';
                    }
                    // Get Token Block List
                    if(getTokenBlockList.length){
                        if(!error && getTokenBlockList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GET_TOKEN block list)';
                        if(!error && getTokenBlockList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GET_TOKEN block list)';
                    }
                    // Give Token Allow List
                    if(giveTokenAllowList.length){
                        if(!error && !giveTokenAllowList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GIVE_TOKEN allow list)';
                        if(!error && !giveTokenAllowList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GIVE_TOKEN allow list)';
                    }
                    // Give Token Block List
                    if(giveTokenBlockList.length){
                        if(!error && giveTokenBlockList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GIVE_TOKEN block list)';
                        if(!error && giveTokenBlockList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GIVE_TOKEN block list)';
                    }
                    // Dispenser Allow List
                    if(dispenserAllowList.length){
                        if(!error && !dispenserAllowList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (dispenser allow list)';
                        if(!error && !dispenserAllowList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (dispenser allow list)';
                    }
                    // Dispenser Block List
                    if(dispenserBlockList.length){
                        if(!error && dispenserBlockList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (DISPENSER block list)';
                        if(!error && dispenserBlockList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (DISPENSER block list)';
                    }
                }
            }

            // Draw what THIS dispense was actually priced at out of the batch pool. Placed
            // here, at the end of the iteration, because every rejection above (allow and
            // block lists included) lands in `error` first, and a dispense that never
            // settles must consume nothing - the same rule the native-fee pool follows.
            // The second loop below derives its status from this same `error`, so "!error
            // here" and "valid there" are the same set.
            //
            // Cost is the FINAL multiplier (post ownership cap and post GIVE_REMAINING
            // clamp) times one fill's coin price, so a dispense clamped to what the
            // dispenser can still give consumes only what it bought. Overpayment above the
            // last whole fill stays in the pool: it is a tip today, it was paid to the
            // triggered address, and leaving it available lets a sibling command against
            // another dispenser at that same address draw on it exactly as it can today.
            //
            // Draining per fill (not the whole payment) is what makes N fills' worth of
            // payment cover exactly N fills, whichever pricing path priced them. The clamp
            // to `available` is a rounding guard only: bcmul rounds at 8dp, and the pool
            // must never go negative. Ledger values stay decimal STRINGS at 8dp.
            //
            // isNull rather than !== null on unitCoinCost: an undefined price would
            // multiply out to a silent zero, which now also lands in the row's GET_AMOUNT
            // and would read as "this dispense was free". Unreachable in production (all
            // three pricing paths set it before a dispense can be valid); the strict form
            // keeps it that way.
            if(ledger && !error && !this.util.isNull(unitCoinCost) && multiplier > 0){
                let cost = this.util.bcmul(multiplier, unitCoinCost, 8);
                if(this.util.bclt(available, cost))
                    cost = available;
                // Row 18: the row records what this dispense was CHARGED, not the whole
                // payment. Taken from the same `cost` the pool is drained by, on purpose:
                // the record and the accounting are one number, so they can never
                // disagree. Under the old shape three batched sub-commands each wrote the
                // full payment into their own row while consuming a third of it, and the
                // multi-dispenser loop did the same outside a batch.
                attributedCost = this.util.bcformat(cost, 8);
                ledger['coinAmountConsumed'] = this.util.bcformat(
                    this.util.bcadd(ledger['coinAmountConsumed'], cost, 8), 8);
            }

            // Add the dispense info to the dispenses array;
            //
            // GET_AMOUNT is the attributed cost when a tally priced this dispense, and
            // otherwise the whole payment exactly as before. That makes the flag the gate
            // for the record shape too: below it, or on a dispense that settled nothing,
            // nothing is attributed and the legacy figure stands. The column is not a hash
            // preimage anywhere (tableLifecycle.js classes `dispenses` as a derived
            // projection, and getBlockHashes covers credits/debits/escrows/actions/
            // contracts only), so this is a record correction rather than a consensus
            // change. It is gated regardless: replicas mirror these rows verbatim and no
            // hash would catch a fleet writing two different values, and get_amount is the
            // coin leg of the XCHAIN/BTC price derivation over realized dispense fills
            // (xchainPriceQuery.js DISPENSE_FILLS_SQL), which is built to feed native fee
            // bands. An ungated record change is a silent divergence there.
            dispenses.push({
                DISPENSER_ACTION_INDEX: action_index,
                GIVE_COIN:              dispenser['GIVE_COIN'],
                GIVE_TICK:              dispenser['GIVE_TICK'],
                GIVE_AMOUNT:            give_amount,
                GET_COIN:               dispenser['GET_COIN'],
                GET_TICK:               dispenser['GET_TICK'],
                GET_AMOUNT:             (attributedCost !== null) ? attributedCost : data['COIN_AMOUNT'],
                DESTINATION:            data['SOURCE'],
                STATUS:                 error
            });
        }

        // Flag-day gate: at/above the activation the auto-close threshold is the
        // dispenser's PER-UNIT price; below it the legacy aggregate-purchase
        // comparison applies so historical replay stays byte-identical.
        let perUnitClose = await this.actions.protocolChanges.isEnabled('DISPENSER_CLOSE_PER_UNIT', block_index);

        // Loop through dispenses and process each
        for(let idx in dispenses){

            // Reset the address/tickers/transactions list on each parse
            this.util.resetLists();

            // Store info on the dispense and dispenser
            let dispense  = dispenses[idx];
            let dispenser = dispenserInfo[dispense['DISPENSER_ACTION_INDEX']];

            // Defensive: dispenserInfo is only populated for known dispensers (see the
            // 'invalid: Dispenser unknown' skip above). A missing entry here means this
            // dispense has nothing to settle against, so skip it rather than throwing.
            if(!dispenser)
                continue;

            // Add Addresses and ticks to the addresses list
            this.util.addAddressTicker(dispense['DESTINATION'], dispenser['GIVE_TICK']);
            this.util.addAddressTicker(dispenser['GET_ADDRESS'],dispenser['GET_TICK']);

            // Set flag to determine if we create new ACTION_INDEX or use existing one
            // Note: Use existing ACTION_INDEX for first DISPSENSE on a native COIN trigger (BTC, LTC. DOGE)
            let createActionIndex = (idx==0 && !this.util.isNull(data['ACTION_INDEX'])) ? false : true;

            // Create a record of this DISPENSE action in the actions table (if it does not already exist)
            dispense['ACTION_INDEX'] = (createActionIndex) ? await this.indexerDb.createActionIndex(data, true) : data['ACTION_INDEX'];

            // Determine final status
            let error  = (dispense['STATUS']) ? dispense['STATUS'] : false;
            let status = (error) ? error : 'valid';
            dispense['STATUS'] = status;

            // Update the in-memory GIVE_REMAINING amount, but only for a VALID dispense.
            // An invalid dispense (e.g. allow/block-list reject) spends no escrow, and the
            // persisted remaining is recomputed from valid dispenses only; decrementing the
            // cached counter for rejected dispenses would let a later reader in this loop
            // see escrow 'spent' by a dispense that never settled.
            if(status=='valid')
                dispenser['GIVE_REMAINING'] = this.util.bcsub(dispenser['GIVE_REMAINING'], dispense['GIVE_AMOUNT'], 64);

            // Print status message
            console.log("\t DISPENSE : " + this.util.logAmount(dispense['GIVE_AMOUNT']) + ' ' + dispenser['GIVE_TICK'] + ' : ' + dispense['STATUS']);

            // Create record in the dispenses table
            await this.indexerDb.createDispense(dispense);

            // Process the dispense
            if(status=='valid'){

                // Array of credits, debits, and escrows
                let credits = [],
                    debits  = [],
                    escrows = [];

                if(Number(dispenser['GIVE_OWNERSHIP']||0) == 1){
                    // Ownership dispense: clear the escrow gate and atomically transfer
                    // ownership from the dispenser SOURCE to the buyer (data['SOURCE']).
                    await this.util.transferTokenOwnership(this.indexerDb, this.mapper, dispense, dispense['GIVE_TICK'], dispenser['SOURCE'], dispense['DESTINATION']);
                } else if(this.util.bcgt(dispense['GIVE_AMOUNT'], 0)){
                    // Balance dispense: debit from escrow, credit buyer
                    // Negate via bcsub, not JS unary minus: -GIVE_AMOUNT coerces the
                    // 64-precision bignumber string to a float and silently loses digits
                    // past ~15 sig figs, de-syncing the escrow debit from the full-precision
                    // credit below. Mirror the credit exactly at the same precision (64).
                    escrows.push([dispense['GIVE_TICK'], this.util.bcsub(0, dispense['GIVE_AMOUNT'], 64), dispense['DESTINATION']]);
                    credits.push([dispense['GIVE_TICK'],  dispense['GIVE_AMOUNT'], dispense['DESTINATION']]);
                }

                // Process any transaction ledger changes (credits / debits / escrows)
                await this.util.processTransactionLedgerChanges(this.indexerDb, dispense, credits, debits, escrows);

            }

            // Get a list of addresses
            let addresses = Object.keys(this.util.getAddressesList());

            // Update address balances
            await this.indexerDb.updateBalances(addresses);

            // Create action mappings
            await this.mapper.createMappings(dispense);

            // Close the dispenser when it can no longer serve a buyer. The correct
            // threshold is the dispenser's PER-UNIT price (dispenser GIVE_AMOUNT):
            // close only when remaining escrow cannot cover one more unit. The
            // legacy comparison used the triggering dispense's aggregate
            // give_amount (multiplier * per-unit), closing early after any large
            // order; that behavior is preserved below the gate above so
            // historical blocks replay byte-identically.
            let closeThreshold = perUnitClose ? dispenser['GIVE_AMOUNT'] : dispense['GIVE_AMOUNT'];
            if(status=='valid' && this.util.bclt(dispenser['GIVE_REMAINING'], closeThreshold)){
                let action = 'DISPENSER_CLOSE';
                // cdata, not data: `data` is parse()'s own transaction object, and a local
                // by that name shadows it for the rest of this block, so a later edit
                // reaching for the transaction's SOURCE / FEE_PROBE would silently read the
                // synthetic close payload instead. Matches the MAX_DISPENSES branch below,
                // which already names it this way for the same reason.
                let cdata = {};
                cdata['ACTION']                 = action;
                cdata['BLOCK_INDEX']            = block_index;
                cdata['BLOCK_TIME']             = block_time;
                cdata['TX_INDEX']               = tx_index;
                cdata['DISPENSER_ACTION_INDEX'] = dispenser['ACTION_INDEX'];
                cdata['DISPENSER_STATUS']       = 'empty';
                await this.actions.processAction(action, null, cdata, null);
            } else if(status=='valid' && dispenserCaps.isDispenserCapsActive(block_time, this.config['NETWORK'])){
                // MAX_DISPENSES cap (see dispenser_caps_activation.js). The dispense
                // that reaches the cap already executed above; now the dispenser auto-closes
                // and refunds remaining escrow to the owner. DISPENSER_CLOSE routes the refund
                // sweep > canceller > SOURCE, which resolves to SOURCE for this auto-close (no
                // sweep, no canceller). The count is derived from valid dispenses since the last
                // refill (a refill resets it), matching Counterparty dispense.py. Gated with the
                // dispenser-family cohort so historical replay stays byte-identical below it.
                let dispenseCount = await this.indexerDb.getDispenserDispenseCount(dispenser['ACTION_INDEX']);
                if(dispenseCount >= this.config['MAX_DISPENSES']){
                    let action = 'DISPENSER_CLOSE';
                    let cdata = {};
                    cdata['ACTION']                 = action;
                    cdata['BLOCK_INDEX']            = block_index;
                    cdata['BLOCK_TIME']             = block_time;
                    cdata['TX_INDEX']               = tx_index;
                    cdata['DISPENSER_ACTION_INDEX'] = dispenser['ACTION_INDEX'];
                    cdata['DISPENSER_STATUS']       = 'max_dispenses_reached';
                    await this.actions.processAction(action, null, cdata, null);
                }
            }
        }
    }
}

module.exports = Dispense;