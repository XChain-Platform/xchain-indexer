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
 * ISSUE TICK validations: the name's shape and parent, its characters, the caret id
 * form, the length and delimiter rules, the reserved list and the GAS tick's two
 * restrictions, in the order the handler has always applied them.
 *
 * Each function runs with `this` bound to the Issue handler (./index.js calls each as
 * fn.call(this, ctx)); it reads the verdict from ctx.error, applies its rules only
 * while no verdict is set, and writes the verdict and anything later rules need back.
 *
 ********************************************************************/

'use strict';

// The BATCH_ISSUANCE_LIMITS flag, then the null, period, parent/child and character
// rules. Leaves ctx.str, ctx.parent and ctx.parentInfo for the rules after it.
async function validateTickName(ctx){
    let { data, allowedCharacters, tickCharacters } = ctx;
    let error = ctx.error;

    // BATCH_ISSUANCE_LIMITS: governs both the caret-dot TICK rejection below and
    // the ticker-intern gating on every getTokenInfo call in this action (for the latter,
    // see gatedGetTokenInfo). Computed once, early, so every consumer below sees the
    // same activation state for this action's BLOCK_INDEX.
    // Both are consensus tightenings: below the flag every historical verdict
    // (including the two defects it closes) must replay identically from genesis.
    let batchIssuanceLimitsV2 = await this.actions.protocolChanges.isEnabled('BATCH_ISSUANCE_LIMITS', data['BLOCK_INDEX']);

    // TICK Validations

    // Verify TICK is not null/empty
    if(!error && this.util.isNull(data['TICK']))
        error = 'invalid: TICK (null)';

    // Verify TICK does not begin or end with period (.)
    let str = String(data['TICK']);
    if(!error && (str.substring(0,1)=='.' || str.slice(-1)=='.'))
        error = 'invalid: TICK (period)';

    // Determine if this is a parent/child issuance using full TICK name
    let parts      = String(data['TICK']).split('.');
    let parent     = false;
    let parentInfo = false;
    if(parts.length>1){
        parent = parts.slice(0,-1).join('.');

        // Get information on parent TICK
        parentInfo = await this.parentGetTokenInfo(parent, data['BLOCK_INDEX'], data['ACTION_INDEX'], batchIssuanceLimitsV2);

        // Verify parent TICK exists
        if(!error && !parentInfo)
            error = 'invalid: TICK (parent unknown)';

        // Verify ISSUE is coming from PARENT TICK owner
        if(!error && parentInfo && parentInfo['OWNER']!=data['SOURCE'])
            error = 'invalid: TICK (parent issued by another address)';

        // Reject child issuance while the parent's ownership is escrowed in an open offer.
        // Genesis has no escrows (the escrows table is empty during bootstrap), so the
        // check is a guaranteed false; skip the read.
        if(!error && parentInfo && !data['IS_GENESIS'] && await this.indexerDb.isOwnershipEscrowed(parent))
            error = 'invalid: TICK (parent ownership escrowed)';
    }

    // Verify TICK contains only allowed characters
    for(let char of tickCharacters){
        if(!error && !allowedCharacters.includes(char))
            error = 'invalid: TICK (character)';
    }

    Object.assign(ctx, { error, batchIssuanceLimitsV2, str, parent, parentInfo });
}

// The caret id form, the length range and the two delimiter rules. Leaves ctx.len.
function validateTickForm(ctx){
    let { data, str, batchIssuanceLimitsV2 } = ctx;
    let error = ctx.error;

    // Verify any TICK ID given is valid tick ID
    let tid = str.substring(1); // Possible TICK ID (everything after the ^ prefix)
    if(!error && str.substring(0,1)=='^' && !this.util.isNumeric(tid))
        error = 'invalid: TICK (id)';

    // Caret rule: isNumeric() is parseFloat-based, so a caret
    // tail containing '.' (e.g. "^12.5" or "^1.0") reads as a number and slips past the
    // check above, landing a status=valid ISSUE with a NULL ticker id (createTicker
    // never inserts a literal "^..." row - see db.js createTicker). Because the TICK
    // also contains a '.', it ALSO trips the parent/child split above, so such a tick
    // can masquerade as a child issuance; that is why batch.js's dotted-TICK exemption
    // classifier refuses to exempt ANY caret TICK. This is the paired indexer-side
    // rejection. Gated (tightens validity): below the flag the historical (defective)
    // verdict stands, so a from-genesis replay stays byte-identical.
    if(!error && batchIssuanceLimitsV2 && str.substring(0,1)=='^' && tid.indexOf('.')!=-1)
        error = 'invalid: TICK (caret dot)';

    // Verify TICK length is within acceptable range
    let len = String(data['TICK']).length,
        min = parseInt(this.config['MIN_TICK_LENGTH']),
        max = parseInt(this.config['MAX_TICK_LENGTH']);
    if(!error && (len < min || len > max))
        error = 'invalid: TICK (length)';

    // Verify no pipe in TICK (pipe is field delimiter)
    if(!error && String(data['TICK']).indexOf('|')!=-1)
        error = 'invalid: TICK (pipe)';

    // Verify no semicolon in TICK (semicolon is action delimiter)
    if(!error && String(data['TICK']).indexOf(';')!=-1)
        error = 'invalid: TICK (semicolon)';

    Object.assign(ctx, { error, len });
}

// The RESERVED_TICKS list, case-folded. Leaves ctx.tickUpper and ctx.isGasTick.
function validateReservedTick(ctx){
    let { data } = ctx;
    let error = ctx.error;

    // Verify TICK is not on RESERVED_TICKS list.
    //
    // CASE-FOLDED. The list is matched against the UPPER-CASED tick.
    // An exact-case indexOf over a platform where every ticker lookup is LOWER(tick)
    // (db.js) would let `ISSUE btc` through, and getTokenInfo('BTC') would then resolve
    // the squatter's row: one fee could block a whole origin-rooted
    // bridge namespace. Unconditional rather than activation-keyed, because no replay can
    // notice it: measured 2026-09-11 as zero rows for every case variant of the
    // three coin roots on all six live chains and zero in either genesis manifest, so
    // no replayed verdict moves.
    //
    // THE REGTEST EXEMPTION IS THE GAS TICK ALONE. Regtest is the venue the
    // token bridge is first proven on, and the bridge creates the `<ORIGIN>` root
    // row itself, so a coin root squatted on regtest would break the drill the
    // bridge is proven by. The one exemption is the e2e harness's play-money gas
    // self-seed.
    //
    // IS_GENESIS IS EXEMPT: the injected creation of a bridge
    // root row (`BTC` on DOGE) is system-issued through processTransaction(tx, true),
    // the same flag the BTC genesis pass uses. No broadcast action ever carries it, so
    // no historical verdict moves.
    let tickUpper = String(data['TICK']).toUpperCase(),
        gasUpper  = String(this.config['GAS']).toUpperCase(),
        isGasTick = (tickUpper == gasUpper);
    if(!error && !data['IS_GENESIS'] && this.config['RESERVED_TICKS'].indexOf(tickUpper)!=-1 &&
       !(isGasTick && (data['SOURCE']==this.config['ADDRESS']['GAS'] || this.config['NETWORK']=='regtest')))
        error = 'invalid: TICK (reserved)';

    Object.assign(ctx, { error, tickUpper, isGasTick });
}

// The GAS tick: only the GAS address issues it, and it is only ever issued on BTC.
function validateGasTick(ctx){
    let { data, isGasTick } = ctx;
    let error = ctx.error;

    // Verify only GAS address can issue on GAS token
    if(!error && String(data['TICK']).toUpperCase()==this.config['GAS'] && data['SOURCE']!=this.config['ADDRESS']['GAS'] && this.config['NETWORK']!='regtest')
        error = 'invalid: GAS Address';

    // Verify the GAS token (XCHAIN) is only ever issued on BTC. It is the platform gas
    // token but exists as a real, balance-bearing token only on the BTC ledger; on
    // DOGE/LTC fees settle in native coin (XCHAIN is only a unit of account for sizing).
    //
    // BRIDGE-OWNED OFF BTC. Once the bridge exists, every
    // XCHAIN unit on a non-BTC chain is the shadow of an escrow balance held on BTC, so
    // the only thing allowed to create supply there is the mirror's XBRIDGE v2 in-leg.
    // The refusal is therefore UNCONDITIONAL off BTC: from every source including
    // the GAS address, on every network INCLUDING regtest, and it is not keyed on
    // XCHAIN_BRIDGE_ACTIVATION. No off-BTC XCHAIN history exists to replay (outside regtest
    // every broadcast off BTC is refused below the bridge flag as well), so the
    // unconditional rule moves no hash, needs no second activation read, and cannot be
    // mis-ordered against the lazy creation of the off-BTC row.
    //
    // The verdict string is REUSED, not renamed: renaming it to something like
    // 'TICK (bridge-owned)' would change the STATUS of historical refused broadcasts on
    // DOGE and LTC testnet on replay.
    //
    // IS_GENESIS IS EXEMPT: the off-BTC row is created lazily by the first v2
    // in-leg through processTransaction(tx, true), which is system-injected and is the
    // one creation path the bridge itself owns. The e2e harness's play-money self-seed
    // is a GAS-key ISSUE on BTC regtest plus an XBRIDGE v0 lock.
    if(!error && !data['IS_GENESIS'] && isGasTick && this.config['COIN']!='BTC')
        error = 'invalid: TICK (BTC-only)';

    ctx.error = error;
}

module.exports = { validateTickName, validateTickForm, validateReservedTick, validateGasTick };
