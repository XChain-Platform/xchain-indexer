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
 * XChain Indexer - Actions class: dry-run engine parts
 *
 * The pieces of Actions.dryRunAction that do not touch the transaction or its epoch
 * fence: the synthetic transaction, the advisory fee-balance read, the verdict read-back
 * and the result shape. dryRunAction itself (in actions/index.js) keeps the transaction,
 * the two epoch-fenced runs and the rollback. Plain functions taking the Actions instance
 * explicitly, so a test context that borrows Actions.prototype.dryRunAction alone works.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');

// The synthetic transaction a dry-run feeds processTransaction.
function syntheticDryRunTx(actions, { action, params, source, feeOutputs, probeFeeDestination,
                                      blockIndex, blockTime, guardInert, feeProbe }){
    let txOutputs = Array.isArray(feeOutputs) ? feeOutputs : [];
    if(txOutputs.length === 0 && probeFeeDestination)
        // Decimal coin units (decoder-shaped outputs); 21M coin exceeds any fee band.
        txOutputs = [{ address: probeFeeDestination, value: '21000000.00000000' }];

    // Synthetic transaction mirroring what the decoder feeds processTransaction. The tx_hash
    // is unique + clearly marked; it and any handler writes vanish on rollback.
    return {
        data:          [action].concat(params).join('|'),
        source:        source,
        destination:   null,
        amount:        null,
        tx_hash:       'DRYRUN-' + blockIndex + '-' + (actions._dryRunSeq = (actions._dryRunSeq || 0) + 1),
        vout:          0,
        block_index:   blockIndex,
        block_time:    blockTime,
        fee:           null,
        source_pubkey: null,
        tx_outputs:    txOutputs,
        raw_data:      null,
        // Marks a run whose controller guards must NOT enter the VM (the public
        // feequote path; see computeFeeQuote). Set only here on the synthetic tx and
        // only when the caller asks, so it is absent from every decoder-fed block tx
        // and from the API-key-gated feequotedryrun path (which opts to run the VM).
        guard_inert:   guardInert === true,
        // Marks a run that has no real transaction behind it, so a handler check that
        // matches a required OUTPUT cannot be satisfied by anything the caller could
        // have done. The native-coin fee check is already served by the probe output
        // above; the oracle usage fee is checked the same way and had no
        // counterpart, so every Mode B dispenser quoted and pre-flighted
        // `invalid: ORACLE_ADDRESS (missing oracle fee output)` - a refusal no client
        // can act on, because the amount it demands is what the refused quote exists
        // to compute. Set by the two public read-only surfaces (computeFeeQuote,
        // computePreflight) and never by feequotedryrun, whose whole purpose is to
        // reproduce what a real broadcast would do with the outputs it was handed.
        fee_probe:     feeProbe === true
    };
}

// The payer's fee-token balance at PRE-action state, read inside this
// transaction so it is the same snapshot the handler's own balance check reads.
// Read-only by construction: getAddressId returns null for an address the ledger
// has never seen (createAddress would WRITE one), so quoting from a fresh address
// stays a pure read. Strictly advisory - any failure degrades to null and the
// handler's verdict stands untouched.
// `runInEpoch` runs the read under the dry-run's epoch fence (dryRunAction supplies it).
async function sourceFeeBalanceOrNull(runInEpoch, indexerDb, source, feeBalanceTick){
    try {
        return await runInEpoch(async () => {
            let addressId = await indexerDb.getAddressId(source);
            if(addressId === null || addressId === undefined) return '0';
            let tickId = await indexerDb.getTickerId(feeBalanceTick);
            if(tickId === null || tickId === undefined) return null;
            let balances = await indexerDb.getAddressBalances(addressId);
            let balance  = balances ? balances[tickId] : null;
            return (balance === null || balance === undefined) ? '0' : String(balance);
        });
    } catch(e){
        getLogger().warn('dry-run fee-balance read failed: ' + ((e && e.message) ? e.message : e));
        return null;
    }
}

// Keep the abandoned promise's late settlement (typically the epoch fence firing)
// from surfacing as an unhandledRejection; the fence, not this handler, is what
// stops the zombie's writes.
function quietAbandonedRun(dryRunProcessing){
    dryRunProcessing.catch((e) => {
        getLogger().warn('Abandoned fee-quote dry-run settled after watchdog: ' +
            ((e && e.message) ? e.message : e));
    });
}

// Read the handler's verdict, staged fee and probe disclosures off a finished run into
// `verdict`, field by field in the order the run exposes them, while the transaction is
// still open. Filling the caller's object (rather than returning a new one) keeps what was
// read before a throw, exactly as when these were assignments inside dryRunAction's try.
async function readDryRunVerdict(actions, resultData, verdict){
    // Prefer the QUOTED action's own verdict over whatever the record holds now: a
    // follow-on matcher runs inside the handler and overwrites both fields with the
    // match's (see processAction). Quoting an ORDER must answer for the ORDER.
    let primary = actions._primaryVerdict;
    verdict.status = primary
        ? primary.status
        : ((resultData && resultData['STATUS'] !== undefined) ? resultData['STATUS'] : null);
    // Extract the handler-computed fee while the transaction is still open (the row
    // vanishes on rollback). `amount` is XCHAIN-denominated in every payment mode.
    let actionIndex = primary
        ? primary.actionIndex
        : ((resultData && resultData['ACTION_INDEX'] !== undefined) ? resultData['ACTION_INDEX'] : null);
    if(actionIndex !== null)
        verdict.feeRecord = await actions.indexerDb.getFeeRecord(actionIndex);
    if(resultData && Array.isArray(resultData['PROBE_SUB_VERDICTS']))
        verdict.subCommands = resultData['PROBE_SUB_VERDICTS'];
    if(resultData && resultData['PROBE_ORACLE_FEES'] &&
       typeof resultData['PROBE_ORACLE_FEES'] === 'object' &&
       Object.keys(resultData['PROBE_ORACLE_FEES']).length > 0)
        verdict.oracleFeesOwed = resultData['PROBE_ORACLE_FEES'];
}

// The dryRunAction result shape.
function dryRunOutcome(blockIndex, blockTime, verdict, dryRunError, sourceFeeBalance){
    return {
        blockIndex: blockIndex,
        blockTime:  blockTime,
        status:     verdict.status,
        error:      dryRunError,
        xchainFee:  verdict.feeRecord ? String(verdict.feeRecord.amount)
                   : ((verdict.status === 'valid') ? '0' : null),
        sourceFeeBalance: sourceFeeBalance,
        subCommands:      verdict.subCommands,
        oracleFeesOwed:   verdict.oracleFeesOwed
    };
}

module.exports = { syntheticDryRunTx, sourceFeeBalanceOrNull, quietAbandonedRun, readDryRunVerdict, dryRunOutcome };
