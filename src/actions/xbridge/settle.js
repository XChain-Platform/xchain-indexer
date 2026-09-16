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
 * What an XBRIDGE row leaves behind once every guard has answered: the verdict on
 * the row, the fields the lock stamps for the hub, the xbridges action record, and
 * (only for a valid action) the ledger effect, the balance and supply refresh and
 * the first v3 lock's `bridged` bit.
 *
 * This runs for a REFUSED action too, which is why it is one function rather than a
 * branch inside the valid path: every user-broadcast XBRIDGE records its own row so
 * the hub's poll and the pending read see what was asked for, valid or not.
 *
 * Called with the handler as `this`, the way execute/slash_emission.js is.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability/index.js');

/**
 * Write the verdict, record the action row, and apply the ledger effect of a valid
 * lock or burn.
 *
 * @param {Object}      data    - the action row; writes STATUS and the stamped fields
 * @param {Object}      xbridge - the raw wire clone that becomes the xbridges row
 * @param {Object}      ctx     - handler context; reads tick, credits, debits
 * @param {Object|null} fees    - the fee object parse() built, or null when the action
 *                                was refused before the fee was charged
 * @param {number}      format  - the version byte, for the log line and the v3 bit
 * @param {string|null} error   - the verdict a guard reached, or null for a valid action
 * @returns {Promise<void>}
 */
async function recordAndSettle(data, xbridge, ctx, fees, format, error){

    let status = (error) ? error : 'valid';
    data['STATUS'] = xbridge['STATUS'] = status;

    // Fields the lock stamps onto its OWN row, as read at its OWN block: the hub signs
    // `decimals` into the transfer record, and applies max(platform depth, min_depth)
    // from the stamped value rather than re-reading the origin row at poll time, so a
    // later format 7 edit can never make an accepted lock un-signable and two
    // followers can never disagree. Carried on the invalid row too,
    // so the record says what the action asked for.
    xbridge['DECIMALS']  = data['DECIMALS'];
    xbridge['MIN_DEPTH'] = data['MIN_DEPTH'];
    xbridge['DEST_CHAIN']= data['DEST_CHAIN'];

    getLogger().info("\t XBRIDGE v" + format + " : " + ctx.tick + ' : ' + this.util.logAmount(data['AMOUNT']) +
                ' : ' + (data['DEST_CHAIN'] || ctx.origin || '') + ' : ' + status);

    // MISSING WRITER 1 (see the file header): the xbridges table and this method do
    // not exist yet. The call is unconditional on purpose, because a handler that
    // silently skips its own record is worse than one that fails loudly, and because
    // the hub's poll and the pending read are both built on this row.
    await this.indexerDb.createXbridge(xbridge);

    // Register the SOURCE so the action is findable by address even when it was
    // refused. The tick is only attached when this action got far enough to resolve
    // one: addAddressTicker records the address either way, and passing undefined is
    // what keeps a null out of the tickers list an invalid refusal would otherwise add.
    this.util.addAddressTicker(data['SOURCE'], this.util.isNull(ctx.tick) ? undefined : ctx.tick);

    if(status == 'valid')
        await applyValidEffect.call(this, data, ctx, fees, format);

    await this.mapper.createMappings(data);
}

/**
 * The ledger side of a valid lock or burn: the fee, the credits and debits the apply
 * method planned, then the balance and supply refresh the pair implies.
 *
 * @param {Object} data   - the action row
 * @param {Object} ctx    - handler context; reads credits, debits, tick
 * @param {Object} fees   - the fee object parse() built
 * @param {number} format - the version byte; v3 also sets the origin row's bridged bit
 * @returns {Promise<void>}
 */
async function applyValidEffect(data, ctx, fees, format){

    let credits = ctx.credits,
        debits  = ctx.debits;

    if(this.util.bcgt(fees['AMOUNT'], 0))
        this.util.addAddressTicker(data['SOURCE'], fees['TICK']);

    [credits, debits] = await this.util.processTransactionFees(this.indexerDb, credits, debits, fees);

    await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

    let tickers   = this.util.getTickersList(),
        addresses = Object.keys(this.util.getAddressesList());

    // updateTokens is what lowers the burned token's SUPPLY: a burn is a debit with
    // no offsetting credit, and supply is recomputed from the ledger
    // (credits - debits + escrows), the DESTROY supply path verbatim.
    await this.indexerDb.updateBalances(addresses);
    await this.indexerDb.updateTokens(tickers);

    // MISSING WRITER 2 (see the file header): the first applied v3 sets the origin row's
    // `bridged` bit, which is never cleared, so emptying
    // BRIDGE_CHAINS after bridging cannot reopen the policy door while copies are
    // outstanding on another chain.
    if(format === 3)
        await this.indexerDb.setTokenBridged(ctx.tick, data['BLOCK_INDEX']);
}

module.exports = {
    recordAndSettle
};
