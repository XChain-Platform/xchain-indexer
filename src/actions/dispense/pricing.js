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
 * DISPENSE handler part: PRICING one dispenser.
 *
 * The body of the per-dispenser loop. Called once per matching dispenser, in the
 * order findMatchingDispensers returned them, so an earlier dispenser sees its own
 * spend drained from the tally exactly as it did when this was a loop body. The
 * three pricing paths keep their else-if chain in priceDispenseFill; each branch
 * body is one call, so which branch runs and in what order the conditions are
 * evaluated is unchanged. `row` carries the per-dispenser locals between steps.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry');
const tallyScaleActivation = require('./dispense_payment_tally_scale_gate.js');

// Installed onto Dispense.prototype by index.js; each method runs with `this`
// bound to the handler, exactly as the inline code it was.
module.exports = {

    // One dispenser behind the paid address. The early return skips the rest of this
    // dispenser, which is what `continue` does at that point inside a loop.
    async priceDispenseForDispenser(ctx, action_index){
    let { data, dispenserInfo, ledger, tallyScale } = ctx;

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
                return;

            // Store the dispenser info for easy reference
            dispenserInfo[dispenser['ACTION_INDEX']] = dispenser;

            // What is left of the payment for THIS dispenser, re-read every iteration so
            // an earlier dispenser in this same loop (several dispensers can sit behind
            // one paid address) sees its spend reflected too. Every pricing path below
            // reads `available`, never the raw payment.
            let available = ledger ? this.util.bcsub(data['COIN_AMOUNT'], ledger['coinAmountConsumed'], tallyScale) : data['COIN_AMOUNT'];

            // Coin cost of ONE fill on whichever pricing path runs, filled in by that path
            // and used only to drain the pool at the end of this iteration. Left null when
            // no ledger is in play (nothing to drain) or when no path priced a fill.
            let unitCoinCost = null;

            // What this dispense was actually charged, written by the drain below and
            // recorded as the row's GET_AMOUNT. Null means nothing was attributed (no
            // tally in play, or this dispense settled nothing), and the row keeps the
            // legacy whole-payment figure.
            let attributedCost = null;

        let row = { action_index, dispenser, error, available, unitCoinCost, attributedCost, multiplier: 0 };
        await this.priceDispenseFill(ctx, row);
        await this.applyDispenseFillRules(ctx, row);
        await this.checkDispenseSettlement(ctx, row);
        await this.drainDispenseTally(ctx, row);
        this.recordDispenseRow(ctx, row);
    },

    // The three pricing paths, in the chain they always formed.
    async priceDispenseFill(ctx, row){
    let { data, block_index } = ctx;
        let { dispenser, error, available } = row;

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
            let fiatPricingActive = this.util.isNull(dispenser['FIAT'])
                ? true
                : await this.actions.protocolChanges.isEnabled('FIAT_DISPENSER_PRICING', block_index);
            if(!error && !this.util.isNull(dispenser['FIAT']) && !fiatPricingActive){
                row.error = 'invalid: FIAT dispenser pricing not active';
            } else if(!error && !this.util.isNull(dispenser['FIAT']) && !this.util.isNull(dispenser['ORACLE_ADDRESS'])){
                await this.priceFromOracle(ctx, row);
            } else if(!error && !this.util.isNull(dispenser['FIAT'])){
                await this.priceFromValidatorSnapshot(ctx, row);
            }

            // Non-FIAT dispenser: verify COIN_AMOUNT >= GET_AMOUNT and calculate multiplier
            if(!row.error && this.util.isNull(dispenser['FIAT'])){
                await this.priceFromNativeAmount(ctx, row);
            }
    },

    // The self-trigger refusal, the single-shot ownership cap, and the clamp to what
    // the dispenser can still give.
    async applyDispenseFillRules(ctx, row){
    let { data } = ctx;
        let { dispenser } = row;
        let multiplier = row.multiplier;
        let error = row.error;

            // Ignore if DISPENSE is being triggered by GET_ADDRESS (dispenser can't trigger itself)
            if(!error && data['SOURCE']==dispenser['GET_ADDRESS'])
                error = 'invalid: SOURCE and GET_ADDRESS can not be same';

            // Ownership dispensers are single-shot: cap multiplier at 1 regardless of overpayment
            // (extra coin is absorbed as a tip, matching the existing overpayment behavior).
            let isOwnershipDispenser = (Number(dispenser['GIVE_OWNERSHIP']||0) == 1);
            if(isOwnershipDispenser && multiplier > 1)
                multiplier = 1;

        row.multiplier = multiplier;
        row.error = error;
        this.clampFillToRemaining(ctx, row);
        this.checkDispenseFillCount(ctx, row);
    },

    // Clamp the fill count to what the dispenser can actually still give.
    clampFillToRemaining(ctx, row){
        let { dispenser } = row;
        let multiplier = row.multiplier;

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
            //     dispenser_give_amount_activation (armed at genesis on mainnet too by
            //     the 2026-09-09 ruling, so this is legacy-only history now), where
            //     bcmul() coerced it to 0 so `0 > GIVE_REMAINING` was
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

        row.multiplier = multiplier;
        row.give_amount = give_amount;
    },

    // At least one whole unit must be dispensable.
    checkDispenseFillCount(ctx, row){
    let { block_time } = ctx;
        let multiplier = row.multiplier;
        let error = row.error;

            // Verify at least one unit can be dispensed (multiplier > 0). The legacy
            // reading tests equality, so a NEGATIVE count settles valid having skipped every
            // downstream guard, and the GIVE_REMAINING recompute then subtracts a negative
            // (the dispenser_amount_positivity_activation row's note in src/protocol_changes/
            // carries the chain and the gating argument). Guard the fill COUNT, not a price
            // field: three producers feed it.
            let rejectNonPositiveFill = gateRegistry.activeAt('dispenser_amount_positivity_activation.DISPENSER_AMOUNT_POSITIVITY_ACTIVATION', this.config['NETWORK'], null, null, block_time);
            if(!error && (rejectNonPositiveFill ? !this.util.bcgt(multiplier, '0') : multiplier == 0))
                error = 'invalid: insufficient funds ';

        row.error = error;
    },

    // Escrow, balance and allow/block-list checks for a dispense that priced a fill.
    async checkDispenseSettlement(ctx, row){
    let { data } = ctx;
        let { dispenser, multiplier } = row;
        let error = row.error;

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

            error = await this.checkDispenseLists(ctx, row, error, dispenser,
                getTokenAllowList, getTokenBlockList, giveTokenAllowList, giveTokenBlockList,
                dispenserAllowList, dispenserBlockList, giveTokenInfo);
        }

        row.error = error;
    },

    // The allow/block-list and escrow checks, with the lists the caller resolved.
    async checkDispenseLists(ctx, row, error, dispenser, getTokenAllowList, getTokenBlockList,
                             giveTokenAllowList, giveTokenBlockList, dispenserAllowList,
                             dispenserBlockList, giveTokenInfo){
    let { data } = ctx;
        let multiplier = row.multiplier;

                // Handle validating both sides of dispense are allowed (ALLOW/BLOCK list support)
                if(!error){
                    // Get Token Allow List
                    if(getTokenAllowList.length){
                        if(!error && !getTokenAllowList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GET_TOKEN allow list)';
                        // Verify GET_ADDRESS is also on the GET_TOKEN allow list
                        if(!error && !getTokenAllowList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GET_TOKEN allow list)';
                    }
                    // Get Token Block List
                    if(getTokenBlockList.length){
                        if(!error && getTokenBlockList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GET_TOKEN block list)';
                        // Verify GET_ADDRESS is not on the GET_TOKEN block list
                        if(!error && getTokenBlockList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GET_TOKEN block list)';
                    }
                    // Give Token Allow List
                    if(giveTokenAllowList.length){
                        if(!error && !giveTokenAllowList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GIVE_TOKEN allow list)';
                        // Verify GET_ADDRESS is also on the GIVE_TOKEN allow list
                        if(!error && !giveTokenAllowList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GIVE_TOKEN allow list)';
                    }
                    // Give Token Block List
                    if(giveTokenBlockList.length){
                        if(!error && giveTokenBlockList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (GIVE_TOKEN block list)';
                        // Verify GET_ADDRESS is not on the GIVE_TOKEN block list
                        if(!error && giveTokenBlockList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (GIVE_TOKEN block list)';
                    }
                    // Dispenser Allow List
                    if(dispenserAllowList.length){
                        if(!error && !dispenserAllowList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (dispenser allow list)';
                        // Verify GET_ADDRESS is also on the dispenser's own allow list
                        if(!error && !dispenserAllowList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (dispenser allow list)';
                    }
                    // Dispenser Block List
                    if(dispenserBlockList.length){
                        if(!error && dispenserBlockList.includes(data['SOURCE']))
                            error = 'invalid: DESTINATION (DISPENSER block list)';
                        // Verify GET_ADDRESS is not on the dispenser's own block list
                        if(!error && dispenserBlockList.includes(dispenser['GET_ADDRESS']))
                            error = 'invalid: GET_ADDRESS (DISPENSER block list)';
                    }
                }

        return error;
    },


    // Draw what THIS dispense was priced at out of the tally.
    async drainDispenseTally(ctx, row){
    let { data, ledger, tallyScale } = ctx;
        let { dispenser, multiplier, unitCoinCost, error } = row;
        let available = row.available;
        let attributedCost = row.attributedCost;

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
            // to `available` is a rounding guard only: bcmul rounds at tallyScale, and the
            // pool must never go negative. Ledger values stay decimal STRINGS.
            //
            // isNull rather than !== null on unitCoinCost: an undefined price would
            // multiply out to a silent zero, which now also lands in the row's GET_AMOUNT
            // and would read as "this dispense was free". Unreachable in production (all
            // three pricing paths set it before a dispense can be valid); the strict form
            // keeps it that way.
            if(ledger && !error && !this.util.isNull(unitCoinCost) && multiplier > 0){
                let cost = this.util.bcmul(multiplier, unitCoinCost, tallyScale);
                if(this.util.bclt(available, cost))
                    cost = available;
                // Row 18: the row records what this dispense was CHARGED, not the whole
                // payment. Taken from the same `cost` the pool is drained by, on purpose:
                // the record and the accounting are one number, so they can never
                // disagree. Under the old shape three batched sub-commands each wrote the
                // full payment into their own row while consuming a third of it, and the
                // multi-dispenser loop did the same outside a batch.
                //
                // Rendered at the legacy 8 dp whenever that width is EXACT, so every
                // dispense the wide tally does not reprice keeps its byte-identical row,
                // and at full precision only where 8 dp would write a false zero for a
                // sub-satoshi charge. Same value either way, so record and accounting
                // still cannot disagree.
                let legacyRender = this.util.bcformat(cost, tallyScaleActivation.DISPENSE_TALLY_LEGACY_SCALE);
                let legacyIsExact = !this.util.bclt(legacyRender, cost) && !this.util.bcgt(legacyRender, cost);
                attributedCost = legacyIsExact ? legacyRender : this.util.bcstr(cost);
                ledger['coinAmountConsumed'] = this.util.bcformat(
                    this.util.bcadd(ledger['coinAmountConsumed'], cost, tallyScale), tallyScale);
            }

        row.attributedCost = attributedCost;
    },

    // The dispenses[] row this dispenser produced.
    recordDispenseRow(ctx, row){
    let { data, block_index, block_time, tx_index, dispenses } = ctx;
        let { action_index, dispenser, multiplier, attributedCost, error, give_amount } = row;

            // Add the dispense info to the dispenses array;
            //
            // GET_AMOUNT is the attributed cost when a tally priced this dispense, and
            // otherwise the whole payment exactly as before. That makes the flag the gate
            // for the record shape too: below it, or on a dispense that settled nothing,
            // nothing is attributed and the legacy figure stands. The column is not a hash
            // preimage anywhere (table_lifecycle.js classes `dispenses` as a derived
            // projection, and getBlockHashes covers credits/debits/escrows/actions/
            // contracts only), so this is a record correction rather than a consensus
            // change. It is gated regardless: replicas mirror these rows verbatim and no
            // hash would catch a fleet writing two different values, and get_amount is the
            // coin leg of the XCHAIN/BTC price derivation over realized dispense fills
            // (xchain_price_query.js DISPENSE_FILLS_SQL), which is built to feed native fee
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
    },
};

