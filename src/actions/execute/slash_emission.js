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
 * XChain Slash Emission Writer
 *
 * Why this module exists: the writer below was a private method on
 * actions/execute, and actions/deploy ran a constructor's SLASH emissions
 * through it by reaching into the live Execute instance
 * (this.actions.actionExecute._processSlashEmission). That made one action
 * depend on another action's private surface, so a change inside execute
 * could break deploy with nothing naming the coupling. The writer is protocol
 * behaviour shared by the two VM entry points (a top-level EXECUTE and a
 * DEPLOY constructor), not execute's own, so it lives here and both require it.
 *
 * It is called with the action handler as `this` (handler.call / .apply): the
 * body reads this.indexerDb, this.util and this.config, and every handler
 * aliases those three from the same loader instance in its constructor, so the
 * rows written, their order and their arguments do not depend on which handler
 * runs it.
 *
 ********************************************************************/

'use strict';

const slashLedgerConsolidation = require('../../slash_ledger_consolidation_activation.js');

// Process a SLASH emission from inside the VM. The emission carries:
//   { action: 'SLASH', params: { contractIndex, pubkey, token, amount } }
// Authorization is implicit: the gateway's contractStakeData accessor is scoped
// to the executing contract, so SLASH can only target stakes against that contract.
// We still defense-in-depth verify contractIndex matches data['CONTRACT_ACTION_INDEX'].
//
// Side effects (all inside the surrounding vm_execute savepoint):
//   1. Deduct `amount` from contract_stakes (LIFO) then contract_unstakes.
//   2. Credit the slashed amount to contracts.slash_destination_id (BURN or configured).
//   3. Write a slash_events row keyed by execution_index for audit + wallet UX.
//   4. Accumulate this execution's slash ledger totals in `slashLedger` so a second
//      same-token slash adds to the first instead of overwriting it (see the
//      running-total note below and slash_ledger_consolidation_activation.js).
async function processSlashEmission(emission, data, slashPosition, slashLedger){
    let p = emission.params || {};
    let contractIndex = Number(p.contractIndex);
    let pubkey        = String(p.pubkey || '').toLowerCase();
    let token         = String(p.token || '');
    let amount        = String(p.amount || '0');

    // Defense in depth: caller mismatch should never happen if the gateway
    // closure is sourced correctly, but throw if it does (rolls back the savepoint).
    if(contractIndex !== Number(data['CONTRACT_ACTION_INDEX']))
        throw new Error('SLASH emission contractIndex mismatch: ' + contractIndex + ' vs ' + data['CONTRACT_ACTION_INDEX']);

    // Load contract row to fetch slash_destination_id (locked at DEPLOY time)
    let contractInfo = await this.indexerDb.getContract(contractIndex);
    if(!contractInfo)
        throw new Error('SLASH: contract not found: ' + contractIndex);
    if(contractInfo.slash_destination_id === null || contractInfo.slash_destination_id === undefined)
        throw new Error('SLASH: contract has no slash destination configured');

    // Resolve FKs
    let pubkeyId = await this.indexerDb.getPubkeyId(pubkey);
    if(pubkeyId === null){
        // pubkey is not known to index_pubkeys at all: not staked anywhere on this
        // chain. Nothing to deduct; log for auditability so the no-op is visible.
        console.log('\t SLASH (no-op): pubkey not found in index_pubkeys: ' + pubkey +
            ' contract=' + contractIndex + ' token=' + token);
        return;
    }
    let tickId = await this.indexerDb.getTickerId(token);
    if(tickId === null){
        // token is unknown. Nothing to deduct; log for auditability.
        console.log('\t SLASH (no-op): token not found: ' + token +
            ' pubkey=' + pubkey + ' contract=' + contractIndex);
        return;
    }

    // Deduct (returns actual slashed total; may be less than requested if balance lower).
    // Pass BLOCK_INDEX so Pass 1 slashes only still-active stake; unstaked-but-cooling tokens are
    // slashed from contract_unstakes (Pass 2), preventing the double-count / supply inflation.
    let deduction = await this.indexerDb.slashContractStake(contractIndex, pubkeyId, tickId, amount, parseInt(data['BLOCK_INDEX']), data['ACTION_INDEX'], slashPosition);
    let slashed   = deduction.total;
    if(!this.util.bcgt(slashed, '0')){
        // pubkey + token exist but no active stake on this contract to deduct.
        // Log the attempted vs actual amounts so the no-op is visible in the audit trail.
        console.log('\t SLASH (no-op): zero slashed (no active stake): pubkey=' + pubkey +
            ' token=' + token + ' requested=' + amount + ' contract=' + contractIndex);
        return;
    }

    // Credit destination address (BURN or user-specified)
    // getAddressById issues this same lookup and already answers null for a missing row,
    // so no second copy of it is minted here; the throw stays because a SLASH with no
    // destination row must halt rather than credit nowhere.
    let destAddress = await this.indexerDb.getAddressById(contractInfo.slash_destination_id);
    if(destAddress === null)
        throw new Error('SLASH: destination address row missing');

    // Release the escrow the stake was locked in BEFORE crediting the destination: a
    // contract stake LOCKS its tokens, so the credit below redirects them rather than
    // minting them, and supply falls only by what the destination does not receive.

    // Per owner: the deduction walks several rows and a delegated key's rows can span
    // sources. Written under the EXECUTE's action_index, which escrowJournalWriter
    // attributes through its EXECUTE rule.
    //
    // The amount passed is this EXECUTION's RUNNING TOTAL for (tick, address), not this
    // emission's share: createLedgerChangeRecord keys on (action_index, address_id,
    // tick_id) and its existing-row branch SETs the amount, so handing it the share
    // would silently erase the earlier slash's row. Graduated penalties are documented
    // as repeated slash calls (protocol/contract-staking.md), so that collision is the
    // normal path, not a corner case. Gated: it changes stored ledger amounts.
    let consolidate = slashLedgerConsolidation.isSlashLedgerConsolidationActive(
        data['BLOCK_INDEX'], this.config['NETWORK'], this.config['COIN']) && slashLedger;
    // Keyed on tickId, never on the wire spelling. createLedgerChangeRecord
    // collides on (action_index, address_id, TICK_ID), so the running total
    // has to merge over exactly what collides: two spellings that resolve to
    // one tick_id (a case variant, a caret ref) key two buckets, each total
    // is short, and the later write erases the earlier row anyway. tickId is
    // the resolved id from the getTickerId call above.
    let runningTotal = (bucket, key, amount, scale) => {
        if(!consolidate) return amount;
        let sum = this.util.bcstr(this.util.bcadd(bucket.get(key) || '0', amount, scale));
        bucket.set(key, sum);
        return sum;
    };
    for(let r of deduction.releases){
        let release = this.util.bcsub(0, r.amount, 64);
        release = runningTotal(slashLedger && slashLedger.escrows, tickId + '\t' + r.address, release, 64);
        await this.indexerDb.createEscrow(data['ACTION_INDEX'], token, release, r.address);
        this.util.addAddressTicker(r.address, token);
    }

    // Write credit row (action_index = the EXECUTE's action_index, for audit trail)
    let credited = runningTotal(slashLedger && slashLedger.credits, tickId + '\t' + destAddress, slashed, 64);
    await this.indexerDb.createCredit(data['ACTION_INDEX'], token, credited, destAddress);

    // Track destination + token for balance reconciliation in the surrounding execute()
    this.util.addAddressTicker(destAddress, token);

    // Write the slash event row
    await this.indexerDb.createSlashEvent({
        EXECUTION_INDEX:       data['ACTION_INDEX'],
        TARGET_CONTRACT_INDEX: contractIndex,
        SIGNING_PUBKEY_ID:     pubkeyId,
        TICK_ID:               tickId,
        AMOUNT:                slashed,
        DESTINATION_ID:        contractInfo.slash_destination_id,
        BLOCK_INDEX:           data['BLOCK_INDEX']
    });
}
module.exports = { processSlashEmission };
