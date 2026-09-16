/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Platform - DEPLOY: gas settlement, execution record and ledger
 *
 * The deployment's last steps: the gas actually charged (nested refunds and
 * the deferred split applied), the contract_executions row, and the single
 * ledger write with balances, token supply and mappings. A part of
 * actions/deploy/index.js, run by runDeployment after the constructor's
 * effects.
 *
 ********************************************************************/

/**
 * Settle the gas charged: refund unused nested reservations, split off a deferred base.
 *
 * @param {Deploy} deploy  the DEPLOY handler (config, util)
 * @param {object} run     the deployment's run state (mutated: totalGas, fee, chargedGas)
 */
function settleGas(deploy, run){
    // Refund unused cross-contract reservations from constructor emissions
    // (mirrors actions/execute/index.js gas settlement; no-op when no emit.execute).
    if(run.nestedGasUnused > 0){
        run.totalGas = Math.max(0, run.totalGas - run.nestedGasUnused);
        run.fee = deploy.util.bcmul(run.totalGas, deploy.config['GAS_PRICE'], 8);
    }

    // The deferred deployment's split, applied to both halves of the same number: a deferred deployment's base
    // component was charged at the assembler, so this action charges - and records as
    // gas_used - only the constructor gas it actually ran. A's base plus C's constructor
    // therefore sum to the single charge an inline deploy of the same source pays, and each
    // row's gas_used equals the debit written beside it. Identical to totalGas inline.
    run.chargedGas = run.skipBaseFee ? Math.max(0, run.totalGas - run.gasCost) : run.totalGas;
    run.fee = deploy.util.bcmul(run.chargedGas, deploy.config['GAS_PRICE'], 8);
}

/**
 * The constructor's contract_executions row.
 *
 * @param {Deploy} deploy  the DEPLOY handler (actions, indexerDb)
 * @param {object} run     the deployment's run state
 */
async function writeExecutionRecord(deploy, run){
    let data = run.data;
    let chargedGas = run.chargedGas;

    // The fee mode is persisted only from the DEPLOY_DEFERRED_ASSEMBLY flag-day, because
    // that is the first block at which anything reads it: a deployment deferred to a later
    // action must charge constructor gas in the mode its assembler already paid the base
    // fee in, and cannot re-derive that from its own transaction. Below the flag-day the
    // column stays NULL so a from-genesis replay writes exactly the row it wrote before.
    let recordFeePaymentMode = await deploy.actions.protocolChanges.isEnabled('DEPLOY_DEFERRED_ASSEMBLY', data['BLOCK_INDEX']);

    // Create execution record
    await deploy.indexerDb.createContractExecution({
        ACTION_INDEX    : data['ACTION_INDEX'],
        CONTRACT_INDEX  : data['ACTION_INDEX'], // contract_index = its own action_index
        CALLER          : data['SOURCE'],
        METHOD_NAME     : 'constructor',
        INPUT_PARAMS    : run.constructorParams || '',
        GAS_USED        : chargedGas,
        GAS_LIMIT       : run.gasLimit || chargedGas,
        STATUS          : run.status,
        // A pending landing is not a failure, so it carries no error detail: the status
        // itself says the group is waiting for its carriers.
        ERROR_MESSAGE   : run.landedPending ? null : (run.error || null),
        EMITTED_COUNT   : run.constructorResult ? run.constructorResult.emittedActions.length : 0,
        BLOCK_INDEX     : data['BLOCK_INDEX'],
        // Consumption marker for a deferred assembly: NULL whenever this action carried its
        // own parameters (an inline deploy, or an assembler whose group was already complete).
        ASSEMBLER_ACTION_INDEX : run.assemblerActionIndex,
        FEE_PAYMENT_MODE       : recordFeePaymentMode ? run.feePaymentMode : null
    });
}

/**
 * The deployment's single ledger write, then balances, token supply and mappings.
 *
 * @param {Deploy} deploy  the DEPLOY handler (util, indexerDb, mapper)
 * @param {object} run     the deployment's run state
 */
async function writeLedger(deploy, run){
    let data = run.data;
    let gas = run.gas;

    // Store the SOURCE and GAS tick in addresses list
    deploy.util.addAddressTicker(data['SOURCE'], gas);

    // Array of credits and debits
    let credits = [],
        debits  = [];

    // Debits this action incurred before the deployment ran (the completing carrier's own
    // gas fee, which it owes whatever the deployment then does). They MUST ride this one
    // write: two ledger writes at a single action_index cannot see each other, so a split
    // would let the second debit an amount the source never had, which drops the ledger
    // supply without moving the balances projection and trips the per-block SanityError.
    for(let pendingDebit of run.pendingDebits)
        debits.push(pendingDebit);

    // Debit gas fee from SOURCE. Mirror the in-memory balance debit above
    // EXACTLY (!error && feePaymentMode === 2). Recording a ledger debit for a
    // rejected deploy (e.g. one rejected for insufficient GAS funds) burns gas
    // the source never had: the ledger supply drops but getAddressBalances only
    // iterates credit ticks, so the debit-only tick is invisible to the balances
    // projection, leaving balance = ledger + 1 and tripping the supply SanityError.
    // (a pending landing is the one status other than 'valid' that still pays: it is an
    // accepted action awaiting its carriers, and it is charged the base fee at A).
    if((!run.error || run.landedPending) && run.tokenInfo && run.feePaymentMode === 2)
        debits.push([gas, run.fee, data['SOURCE']]);

    // Process any transaction ledger changes (credits / debits)
    await deploy.util.processTransactionLedgerChanges(deploy.indexerDb, data, credits, debits);

    // Get a list of tickers & addresses
    let tickers   = deploy.util.getTickersList(),
        addresses = Object.keys(deploy.util.getAddressesList());

    // Update address balances and token supply
    await deploy.indexerDb.updateBalances(addresses);
    await deploy.indexerDb.updateTokens(tickers);

    // Create action mappings
    await deploy.mapper.createMappings(data);
}

module.exports = { settleGas, writeExecutionRecord, writeLedger };
