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
 * XChain Platform Action - SEND: controller guard
 *
 * The token's controller guard and the SOURCE-side and recipient-side
 * address-controller guards a SEND leg runs before it settles.
 *
 ********************************************************************/

// Installed onto Send.prototype by send.js; each method runs with `this` bound to the
// handler, exactly as the class method it was.
module.exports = {

    // Controller-bound token: defer to the bound contract's `guard` method
    // before the transfer settles. The guard may DENY (revert) or run
    // programmable side effects (state writes, royalty/fee emissions). It is
    // the final gate: all other validation has passed when it runs, so an
    // allow leads directly to a valid send. SOURCE must have reserved the
    // guard gas ceiling fee (mirrors the cross-contract-call reservation) so
    // a cheap/denied guard never drives GAS negative; the actual metered fee
    // is billed in the valid block below.
    //
    // `balances` (all ticks) and `gasBalances` (GAS only) are two independent
    // in-memory snapshots. When the token being sent IS the gas token they both
    // track the exact same underlying balance, so reserving/debiting the guard
    // fee against the separate `gasBalances` snapshot lets AMOUNT and guardFee
    // each pass their checks against a full, undebited copy of the same balance
    // and be spent twice. Mirror the airdrop/dividend/sweep pattern: when the
    // send tick equals the gas tick, reserve and debit the guard fee against a
    // clone of `balances` that is already pre-debited by this leg's AMOUNT, so a
    // single balance must cover AMOUNT + guardFee together.
    //
    // Returns { error, guardFee, sameTick }: the leg's total guard gas, and whether it is
    // debited from `balances` (sent tick IS the gas tick) rather than from `gasBalances`.
    async runSendGuards(idx, send, tokenInfo, ctx, error){
        // Guard gas fee billed to SOURCE for this leg (0 = uncontrolled token)
        let guardFee = 0;

        let sameTick = !!(ctx.gasInfo && tokenInfo && String(ctx.gasInfo['TICK_ID']) === String(tokenInfo['TICK_ID']));
        let baseGasBalances = ctx.gasBalances;
        if(sameTick && !error)
            baseGasBalances = this.util.debitBalances(Object.assign({}, ctx.balances), tokenInfo['TICK_ID'], send['AMOUNT']);

        // Run the token's controller guard, if bound, before the transfer settles
        if(!error && tokenInfo){
            let result = await this.util.maybeRunControllerGuard(this.actions, this.indexerDb, {
                actionType:  'SEND',
                tick:        send['TICK'],
                from:        send['SOURCE'],
                to:          send['DESTINATION'],
                amount:      send['AMOUNT'],
                data:        send,
                gasInfo:     ctx.gasInfo,
                gasBalances: baseGasBalances,
                seq:         parseInt(idx) || 0
            });
            if(result.error)
                error = 'invalid: ' + result.error;
            else
                guardFee = result.guardFee;
        }

        ({ error, guardFee } = await this.runSendAddressGuards(idx, send, ctx, baseGasBalances, error, guardFee));
        return { error, guardFee, sameTick };
    },

    // The SOURCE-side then the recipient-side `transfer` address-controller gate, each one's gas
    // reserved after the guard gas this leg already owes. Returns { error, guardFee }.
    async runSendAddressGuards(idx, send, ctx, baseGasBalances, error, guardFee){
        // SOURCE-side gate: the SENDER's own `transfer` address-controller may gate its OUTBOUND
        // transfers (self-imposed spending controls: velocity, allowlists, compliance). Runs
        // after the token's guard, before the recipient gate. A single `transfer` address binding
        // it fires whether the account is SOURCE (here) or DESTINATION (below); the
        // guard distinguishes direction via its from/to (from === subject ⇒ outbound). SOURCE pays
        // the guard gas, reserved cumulatively after this leg's token guardFee (a shallow clone, so
        // gasBalances only commits in the valid block) so GAS can't be driven negative.
        if(!error && !this.util.isNull(send['SOURCE'])){
            let outbound = await this.runSendAddressGuard(send['SOURCE'], idx, send, ctx, baseGasBalances, guardFee);
            if(outbound.error)
                error = 'invalid: ' + outbound.error;
            else
                guardFee = this.util.bcadd(guardFee, outbound.guardFee, 8);
        }

        // Recipient-side gate: the DESTINATION's own `transfer` address-controller may refuse an
        // incoming direct SEND it didn't solicit (spam/compliance). Refusal reverts this leg;
        // SOURCE pays the guard gas. Its reservation runs against the GAS balance ALREADY reduced
        // by this leg's token guardFee (a shallow clone, so gasBalances only commits in the valid
        // block), keeping the two-guard reservation cumulative so GAS can't be driven negative.
        // DEX/dispense deliveries are solicited pulls, not direct sends, so they are never gated.
        if(!error && !this.util.isNull(send['DESTINATION'])){
            let recip = await this.runSendAddressGuard(send['DESTINATION'], idx, send, ctx, baseGasBalances, guardFee);
            if(recip.error)
                error = 'invalid: ' + recip.error;
            else
                guardFee = this.util.bcadd(guardFee, recip.guardFee, 8);
        }

        return { error, guardFee };
    },

    // Run the `transfer` address-controller guard bound to `address` for this leg. Its gas
    // reservation is taken against a shallow clone already reduced by the guard gas charged so
    // far, so the reservation is cumulative and gasBalances only commits in the valid block.
    async runSendAddressGuard(address, idx, send, ctx, baseGasBalances, guardFee){
        let reserveBalances = baseGasBalances;
        if(ctx.gasInfo && this.util.bcgt(guardFee, 0))
            reserveBalances = this.util.debitBalances(Object.assign({}, baseGasBalances), ctx.gasInfo['TICK_ID'], guardFee);
        return await this.util.maybeRunAddressControllerGuard(this.actions, this.indexerDb, {
            actionType:  'SEND',
            actionClass: 'transfer',
            address:     address,
            tick:        send['TICK'],
            from:        send['SOURCE'],
            to:          send['DESTINATION'],
            amount:      send['AMOUNT'],
            data:        send,
            gasInfo:     ctx.gasInfo,
            gasBalances: reserveBalances,
            seq:         parseInt(idx) || 0
        });
    }
};
