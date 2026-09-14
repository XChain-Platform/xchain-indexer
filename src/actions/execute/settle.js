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
 * XChain Platform Action - EXECUTE : settlement
 *
 * What the run costs and what it leaves behind: the gas clamps every node must
 * agree on, the execution record, and the ledger debit. Runs for every EXECUTE,
 * including one rejected before the VM. Called with the EXECUTE handler as
 * `this` (see ./index.js).
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability/index.js');

// Consensus clamps on the gas this run reports. Both are no-ops when the VM
// honours the ceiling it was given; they exist so a VM regression cannot make
// the fee diverge between validators.
function clampVmGas(ctx){
    // Defense-in-depth (consensus): resource terminations report a gasUsed
    // captured at a machine-/GC-/stack-/timing-dependent point. The VM already
    // clamps these to the ceiling, but clamp here too so a VM regression (or an
    // older bundled VM) can never make fee = gasUsed * GAS_PRICE diverge across
    // validators and fork. The family regex MUST stay identical to util.vmFailureStatus
    // (out_of_gas is included so the two regexes never drift; it is a no-op for the
    // fee since out_of_gas already reports gasUsed == ceiling). The clamp target is
    // this run's OWN ceiling: for a cross-contract callee that is its caller-funded
    // reservation, not the protocol ceiling (a 1M clamp against a 50k reservation
    // would diverge the parent's refund settlement).
    if(ctx.vmFailed && /^(out_of_gas|timeout|out_of_memory|out_of_stack|out_of_resource)\b/.test(String(ctx.vmError))){
        ctx.gasUsed = ctx.execCeiling;
    }

    // ...and enforce the same ceiling on EVERY path, success included. The clamp above
    // only fires for a resource TERMINATION, but a SUCCESS result carries the VM's
    // gasUsed verbatim, and the tracker adds a charge to `used` before deciding whether
    // it exhausted the limit, so a swallowed charge-site throw returns success with
    // gasUsed a charge over the ceiling. Unclamped that bills a caller-funded run past
    // its own reservation and, for a cross-contract callee, makes VM_GAS_UNUSED_SUBTREE
    // below under-refund the parent. Same shape runControllerGuard already settles on
    // (Math.min against guardCeiling), and a no-op whenever the VM honours the ceiling:
    // the pre-VM value here is VM_EXECUTE_BASE, which is below MIN_CALL_GAS, the floor
    // every reservation is validated against. execCeiling, never GAS_CEILING: clamping a
    // callee to the protocol ceiling would diverge the parent's refund settlement.
    ctx.gasUsed = Math.min(ctx.gasUsed, ctx.execCeiling);
}

function settleGasFee(ctx){
    let data = ctx.data;

    // Gas settlement. gasBilled = this run's metered usage minus the unused
    // reservations refunded by its completed callees. By induction each
    // callee's gasUnusedSubtree already nets ITS children, so subtracting the
    // direct children here settles the whole subtree. Bounds (now enforced above,
    // not merely assumed): 0 <= gasBilled <= gasUsed <= execCeiling.
    ctx.gasBilled = Math.max(0, ctx.gasUsed - ctx.nestedGasUnused);

    // Recalculate fee based on billed gas
    ctx.fee = this.util.bcmul(ctx.gasBilled, this.config['GAS_PRICE'], 8);

    // Surface this run's unused reservation to the parent processEmission
    // (only meaningful when this parse IS a cross-contract callee).
    if(data['IS_EMISSION'] && Number.isInteger(data['VM_GAS_LIMIT']))
        data['VM_GAS_UNUSED_SUBTREE'] = Math.max(0, ctx.execCeiling - ctx.gasBilled);
}

async function recordExecution(ctx){
    let data = ctx.data;

    // Determine final status
    let status = ctx.error ? ctx.error : (ctx.vmStatus || 'valid');
    data['STATUS'] = status;

    // Surface the run outcome for system injectors (the XEXEC handler relays
    // these to the source chain as the cross-chain call result). Consensus-safe:
    // all three are deterministic products of the run.
    data['VM_RETURN_VALUE']  = (status === 'valid') ? ctx.vmReturnValue : null;
    data['VM_ERROR_MESSAGE'] = ctx.error || ctx.vmError || null;
    data['VM_GAS_BILLED']    = ctx.gasBilled;

    // Print status message
    getLogger().info("\t EXECUTE : contract=" + data['CONTRACT_ACTION_INDEX'] + ' : method=' + data['METHOD'] + ' : gas=' + ctx.gasBilled + ((Number(data['CALL_DEPTH']) || 0) > 0 ? ' : depth=' + data['CALL_DEPTH'] : '') + ' : ' + data['STATUS']);

    // Create execution record. GAS_USED is the BILLED gas (metered usage net
    // of callee refunds); GAS_LIMIT is this run's ceiling (the caller-funded
    // reservation for a cross-contract callee, the protocol ceiling otherwise).
    await this.indexerDb.createContractExecution({
        ACTION_INDEX    : data['ACTION_INDEX'],
        CONTRACT_INDEX  : data['CONTRACT_ACTION_INDEX'],
        CALLER          : data['SOURCE'],
        METHOD_NAME     : data['METHOD'],
        INPUT_PARAMS    : data['METHOD_PARAMS'],
        GAS_USED        : ctx.gasBilled,
        GAS_LIMIT       : ctx.execCeiling,
        STATUS          : status,
        ERROR_MESSAGE   : ctx.error || ctx.vmError || null,
        EMITTED_COUNT   : ctx.emittedCount,
        BLOCK_INDEX     : data['BLOCK_INDEX']
    });
}

async function applyLedgerChanges(ctx){
    let data = ctx.data;

    // Store the SOURCE and GAS tick in addresses list
    this.util.addAddressTicker(data['SOURCE'], ctx.gas);

    // Array of credits and debits
    let credits = [],
        debits  = [];

    // Debit gas fee from SOURCE. Mirror the in-memory balance debit's condition
    // EXACTLY (!error && !skipFee && feePaymentMode === 2). A failed VM run (revert /
    // out_of_gas / timeout) leaves `error` null (it sets vmError + a dedicated vmStatus),
    // so the "caller pays for a failed attempt" case still debits. The source is known to
    // hold GAS credits here (it passed the pre-VM balance check), so the debit stays
    // ledger/balance-consistent even if it drives the balance negative. But an EXECUTE
    // rejected before the VM ran
    // (insufficient GAS funds / inactive contract / sleeping source) sets `error`
    // and must NOT record a ledger debit: burning gas the source never had drops
    // ledger supply while getAddressBalances (which only iterates credit ticks)
    // leaves the balances projection unchanged (balance = ledger + 1, SanityError).
    if(!ctx.error && !ctx.skipFee && ctx.tokenInfo && ctx.feePaymentMode === 2)
        debits.push([ctx.gas, ctx.fee, data['SOURCE']]);

    // Process any transaction ledger changes (credits / debits)
    await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);

    // Get a list of tickers & addresses
    let tickers   = this.util.getTickersList(),
        addresses = Object.keys(this.util.getAddressesList());

    // Update address balances and token supply
    await this.indexerDb.updateBalances(addresses);
    await this.indexerDb.updateTokens(tickers);

    // Create action mappings
    await this.mapper.createMappings(data);
}

async function settleExecution(ctx){
    // A VM-execution failure (revert / timeout / runtime error) is NOT a
    // pre-VM rejection: the contract DID run and consumed gas, so the caller pays for the
    // failed attempt (see the gas-debit note below). Atomicity is preserved: state changes
    // and emissions are applied only on vmResult.success. We record a dedicated execution
    // status ('reverted' / 'out_of_resource' / 'failed', via
    // util.vmFailureStatus) and deliberately leave
    // `error` null so the gas debit fires, mirroring the in-memory debit taken before the
    // VM ran. (Leaving it as a generic 'invalid:' error would skip the debit, letting any
    // caller burn up to the gas ceiling / CPU limit for free, which is a node-DoS vector.)
    ctx.vmFailed = Boolean(ctx.vmError) && !ctx.error;
    ctx.vmStatus = ctx.vmFailed ? this.util.vmFailureStatus(ctx.vmError) : null;

    clampVmGas(ctx);
    settleGasFee.call(this, ctx);
    await recordExecution.call(this, ctx);
    await applyLedgerChanges.call(this, ctx);
}

module.exports = { settleExecution };
