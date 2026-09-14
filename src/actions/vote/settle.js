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
 * XChain Platform Action - VOTE : settlement
 *
 * The GAS a poll holds: a valid create (v0) writes the poll row and locks the
 * creator's DEPOSIT plus GAS_ESCROW as one escrow, and finalization (v2)
 * releases it, refunding or forfeiting the deposit by outcome. Called with the
 * VOTE handler as `this` (see ../vote.js).
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability/index.js');

// VOTE v0 phase - settlement: stamp the status, write the poll row when valid, lock the
// creator's combined GAS hold and record the action mappings.
async function settleCreatePoll(data, error, deposit){
    let gas = this.config['GAS'];

    // Determine final status
    let status = (error) ? error : 'valid';
    data['STATUS'] = status;

    getLogger().info("\t VOTE create : " + data['TICK'] + ' : ' + data['STATUS']);

    // Persist the poll only when valid; an invalid create writes no poll row
    // (the action itself is still recorded in `actions` with its status)
    if(!error)
        await this.indexerDb.createPoll(data);

    // Escrow the creator's locked GAS (deposit + any binding-poll gas_escrow)
    // at this v0 action_index; released by VOTE v2 finalize. One combined escrow
    // row (both are GAS from SOURCE); v2 routes the credits per kind. Same generic
    // ledger path as ATTEST's fee escrow, so rollback deletes by action_index.
    let lockTotal = this.util.bcadd(deposit, data['GAS_ESCROW'], 8);
    if(!error && this.util.bcgt(lockTotal, 0)){
        this.util.addAddressTicker(data['SOURCE'], gas);
        let debits  = [[gas, lockTotal, data['SOURCE']]];
        let escrows = [[gas, lockTotal, data['SOURCE']]];
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, [], debits, escrows);
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);
    }

    // Store the SOURCE/TICK in addresses+tickers list, create action mappings
    this.util.addAddressTicker(data['SOURCE'], data['TICK']);
    await this.mapper.createMappings(data);
}

// Release a poll's creation deposit at finalization. Refunds the escrowed GAS to
// the creator on a real outcome ('finalized'), or forfeits it to the DONATE1
// treasury when the poll dies for lack of participation ('failed_quorum'). A
// negative escrow row releases the hold (the order_expire / attest_settle
// idiom); the matching credit routes the funds. No-op when the poll carried no
// deposit. deposit_resolved records the outcome so a reprocessed finalize
// cannot double-release.
async function settleDeposit(poll, data, terminalStatus){
    let deposit   = String((poll && poll.deposit_amount) || '0');
    let gasEscrow = String((poll && poll.gas_escrow) || '0');
    let held      = this.util.bcadd(deposit, gasEscrow, 8); // combined v0 escrow
    if(!this.util.bcgt(held, '0')) return;
    if(!this.util.isNull(poll.deposit_resolved)) return; // already released

    let creator = await this.indexerDb.getAddressById(poll.deposit_address_id);
    if(this.util.isNull(creator)){
        getLogger().warn('\t VOTE escrow : missing creator for poll ' + poll.action_index + ', escrow left held');
        return;
    }

    let gas       = this.config['GAS'];
    let refunded  = (terminalStatus !== 'failed_quorum');
    // Release the whole v0 hold (one negative escrow row) and route the credits:
    // the deposit refunds the creator on a finalized win or forfeits to DONATE1 on
    // failed_quorum; the gas_escrow ALWAYS refunds the creator (the callback's
    // backing, not at risk). Precise gas-cost metering is deferred (ATTEST parity).
    let escrows = [[gas, this.util.bcmul(held, '-1', 8), creator]];
    let credits = [];
    this.util.addAddressTicker(creator, gas);
    if(this.util.bcgt(deposit, '0')){
        let depTarget = refunded ? creator : this.config['ADDRESS']['DONATE1'];
        this.util.addAddressTicker(depTarget, gas);
        credits.push([gas, deposit, depTarget]);
    }
    if(this.util.bcgt(gasEscrow, '0'))
        credits.push([gas, gasEscrow, creator]);

    await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, [], escrows);
    let tickers   = this.util.getTickersList(),
        addresses = Object.keys(this.util.getAddressesList());
    await this.indexerDb.updateBalances(addresses);
    await this.indexerDb.updateTokens(tickers);
    await this.indexerDb.setPollDepositResolved(poll.action_index, refunded ? 'refunded' : 'forfeited');

    getLogger().info("\t VOTE escrow : poll " + poll.action_index + ' released ' + held + ' ' + gas +
                ' (deposit ' + deposit + (refunded ? ' refund' : ' forfeit') + ', gas_escrow ' + gasEscrow + ' refund)');
}

module.exports = { settleCreatePoll, settleDeposit };
