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
 * XChain Platform - bridge settle pass: the ledger effects of one transfer leg.
 *
 * The in leg (this chain mints, creating the token row on first use) and the out leg (this chain
 * releases the escrow a lock put here), each returning the credits and debits the settle action
 * writes or the SETTLE_REASON that refuses the row. Split out of transfer.js so neither file
 * passes the 400-line limit; the refusals, their order and the effects are unchanged.
 *
 * Each takes the entry's deps first, like the other parts the entry builds, for the refusal
 * log the entry owns (see bridge_settle.js and bridge_settle/refusal_log.js).
 *
 ********************************************************************/

'use strict';

const Genesis = require('../../chain/genesis.js');
const { SETTLE_REASON, BRIDGE_TX_PREFIX, isNull } = require('./reasons.js');

/**
 * IN leg: this chain MINTS. The token row is created lazily by the first in-leg, which
 * is what keeps genesis byte-identical on every chain.
 *
 * @returns {Promise<{reason: string}|{localTick: string, credits: Array, debits: Array}>}
 */
async function buildInLegEffects(deps, row, ctx, f, amount, gasTick, addresses){
    const { warnOnce } = deps.refusalLog;
    const db = ctx.indexerDb;
    const genesis = new Genesis(ctx.actions, db, ctx.config, ctx.util);
    const injectCtx = { blockIndex: ctx.blockIndex, blockTime: ctx.blockTime, txHashPrefix: BRIDGE_TX_PREFIX };
    let localTick = f.tick;
    if(f.tick === gasTick){
        // The byte-identical injectGasToken parameter set, taken from the ONE place that
        // owns it. Retyping the values here is the drift the helper exists to prevent
        // because a drifted parameter is a different token row, which is a different
        // ledger hash on two chains.
        await genesis.injectProtocolToken(genesis.gasTokenParams(), injectCtx);
        localTick = gasTick;
    } else {
        const owner = addresses['BRIDGE_' + f.srcChain];
        if(isNull(owner))
            return { reason: SETTLE_REASON.ESCROW_MISSING };
        const made = await genesis.injectBridgedToken(
            { origin: f.srcChain, name: f.tick, decimals: f.decimals, owner: owner }, injectCtx);
        if(!made.ok){
            warnOnce('XBRIDGE', f.id, SETTLE_REASON.TOKEN_ROW,
                      SETTLE_REASON.TOKEN_ROW + ': ' + made.reason + ' : skipping');
            return { reason: SETTLE_REASON.TOKEN_ROW };
        }
        localTick = made.tick;
    }
    // A credit with no matching debit is what raises SUPPLY: updateTokens recomputes the
    // token's supply from credits minus debits, the same path MINT takes, so there is no
    // second supply write to keep in step.
    ctx.util.addAddressTicker(String(row.dest_address), localTick);
    return { localTick: localTick, credits: [[localTick, amount, String(row.dest_address)]], debits: [] };
}

/**
 * OUT leg: this chain is the ORIGIN and releases the escrow a lock put there. The
 * escrow is an ordinary balance at the keyless role address for the chain the units
 * were bridged TO, which is the row's src_chain (the burn happened there).
 *
 * @returns {Promise<{reason: string}|{localTick: string, credits: Array, debits: Array}>}
 */
async function buildOutLegEffects(deps, row, ctx, f, amount, addresses){
    const { warnOnce } = deps.refusalLog;
    const db = ctx.indexerDb;
    const localTick = f.tick;
    const escrow = addresses['BRIDGE_' + f.srcChain];
    if(isNull(escrow))
        return { reason: SETTLE_REASON.ESCROW_MISSING };
    const info = await db.getTokenInfo(localTick, ctx.blockIndex);
    if(!info)
        return { reason: SETTLE_REASON.TOKEN_ROW };
    // An escrow that would go NEGATIVE is a protocol violation, not a user error: apply
    // nothing and log exactly one line naming the transfer. A remote checkpoint can add
    // nothing here, because the local ledger IS the authority on a local balance.
    const balances = await db.getAddressBalances(escrow, null, ctx.blockIndex);
    if(!ctx.util.hasBalance(balances, info['TICK_ID'], amount)){
        warnOnce('XBRIDGE', f.id, SETTLE_REASON.ESCROW_SHORT,
                  SETTLE_REASON.ESCROW_SHORT + ' at ' + escrow + ' : skipping');
        return { reason: SETTLE_REASON.ESCROW_SHORT };
    }
    ctx.util.addAddressTicker(escrow, localTick);
    ctx.util.addAddressTicker(String(row.dest_address), localTick);
    return {
        localTick: localTick,
        credits:   [[localTick, amount, String(row.dest_address)]],
        debits:    [[localTick, amount, escrow]]
    };
}

module.exports = { buildInLegEffects, buildOutLegEffects };
