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
 * DISPENSER_CLOSE routing: where a closing dispenser's escrow goes (a SWEEP's
 * destination, then the recorded canceller, then SOURCE), and how an ownership
 * dispenser's escrow gate is released or its ownership record routed.
 *
 ********************************************************************/

const ownershipCancelGate = require('../../dispenser_ownership_cancel_activation.js');

// Installed onto Dispenser_Close.prototype by dispenser_close.js; each method runs with
// `this` bound to the handler, exactly as the class method it was.
module.exports = {

    // Returns { sweepDest, destination }: the SWEEP's chosen destination (null when no
    // SWEEP drove the close) and the address the escrow is credited to.
    async resolveCloseDestination(data, dispenser){

        // Determine where escrow gets credited. Priority:
        //   1. Sweep destination: if the cancel was driven by a SWEEP, honor the chosen destination.
        //   2. Recorded canceller: per DISPENSER.md, escrow returns to whoever cancelled
        //      (GET_ADDRESS or SOURCE). Recorded by createDispenserStatus when status='cancelling'.
        //   3. SOURCE: fallback for paths with no canceller (auto-expire reaches dispenser_expire,
        //      not here, but covered for safety).
        let sweepDest = await this.indexerDb.getSweepDestination(data['DISPENSER_ACTION_INDEX']);
        let canceller = (!this.util.isNull(sweepDest)) ? null : await this.indexerDb.getDispenserCanceller(data['DISPENSER_ACTION_INDEX']);
        let destination = (!this.util.isNull(sweepDest)) ? sweepDest
                        : (!this.util.isNull(canceller)) ? canceller
                        : dispenser['SOURCE'];

        return { sweepDest, destination };
    },

    // Release an ownership dispenser's escrow gate, or route its ownership record
    async closeOwnershipDispenser(data, dispenser, sweepDest, destination){

        // Ownership dispenser closure. If the escrow is still set, this is a
        // cancel/expire/sweep path (no successful DISPENSE), so release the gate
        // and route the ownership record. If the escrow has already been cleared
        // (because DISPENSE settled and triggered the auto-close), no action.
        //
        // Ownership routing (DISPENSER.md:122): a cancel or expire returns the
        // token's issuer rights to SOURCE; ONLY a SWEEP-closure delivers them to
        // a non-SOURCE destination. The legacy path transferred to the computed
        // `destination` (sweep > canceller > SOURCE), and cancel authority
        // includes GET_ADDRESS, so a GET_ADDRESS/SOURCE canceller acquired the
        // token's ownership for free. Gated
        // (dispenser_ownership_cancel_activation.js): below the flag-day the
        // legacy canceller-takes-ownership routing runs so historical replay is
        // byte-identical; at/after it only the SWEEP path transfers ownership and
        // cancel/expire leave it with SOURCE (matching dispenser_expire.js, which
        // was already correct). The GIVE token-balance refund routing is separate
        // (handled per DISPENSER cancel semantics) and unaffected here.
        let ownershipCancelActive = ownershipCancelGate.isDispenserOwnershipCancelActive(data['BLOCK_TIME'], this.config['NETWORK']);
        let ownershipDest = ownershipCancelActive
                          ? ((!this.util.isNull(sweepDest)) ? sweepDest : dispenser['SOURCE'])
                          : destination;
        let currentEscrow = await this.indexerDb.getTokenEscrow(dispenser['GIVE_TICK']);
        if(Number(currentEscrow) === Number(dispenser['ACTION_INDEX'])){
            if(ownershipDest == dispenser['SOURCE']){
                await this.indexerDb.clearTokenEscrow(dispenser['GIVE_TICK']);
            } else {
                await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, dispenser['GIVE_TICK'], dispenser['SOURCE'], ownershipDest);
            }
        }
    }
};
