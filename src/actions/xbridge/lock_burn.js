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
 * The two ledger effects XBRIDGE can have on the chain it is parsed on: a LOCK
 * (v0, v3) that moves units into the keyless escrow role address, and a BURN
 * (v1, v4) that takes them out of local supply. They are the only methods that
 * read the token row and the source balance, and they are the only ones that fill
 * the ledger plan (ctx.credits / ctx.debits), so they live together here.
 *
 * Each function is the handler method moved verbatim and invoked with
 * `.call(this, ...)` from index.js, the way execute/slash_emission.js is; the
 * long methods were then split by phase (field checks, then the ledger plan) so
 * each one reads on one screen.
 *
 ********************************************************************/

'use strict';

const validate = require('./validate.js');
const v        = require('./verdicts.js');
const VERDICTS = v.VERDICTS;

/**
 * Apply a LOCK: v0 (XCHAIN, BTC only) and v3 (any bridgeable native token, on its own
 * origin chain).
 *
 * EFFECT, identical for both versions:
 *   debit(SOURCE, tick, AMOUNT)
 *   credit(ADDRESS.BRIDGE_<DEST_COIN>, tick, AMOUNT)
 * No escrow rows are written, so the escrow journal's totality contract is untouched;
 * the escrow is an ordinary balance at a protocol role address nobody holds a key for,
 * which is what makes it reconcile in db.sanityCheck and ride balances_root for free.
 * Fee: the GAS_SCHEDULE entry XBRIDGE_BASE, 5,000 gas, for both v0 and v3.
 *
 * A v3 lock ALSO stamps the origin row's DECIMALS and MIN_DEPTH as read at its own
 * block onto its own action row (a later edit of the origin row can then never make an
 * accepted lock un-signable, and no two followers can disagree) and sets the origin
 * row's `bridged` bit, which is never cleared once set.
 *
 * v3 consults isActionAllowed for the source and tick the way SEND does: a sleeping or
 * list-blocked source cannot lock.
 *
 * Called with the handler as `this`.
 *
 * @param {Object} data - the action row. Reads FORMAT, SOURCE, TICK (v3 only),
 *                        DEST_COIN, DEST_ADDRESS, AMOUNT, MEMO, BLOCK_INDEX,
 *                        BLOCK_TIME, ACTION_INDEX; writes STATUS
 * @param {Object} ctx  - handler context: { coin, network, blockIndex, blockTime,
 *                        tokenInfo, sourceBalance }
 * @returns {Promise<{valid: boolean, verdict: (string|null)}>} verdict is one of
 *          VERDICTS.TICK_NOT_NATIVE, TICK_USE_V0, TICK_SUBASSET, TICK_TOO_LONG,
 *          TICK_NOT_BRIDGEABLE, DEST_COIN, DEST_ADDRESS, AMOUNT, INSUFFICIENT_FUNDS,
 *          or null when the lock applies
 */
async function applyLock(data, ctx){

    let info = ctx.tokenInfo;

    if(!info)
        return { valid: false, verdict: v.TICK_UNKNOWN };

    let checked = await validateLockFields.call(this, data, ctx, info);
    if(!checked.valid)
        return { valid: false, verdict: checked.verdict };

    planLockLedger.call(this, data, ctx, info, checked.escrow, checked.dest);

    return { valid: true, verdict: null };
}

/**
 * The LOCK field checks, in the refusal precedence the token spec sets: the issuer's
 * opt-in, the destination coin, the escrow role address behind it, the destination
 * address, AMOUNT, the shared sleep / list guards, MEMO, then the balance.
 *
 * Called with the handler as `this`.
 *
 * @param {Object} data - the action row; reads FORMAT, DEST_COIN, DEST_ADDRESS, AMOUNT
 * @param {Object} ctx  - handler context; reads coin, network, blockTime, sourceBalance
 * @param {Object} info - the tick's getTokenInfo projection, read at this block
 * @returns {Promise<{valid: boolean, verdict: (string|null), escrow: (string|undefined),
 *                    dest: (string|undefined)}>} on a pass, `escrow` is the keyless
 *          BRIDGE_<DEST_COIN> role address and `dest` the validated destination coin
 */
async function validateLockFields(data, ctx, info){

    let format = data['FORMAT'];

    // The issuer's opt-in, read at the lock's OWN block. Ordered BEFORE the DEST_COIN
    // check because the token spec's refusal list puts every TICK refusal ahead of the
    // base v0/v1 field refusals: a destination the issuer never opted into is a
    // property of the TOKEN, and saying so is more useful than "unknown coin" for a
    // name that happens to be both.
    if(format === 3 && !validate.isBridgeableTo.call(this, info, data['DEST_COIN']))
        return { valid: false, verdict: VERDICTS.TICK_NOT_BRIDGEABLE };

    // DEST_COIN is a supported coin other than this one. Compared verbatim, not
    // case-folded: COINS carries the canonical upper-case symbols and the platform's
    // other cross-chain field (xcall.js TARGET_CHAIN) compares the same way, so one
    // spelling is legal and a lock can never be addressed at a coin the escrow map
    // does not key.
    let dest  = data['DEST_COIN'];
    let coins = this.config['COINS'] || [];
    if(this.util.isNull(dest) || coins.indexOf(String(dest)) === -1 || String(dest) === String(ctx.coin))
        return { valid: false, verdict: VERDICTS.DEST_COIN };

    // The keyless escrow role address for that destination, in THIS chain's bundle. A
    // coin with no BRIDGE_<COIN> address configured has no escrow to lock into, so the
    // destination is refused rather than the balance being credited to a null address.
    let escrow = (this.config['ADDRESS'] || {})['BRIDGE_' + String(dest)];
    if(this.util.isNull(escrow))
        return { valid: false, verdict: VERDICTS.DEST_COIN };

    // Coin-and-network-aware, the call swap.js already makes for a foreign GET_ADDRESS.
    // A mint on a mis-validated address is a permanent loss, which is why this is the
    // full base58check / bech32 validator and not a shape heuristic.
    if(!this.util.isCryptoAddress(data['DEST_ADDRESS'], String(dest), ctx.network))
        return { valid: false, verdict: VERDICTS.DEST_ADDRESS };

    // A positive decimal with at most the token's own DECIMALS fractional digits.
    if(this.util.isNull(data['AMOUNT']) ||
       !this.util.isValidAmountFormat(info['DECIMALS'], data['AMOUNT'], ctx.blockTime) ||
       !this.util.bcgt(data['AMOUNT'], 0))
        return { valid: false, verdict: VERDICTS.AMOUNT };

    let allowed = await validate.validateSourceAllowed.call(this, data, ctx);
    if(!allowed.valid)
        return allowed;

    let memo = validate.validateMemo.call(this, data);
    if(!memo.valid)
        return memo;

    if(!this.util.hasBalance(ctx.sourceBalance, info['TICK_ID'], data['AMOUNT']))
        return { valid: false, verdict: VERDICTS.INSUFFICIENT_FUNDS };

    return { valid: true, verdict: null, escrow: escrow, dest: dest };
}

/**
 * Stamp what the hub signs and fill the LOCK's ledger plan. Runs only once every field
 * check above has passed, so it can neither refuse nor read.
 *
 * Called with the handler as `this`.
 *
 * @param {Object} data   - the action row; writes DECIMALS, MIN_DEPTH, DEST_CHAIN
 * @param {Object} ctx    - handler context; writes escrow, credits, debits, sourceBalance
 * @param {Object} info   - the tick's getTokenInfo projection, read at this block
 * @param {string} escrow - the keyless BRIDGE_<DEST_COIN> role address on this chain
 * @param {string} dest   - the validated destination coin
 * @returns {void}
 */
function planLockLedger(data, ctx, info, escrow, dest){

    // The lock stamps what the hub will sign and what the federation will wait for, as
    // read at THIS block. DECIMALS is signed into the transfer record; MIN_DEPTH is
    // not signed at all, it is carried beside the pending row so each validator's own
    // poll applies max(platform depth, min_depth) without re-reading the origin row.
    data['DECIMALS']   = info['DECIMALS'];
    data['MIN_DEPTH']  = (info['MIN_DEPTH'] && this.util.isNumeric(info['MIN_DEPTH'])) ? parseInt(info['MIN_DEPTH']) : 0;
    data['DEST_CHAIN'] = String(dest);

    // Ledger effect: the units leave the source and sit in the keyless escrow on this
    // chain. No escrow ROW is written - the escrow is an ordinary balance at a protocol
    // role address - so the escrow journal's totality contract is untouched, and the
    // held units reconcile in db.sanityCheck and ride balances_root for free.
    ctx.escrow = escrow;
    this.util.addAddressTicker(escrow, ctx.tick);
    ctx.debits.push([ctx.tick, data['AMOUNT'], data['SOURCE']]);
    ctx.credits.push([ctx.tick, data['AMOUNT'], escrow]);

    // Reduce the in-memory balance so the protocol fee, which on BTC is paid out of
    // this same XCHAIN balance for a v0 lock, cannot be covered by units this lock
    // already moved.
    ctx.sourceBalance = this.util.debitBalances(ctx.sourceBalance, info['TICK_ID'], data['AMOUNT']);
}

/**
 * Apply a BURN: v1 (XCHAIN, every chain except BTC) and v4 (a bridged row, on the
 * chain holding the copy).
 *
 * EFFECT, identical for both versions:
 *   debit(SOURCE, tick, AMOUNT)
 *   token SUPPLY -= AMOUNT on THIS chain (the DESTROY supply path)
 * Fee: XBRIDGE_BASE, 5,000 gas, paid in native coin off BTC, which on LTC and DOGE
 * means a fee output that clears the chain's dust threshold - the sizing SWEEP_BASE was
 * chosen for.
 *
 * The burn lowers only the LOCAL chain's supply. MAX_SUPPLY binds on the origin chain
 * only: a foreign chain's supply is a shadow of the origin escrow and is never counted
 * against the cap.
 *
 * Called with the handler as `this`.
 *
 * @param {Object} data - the action row. Reads FORMAT, SOURCE, TICK (v4 only),
 *                        BTC_ADDRESS (v1) or ORIGIN_ADDRESS (v4), AMOUNT, MEMO,
 *                        BLOCK_INDEX, BLOCK_TIME, ACTION_INDEX; writes STATUS
 * @param {Object} ctx  - handler context: { coin, network, blockTime, tokenInfo,
 *                        sourceBalance }
 * @returns {Promise<{valid: boolean, verdict: (string|null)}>} verdict is one of
 *          VERDICTS.TICK_NOT_BRIDGED, BTC_ADDRESS, ORIGIN_ADDRESS, AMOUNT,
 *          INSUFFICIENT_FUNDS, or null when the burn applies
 */
async function applyBurn(data, ctx){

    let info = ctx.tokenInfo;

    if(!info)
        return { valid: false, verdict: v.TICK_UNKNOWN };

    let destination = resolveBurnDestination.call(this, data, ctx, info);
    if(!destination.valid)
        return destination;

    if(this.util.isNull(data['AMOUNT']) ||
       !this.util.isValidAmountFormat(info['DECIMALS'], data['AMOUNT'], ctx.blockTime) ||
       !this.util.bcgt(data['AMOUNT'], 0))
        return { valid: false, verdict: VERDICTS.AMOUNT };

    let allowed = await validate.validateSourceAllowed.call(this, data, ctx);
    if(!allowed.valid)
        return allowed;

    let memo = validate.validateMemo.call(this, data);
    if(!memo.valid)
        return memo;

    if(!this.util.hasBalance(ctx.sourceBalance, info['TICK_ID'], data['AMOUNT']))
        return { valid: false, verdict: VERDICTS.INSUFFICIENT_FUNDS };

    data['DECIMALS']  = info['DECIMALS'];
    data['MIN_DEPTH'] = 0;

    // Ledger effect: a debit with no offsetting credit. updateTokens then recomputes
    // this chain's SUPPLY from the ledger (credits - debits + escrows), which is the
    // DESTROY supply path verbatim. Only the LOCAL supply moves: a foreign chain's
    // supply is a shadow of the origin escrow, and MAX_SUPPLY binds on the origin only.
    ctx.debits.push([ctx.tick, data['AMOUNT'], data['SOURCE']]);
    ctx.sourceBalance = this.util.debitBalances(ctx.sourceBalance, info['TICK_ID'], data['AMOUNT']);

    return { valid: true, verdict: null };
}

/**
 * Where a BURN redeems, and whether the row it names may be burned at all. v4 answers
 * from the bridged copy's owner and the origin chain's address parameters; v1 always
 * redeems to BTC. Both stamp DEST_CHAIN, which the hub reads off the action row.
 *
 * For v4 the origin chain is the tick's prefix (<ORIGIN>.<NAME>) and ORIGIN_ADDRESS is
 * validated against it with isCryptoAddress(address, origin, network); a v4 on a native
 * row is TICK_NOT_BRIDGED. Removing a chain from an origin row's BRIDGE_CHAINS stops
 * new locks and never blocks a burn, so an issuer can close a door but never strand
 * anyone.
 *
 * Called with the handler as `this`.
 *
 * @param {Object} data - the action row; reads FORMAT, BTC_ADDRESS or ORIGIN_ADDRESS,
 *                        writes DEST_CHAIN
 * @param {Object} ctx  - handler context; reads coin, network, origin
 * @param {Object} info - the tick's getTokenInfo projection, read at this block
 * @returns {{valid: boolean, verdict: (string|null)}}
 */
function resolveBurnDestination(data, ctx, info){

    let format = data['FORMAT'];

    if(format === 4){
        // The copy must be owned by THIS chain's keyless bridge role address for the
        // origin chain. A row with the right shape but another owner is a squatted name
        // that predates the reserved-root guard, not a bridged copy, and burning it
        // would lower a supply no escrow backs.
        let owner = (this.config['ADDRESS'] || {})['BRIDGE_' + String(ctx.origin)];
        if(this.util.isNull(owner) || String(info['OWNER']) !== String(owner))
            return { valid: false, verdict: VERDICTS.TICK_NOT_BRIDGED };

        // ORIGIN_ADDRESS is where the escrow releases on the origin chain, so it is
        // validated against the ORIGIN's address parameters, not this chain's.
        if(!this.util.isCryptoAddress(data['ORIGIN_ADDRESS'], String(ctx.origin), ctx.network))
            return { valid: false, verdict: VERDICTS.ORIGIN_ADDRESS };

        data['DEST_CHAIN'] = String(ctx.origin);
    } else {
        // v1 always redeems to BTC: XCHAIN's escrow is the BTC-side role address.
        if(!this.util.isCryptoAddress(data['BTC_ADDRESS'], 'BTC', ctx.network))
            return { valid: false, verdict: VERDICTS.BTC_ADDRESS };

        data['DEST_CHAIN'] = 'BTC';
    }

    return { valid: true, verdict: null };
}

module.exports = {
    applyLock,
    applyBurn
};
