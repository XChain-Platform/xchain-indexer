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
 * (data['FEE_PROBE'] === true, set by the quote surfaces in actions/index.js): the
 * per-sub-command verdict list and the per-oracle fee table. Nothing here runs for a
 * decoded transaction, so nothing here can move a consensus value.
 *
 ********************************************************************/

// Seed the probe-local collectors on `data`; returns whether this run is the probe.
function seedProbeCollectors(data){
    // Public BATCH pre-flight collectors (spec row 46). data['FEE_PROBE'] is set ONLY
    // on the synthetic transaction the read-only quote surfaces build (actions/index.js
    // sources it from tx.fee_probe), so it is false for every decoded transaction and
    // nothing in this block can move a consensus value. Seeded before the dispatch loop's
    // baseKeys snapshot, for the same reason the value ledger is: the per-sub-command
    // field clear there would otherwise delete them before the second command ran.
    //
    //   PROBE_SUB_VERDICTS - each dispatched sub-command's own verdict, in list order.
    //                        A row is {status, refused}: a status the probe really got,
    //                        or status null plus a `refused` note for the two things the
    //                        probe declines to answer (a VM sub-action it never
    //                        dispatches, and a controller guard it never enters).
    //   PROBE_ORACLE_FEES  - per-oracle fees owed, filled in by dispenser.js.
    //
    // Both are probe-LOCAL and deliberately separate from BATCH_VALUE_LEDGER: that
    // key's PRESENCE is how coinpay.js, dispense.js and validateOracleFee recognise
    // "inside a flagged batch", and its CONTENTS are consensus state a read-only
    // surface must never write. No probe collector writes to it.
    let isProbe = data['FEE_PROBE'] === true;
    if(isProbe){
        data['PROBE_SUB_VERDICTS'] = [];
        data['PROBE_ORACLE_FEES']  = {};
    }
    return isProbe;
}

// Record the verdict the sub-command just dispatched left in data['STATUS'].
function recordSubVerdict(data, action, batchPosition){
    let subStatus = (data['STATUS'] === undefined) ? null : data['STATUS'];
    // A sub-command whose bound controller's guard the probe declines to enter is
    // UNJUDGED, not rejected. The refusal arrives here as an ordinary
    // `invalid: FEE_QUOTE_CONTROLLER_UNSUPPORTED ...` status, and every consumer
    // reads any non-empty status as the network having rejected the command - so
    // left alone it manufactures a false NEGATIVE, telling a composer the chain
    // will refuse a command the chain in fact accepts. Measured exactly that way
    // on testnet: with a transfer controller bound to an address, the standalone
    // SEND pre-flighted guard-inert and landed valid, while the identical send as
    // a batch sub-command reported "will fail". This is the same shape as the VM
    // refusal in index.js's dispatch loop (status null + a `refused` note), so it takes the same road,
    // and the note names the controller so the composer knows what to do next.
    let inert = this.util.isGuardInertError(subStatus);
    data['PROBE_SUB_VERDICTS'].push({
        position: batchPosition,
        action:   action,
        status:   inert ? null : subStatus,
        refused:  inert ? this.util.describeGuardInert(subStatus) : null
    });
}

module.exports = { seedProbeCollectors, recordSubVerdict };
