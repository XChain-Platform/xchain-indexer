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
 * DISPENSER handler part: PER-FORMAT FIELD VALIDATION.
 *
 * The amount, ownership, address, expiration and fiat field rules for each format,
 * the Mode B oracle price precondition, and the PRICE v1 oracle usage fee. parse()
 * calls these between validateTickCoinFiat and validateGeneralRules, which is where
 * they ran inline.
 *
 ********************************************************************/

'use strict';

const dispenserGiveAmount = require('../../dispenser_give_amount_activation.js');
const dispenserOraclePrice = require('../../dispenser_oracle_price_activation.js');
const dispenserAmountPositivity = require('../../dispenser_amount_positivity_activation.js');

// Installed onto Dispenser.prototype by dispenser.js; each method runs with `this`
// bound to the handler, exactly as the inline code it was.
module.exports = {

    // GIVE_AMOUNT / GIVE_ESCROW / GIVE_OWNERSHIP formats, the ownership single-shot
    // rules, the balance-dispenser positive-give rule and the GET_AMOUNT format.
    async validateAmountFields(ctx){
    let { data, error, format, isOwnershipGive, giveTokenInfo, getTokenInfo } = ctx;

        // Verify GIVE_AMOUNT format
        if(!error && format==0 && !this.util.isNull(data['GIVE_AMOUNT']) && giveTokenInfo && !this.util.isValidAmountFormat(giveTokenInfo['DECIMALS'], data['GIVE_AMOUNT'], data['BLOCK_TIME']))
            error = "invalid: GIVE_AMOUNT (format)";

        // Verify GIVE_ESCROW format. Covers format 2 (edit/refill) too: a refill
        // carries GIVE_ESCROW against the existing dispenser's GIVE_TICK, and an
        // unvalidated non-numeric / over-precision value would reach bcsub and throw,
        // halting the indexer at that block.
        if(!error && (format==0 || format==2) && !this.util.isNull(data['GIVE_ESCROW']) && giveTokenInfo && !this.util.isValidAmountFormat(giveTokenInfo['DECIMALS'], data['GIVE_ESCROW'], data['BLOCK_TIME']))
            error = "invalid: GIVE_ESCROW (format)";

        // GIVE_OWNERSHIP must be 0 or 1
        if(!error && format==0 && ![0,1].includes(data['GIVE_OWNERSHIP']))
            error = "invalid: GIVE_OWNERSHIP (format)";

        // Ownership dispensers are single-shot: GIVE_AMOUNT and GIVE_ESCROW must be empty,
        // SOURCE must be the current GIVE_TICK owner, and the tick's ownership must not
        // already be escrowed by another offer.
        if(!error && isOwnershipGive){
            if(!this.util.isNull(data['GIVE_AMOUNT']))
                error = "invalid: GIVE_AMOUNT (must be empty when GIVE_OWNERSHIP=1)";
            else if(!this.util.isNull(data['GIVE_ESCROW']))
                error = "invalid: GIVE_ESCROW (must be empty when GIVE_OWNERSHIP=1)";
            else if(!giveTokenInfo)
                error = "invalid: GIVE_TICK (unknown)";
            else if(giveTokenInfo['OWNER'] != data['SOURCE'])
                error = "invalid: SOURCE (not GIVE_TICK owner)";
            else if(await this.indexerDb.isOwnershipEscrowed(data['GIVE_TICK']))
                error = "invalid: GIVE_TICK (ownership already escrowed)";
        }

        // A balance dispenser must hand out something. Empty or "0" GIVE_AMOUNT
        // passed every check above (the format rule at 184 only runs when the field
        // is present, and the block above binds only GIVE_OWNERSHIP=1), and opened a
        // dispenser that settles buyer payments as VALID fills crediting nothing:
        // every downstream guard reads a non-positive GIVE_AMOUNT as "ownership
        // dispenser" and skips (dispense.js giveAmountIsPositive clamp, the
        // bcgt(GIVE_AMOUNT,0) credit/escrow branch), while the auto-close threshold
        // is that same non-positive value, so it never closes and keeps absorbing
        // payments. GIVE_ESCROW is deliberately NOT constrained here: an empty
        // escrow is a legitimate open-now-refill-later dispenser, and with a
        // positive GIVE_AMOUNT the clamp drives the multiplier to 0 so the dispense
        // settles invalid and consumes nothing. Gated (see
        // dispenser_give_amount_activation.js): this rejects creates the ungated
        // engine accepts, so replay below the flag-day stays byte-identical.
        if(!error && format==0 && !isOwnershipGive &&
           dispenserGiveAmount.isDispenserGiveAmountActive(data['BLOCK_TIME'], this.config['NETWORK']) &&
           (this.util.isNull(data['GIVE_AMOUNT']) || !this.util.bcgt(data['GIVE_AMOUNT'], '0')))
            error = "invalid: GIVE_AMOUNT (required and greater than 0 when GIVE_OWNERSHIP=0)";

        // Verify GET_AMOUNT format
        if(!error && format==0 && !this.util.isNull(data['GET_AMOUNT']) && getTokenInfo && !this.util.isValidAmountFormat(getTokenInfo['DECIMALS'], data['GET_AMOUNT'], data['BLOCK_TIME']))
            error = "invalid: GET_AMOUNT (format)";

    ctx.data = data;
    ctx.error = error;
    },

    // The native-coin GET_AMOUNT rules, GET_ADDRESS, EXPIRATION and FIAT_AMOUNT.
    async validateAddressAndExpirationFields(ctx){
    let { data, error, format, getTokenInfo } = ctx;

        // Verify a NATIVE-COIN-priced GET_AMOUNT against COIN_DECIMALS, as order.js resolves
        // its native side. The rule above is a conjunct on getTokenInfo, which an empty
        // GET_TICK never loads, so that shape reached storage with no sign or precision
        // check. Gated (dispenser_amount_positivity_activation.js): it rejects creates the
        // ungated engine accepts, so replay below the threshold stays byte-identical.
        let getAmountPositivity = dispenserAmountPositivity.isDispenserAmountPositivityActive(data['BLOCK_TIME'], this.config['NETWORK']);
        if(!error && format==0 && getAmountPositivity && this.util.isNull(data['GET_TICK']) &&
           !this.util.isNull(data['GET_AMOUNT']) && !this.util.isValidAmountFormat(this.config['COIN_DECIMALS'], data['GET_AMOUNT'], data['BLOCK_TIME']))
            error = "invalid: GET_AMOUNT (format)";

        // Require a strictly-positive GET_AMOUNT on a dispenser that names its own price,
        // mirroring the same positive-amount rule at order.js. Skipped for FIAT and oracle
        // dispensers, where the price comes from FIAT_AMOUNT or the oracle round and an
        // empty GET_AMOUNT is legitimate. Gated for the same reason as the rule above.
        if(!error && format==0 && getAmountPositivity &&
           this.util.isNull(data['FIAT_CODE']) && this.util.isNull(data['ORACLE_ADDRESS']) &&
           !this.util.bcgt(data['GET_AMOUNT'], '0'))
            error = "invalid: GET_AMOUNT (must be positive)";

        // Verify GET_ADDRESS is given if COIN network differs from GET_COIN network
        if(!error && format==0 && this.config['COIN']!=data['GET_COIN'] && this.util.isNull(data['GET_ADDRESS']))
            error = "invalid: GET_ADDRESS";

        // Verify GET_ADDRESS is valid for the given GET_COIN network
        if(!error && format==0 && !this.util.isNull(data['GET_ADDRESS']) && !this.util.isCryptoAddress(data['GET_ADDRESS']))
            error = "invalid: GET_ADDRESS (format)";

        // Validate that EXPIRATION is an integer
        if(!error && !this.util.isNull(data['EXPIRATION']) && (!this.util.isNumeric(data['EXPIRATION']) || !this.util.isInteger(data['EXPIRATION'])))
            error = "invalid: EXPIRATION (format)";

        // Reject an EXPIRATION the expiration column cannot represent. Without this a
        // payload that is otherwise VALID normalizes to expiration NULL for storage, i.e.
        // an escrow that never expires, which is a worse outcome than rejecting it.
        if(!error && !this.util.isNull(data['EXPIRATION']) &&
           this.util.exceedsUnsignedColumn(data['EXPIRATION'], this.config['INTEGER_FIELDS']['EXPIRATION']))
            error = "invalid: EXPIRATION (format)";

        // Validate that FIAT_AMOUNT is in 0.00 format
        if(!error && format==0 && !this.util.isNull(data['FIAT_CODE']) && !this.util.isNull(data['FIAT_AMOUNT']) && !this.util.isValidFiatFormat(2, data['FIAT_AMOUNT'], data['BLOCK_TIME']))
            error = 'invalid: FIAT_AMOUNT (format)';

    ctx.data = data;
    ctx.error = error;
    },

    // A Mode B create must name an oracle that already has an EFFECTIVE price.
    async validateOraclePrecondition(ctx){
    let { data, error, format } = ctx;

        // A Mode B create must name an oracle that already has an EFFECTIVE price. This is
        // a VALIDITY rule, not a pricing one, and it is deliberately checked HERE rather
        // than left to the oracle-fee block below: that block is gated on GIVE_ESCROW > 0,
        // because the fee it computes is sized by the escrow being added. The price
        // precondition has no such scope. An ownership dispenser is REQUIRED to carry an
        // empty GIVE_ESCROW (see the block above) and cannot be refilled later once the
        // caps cohort is active, so before this check existed a GIVE_OWNERSHIP=1 create
        // naming a never-priced oracle was accepted outright: it escrowed the tick's
        // ownership behind a dispenser that can never settle (reverseOraclePriceMatch
        // finds no row) and used the oracle for free. Same for an open-now-refill-later
        // balance create.
        //
        // Deliberately NOT gated on data['FEE_PROBE']. Unlike the fee block's OUTPUT half,
        // an effective oracle price is knowable in advance and is the one verdict a caller
        // can act on ("publish, wait out the 24h window, then create"), so the read-only
        // quote/preflight surfaces must report it too rather than green-light a create the
        // chain will reject.
        //
        // format-0 only. An escrow-bearing format-2 refill already reaches the same rule
        // through the fee path, and checking every edit unconditionally would newly reject
        // expiration-only or list-only edits on a dispenser whose oracle is perfectly fine.
        //
        // Gated (see dispenser_oracle_price_activation.js): this rejects creates the ungated
        // engine accepts, so replay below the flag-day stays byte-identical.
        if(!error && format==0 && !this.util.isNull(data['ORACLE_ADDRESS']) &&
           dispenserOraclePrice.isDispenserOraclePriceActive(data['BLOCK_TIME'], this.config['NETWORK']) &&
           await this.actions.protocolChanges.isEnabled('FIAT_DISPENSER_PRICING', data['BLOCK_INDEX'])){
            let priceCheck = await this.util.requireEffectiveOraclePrice(data['BLOCK_TIME'], {
                ORACLE_ADDRESS: data['ORACLE_ADDRESS'],
                GIVE_COIN:      data['GIVE_COIN'],
                GIVE_TICK:      data['GIVE_TICK'],
                FIAT_CODE:      data['FIAT_CODE'],
            }, this.indexerDb);
            if(!priceCheck.valid)
                error = priceCheck.error;
        }

    ctx.data = data;
    ctx.error = error;
    },

    // The PRICE v1 oracle usage fee a create or a refill owes the oracle operator.
    async validateOracleUsageFee(ctx){
    let { data, error, format, dispenserInfo } = ctx;

        // PRICE v1 oracle usage fee, Counterparty parity: a Mode B dispenser
        // pays the oracle operator UP FRONT, as a real native-coin output, charged to the
        // address opening (or refilling) it rather than to buyers per dispense. The fee
        // scales with the escrow this action adds, so a refill pays for what it adds and
        // an opener cannot escrow one token, pay nothing, then top up to millions.
        //
        // Gated with the rest of FIAT settlement: below activation no fee is owed and the
        // create behaves exactly as it did before this rule existed.
        //
        // v0 charges on the opening GIVE_ESCROW; v2 charges on its refill amount, read
        // from the existing dispenser for the fields the edit format does not carry.
        // Ownership dispensers escrow no balance (GIVE_ESCROW empty), so nothing is owed.
        if(!error && (format==0 || format==2) && !this.util.isNull(data['GIVE_ESCROW']) &&
           this.util.bcgt(data['GIVE_ESCROW'], '0') &&
           await this.actions.protocolChanges.isEnabled('FIAT_DISPENSER_PRICING', data['BLOCK_INDEX'])){
            let oracleAddress = (format==0) ? data['ORACLE_ADDRESS'] : (dispenserInfo ? dispenserInfo['ORACLE_ADDRESS'] : null);
            if(!this.util.isNull(oracleAddress))
                error = await this.chargeOracleUsageFee(ctx, oracleAddress, error);
        }

    ctx.data = data;
    ctx.error = error;
    },

    // The fee itself, once the gate above has decided one is owed and named the oracle.
    // Returns the (possibly unchanged) error, so the caller's guard chain reads as it did
    // when this was the inner block of that same if().
    async chargeOracleUsageFee(ctx, oracleAddress, error){
    let { data, format, dispenserInfo } = ctx;

            {
                let feeDispenser = {
                    ORACLE_ADDRESS: oracleAddress,
                    GIVE_COIN:      (format==0) ? data['GIVE_COIN'] : dispenserInfo['GIVE_COIN'],
                    GIVE_TICK:      (format==0) ? data['GIVE_TICK'] : dispenserInfo['GIVE_TICK'],
                    FIAT_CODE:      (format==0) ? data['FIAT_CODE'] : dispenserInfo['FIAT'],
                    GET_COIN:       (format==0) ? data['GET_COIN']  : dispenserInfo['GET_COIN'],
                    GIVE_ESCROW:    data['GIVE_ESCROW'],
                };
                // A read-only dry run (the public feequote / preflight surfaces) has no
                // transaction behind it and therefore no outputs, so the OUTPUT half of this
                // check can only ever fail there - and what it demands is the very amount the
                // refused quote exists to compute, so no client can satisfy it. Check the
                // half that IS knowable in advance (the oracle has an effective price, and
                // there is a validator price to value its fee against, both of which a caller
                // can act on) and skip the half that structurally cannot exist yet. The
                // native-coin fee check gets a probe OUTPUT for the same reason
                // (actions/index.js _dryRunAction); this one cannot, because ORACLE_ADDRESS may be
                // a ^id reference that is only resolved above.
                let feeCheck = data['FEE_PROBE']
                    ? await this.util.quoteOracleFee(data['BLOCK_TIME'], feeDispenser, this.indexerDb)
                    : await this.util.validateOracleFee(data, feeDispenser, this.indexerDb);
                if(!feeCheck.valid)
                    error = feeCheck.error;

                // Probe-only disclosure (spec row 46). quoteOracleFee reads no output, so it
                // cannot see what a SIBLING sub-command in the same batch already owes the same
                // oracle: N Mode B DISPENSERs naming one oracle each quote the same single fee
                // as covered, where validateOracleFee makes N commands' worth cover exactly N.
                // The probe cannot close that by tallying against an output it does not have,
                // so it reports the SUM owed per oracle instead and leaves the judgement to the
                // composer. A probe-LOCAL object, never data['BATCH_VALUE_LEDGER']: writing
                // that one would be a read-only surface mutating consensus state, and its
                // presence is what three other readers use to mean "inside a batch".
                // Accumulated only when a fee is actually owed, matching validateOracleFee's
                // own belowDust early-return, which spends nothing and tallies nothing.
                if(data['FEE_PROBE'] && feeCheck.valid && !feeCheck.belowDust){
                    if(!data['PROBE_ORACLE_FEES']) data['PROBE_ORACLE_FEES'] = {};
                    let owed = data['PROBE_ORACLE_FEES'][oracleAddress] || '0';
                    data['PROBE_ORACLE_FEES'][oracleAddress] =
                        this.util.bcformat(this.util.bcadd(owed, feeCheck.expectedFee, 8), 8);
                }
            }

    ctx.data = data;
    return error;
    },
};

