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
 * XChain Platform Action - BATCH: the public pre-flight collectors
 *
 * What the BATCH handler records only when it runs as the read-only fee probe
 * (data['DRY_RUN'] === true, set on synthetic transactions by
 * actions_class/dry_run_support.js and copied by actions_class/transaction.js):
 * the per-sub-command verdict list and the per-oracle fee table. Nothing here runs for a
 * decoded transaction, so nothing here can move a consensus value.
 *
 ********************************************************************/

const { foldLegVerdicts } = require('../send/leg_verdicts.js');

const DISPENSE_UNJUDGED_NOTE =
    'payment-triggered DISPENSE is not judged on the public pre-flight (the pre-flight transaction pays no dispenser address)';

// Seed the probe-local collectors on `data`; returns whether this run is the probe.
function seedProbeCollectors(data){
    // BATCH dry-run collectors (spec row 46). data['DRY_RUN'] is set ONLY
    // on synthetic dry-run transactions, so it is false for
    // every decoded transaction and nothing in this block can move a consensus value.
    // Seeded before the dispatch loop's
    // baseKeys snapshot, for the same reason the value ledger is: the per-sub-command
    // field clear there would otherwise delete them before the second command ran.
    //
    //   PROBE_SUB_VERDICTS - each dispatched sub-command's own verdict, in list order.
    //                        A row is {status, refused, legs?}: a status the probe really got,
    //                        or status null plus a `refused` note when the probe declines
    //                        to dispatch a VM action, enter a controller guard, or judge a
    //                        payment-triggered DISPENSE without a destination.
    //   PROBE_ORACLE_FEES  - per-oracle fees owed, filled in by chargeOracleUsageFee
    //                        (dispenser/validate_format.js).
    //
    // Both are probe-LOCAL and deliberately separate from BATCH_VALUE_LEDGER: that
    // key's PRESENCE is how the coinpay/ and dispense/ handlers and validateOracleFee recognise
    // "inside a flagged batch", and its CONTENTS are consensus state a read-only
    // surface must never write. No probe collector writes to it.
    let collect = data['DRY_RUN'] === true;
    if(collect){
        data['PROBE_SUB_VERDICTS'] = [];
        data['PROBE_ORACLE_FEES']  = {};
        if(data['BATCH_FEE_QUOTE'] === true) data['PROBE_BATCH_FEES'] = [];
    }
    return collect;
}

// Record the verdict the sub-command just dispatched left in data['STATUS'], or, when it set
// off a match, the verdict processAction snapshotted before the match overwrote that field.
function recordSubVerdict(data, action, batchPosition, matchSnapshot){
    let folded = matchSnapshot ? null : foldLegVerdicts(data['PROBE_LEG_VERDICTS'],
        (status) => this.util.isGuardInertError(status));
    let raw       = matchSnapshot ? matchSnapshot.status : (folded ? folded.status : data['STATUS']);
    let subStatus = (raw === undefined) ? null : raw;
    // A sub-command whose bound controller's guard the probe declines to enter is
    // UNJUDGED, not rejected. The refusal arrives here as an ordinary
    // `invalid: FEE_QUOTE_CONTROLLER_UNSUPPORTED ...` status, and every consumer
    // reads any non-empty status as the network having rejected the command - so
    // left alone it manufactures a false NEGATIVE, telling a composer the chain
    // will refuse a command the chain in fact accepts. Measured exactly that way
    // on testnet: with a transfer controller bound to an address, the standalone
    // SEND pre-flighted guard-inert and landed valid, while the identical send as
    // a batch sub-command reported "will fail". This is the same shape as the VM
    // refusal in batch/index.js's dispatch loop (status null + a `refused` note), so it takes the same road,
    // and the note names the controller so the composer knows what to do next.
    let inert = this.util.isGuardInertError(subStatus);
    let dispenseUnjudged = subStatus === null && action === 'DISPENSE' &&
                            data['COIN_DESTINATION'] == null;
    let row = {
        position: batchPosition,
        action:   action,
        status:   inert ? null : subStatus,
        refused:  inert ? this.util.describeGuardInert(subStatus)
                        : (dispenseUnjudged ? DISPENSE_UNJUDGED_NOTE : null)
    };
    if(folded) row.legs = folded.legs;
    data['PROBE_SUB_VERDICTS'].push(row);
}

// Capture the fee each sub-command actually staged after it has run against the state left by
// its predecessors. EXECUTE discloses its settled metered fee directly; ordinary handlers use
// their common fees row. A filling ORDER or SWAP uses the originating index saved before its
// match replaced ACTION_INDEX. A missing row means the command charged zero.
async function recordSubFee(data, action, matchSnapshot){
    if(!Array.isArray(data['PROBE_BATCH_FEES'])) return;
    if(action === 'AIRDROP' && Array.isArray(data['PROBE_NATIVE_FEE_LEGS'])){
        data['PROBE_BATCH_FEES'].push({ action: action,
            xchainFees: data['PROBE_NATIVE_FEE_LEGS'].slice() });
        return;
    }
    let amount = null;
    if(action === 'EXECUTE' && Object.prototype.hasOwnProperty.call(data, 'PROBE_SETTLED_GAS_FEE'))
        amount = data['PROBE_SETTLED_GAS_FEE'];
    else {
        let feeIndex = matchSnapshot && matchSnapshot.actionIndex != null
            ? matchSnapshot.actionIndex : data['ACTION_INDEX'];
        let record = feeIndex == null ? null : await this.indexerDb.getFeeRecord(feeIndex);
        if(record) amount = record.amount;
    }
    data['PROBE_BATCH_FEES'].push({
        action: action, xchainFee: String(amount == null ? '0' : amount)
    });
}

module.exports = { seedProbeCollectors, recordSubVerdict, recordSubFee };
