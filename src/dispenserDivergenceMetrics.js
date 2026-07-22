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
 * Dispenser lifecycle divergence metrics (observability only)
 *
 * The indexer derives dispenser state from the full DISPENSER lifecycle:
 * create (format 0), cancel (format 1) and edit (format 2, which can change
 * EXPIRATION). The upstream decoder only tracks creates, so once a dispenser
 * is cancelled or re-dated by an edit, the decoder can keep proposing DISPENSE
 * triggers for a dispenser the indexer no longer considers open. Those triggers
 * match nothing here and are dropped.
 *
 * This module counts, per block and cumulatively, the three events that size
 * that gap:
 *   - cancels applied,
 *   - EXPIRATION edits (shortened vs lengthened),
 *   - DISPENSE triggers dropped because the target dispenser was already
 *     cancelled or expired.
 *
 * It is measurement only: it performs no database writes, influences no
 * validation or state-transition outcome, and its counters never feed block
 * hashing. Everything is emitted to the operational log with a stable
 * `DISPENSER_DIVERGENCE` prefix so a multi-day run can be tallied from logs.
 * Counters are process-local and best-effort (a reorg/replay may recount); they
 * are a sizing aid, not an authoritative ledger.
 *
 ********************************************************************/

function emptyCounts(){
    return {
        cancels:           0,
        edits:             0,
        editsShortened:    0,
        editsLengthened:   0,
        rejectedCancelled: 0,
        rejectedExpired:   0,
    };
}

class DispenserDivergenceMetrics {

    constructor(){
        this.totals       = emptyCounts();
        this.block        = emptyCounts();
        this.currentBlock = null;
    }

    // Roll the per-block tallies forward when a new block starts, emitting a
    // one-line summary for the block just finished. Blocks are processed in
    // ascending order, so a change in block_index marks a boundary.
    _track(block_index){
        if(this.currentBlock !== null && block_index !== this.currentBlock)
            this.flush();
        this.currentBlock = block_index;
    }

    _bump(name){
        this.block[name]  += 1;
        this.totals[name] += 1;
    }

    // A cancel (DISPENSER format 1) has been applied and the dispenser closed.
    recordCancel(coin, block_index, action_index, address){
        this._track(block_index);
        this._bump('cancels');
        console.log('\t DISPENSER_DIVERGENCE : CANCEL : ' + coin + ':' + action_index +
                    ' addr=' + address + ' block=' + block_index);
    }

    // An EXPIRATION edit (DISPENSER format 2) has changed the effective expiry.
    recordExpirationEdit(coin, block_index, action_index, address, oldExpiration, newExpiration){
        this._track(block_index);
        let older = Number(oldExpiration);
        let newer = Number(newExpiration);
        let delta = 'unchanged';
        if(newer < older){ delta = 'shortened'; this._bump('editsShortened'); }
        else if(newer > older){ delta = 'lengthened'; this._bump('editsLengthened'); }
        this._bump('edits');
        console.log('\t DISPENSER_DIVERGENCE : EDIT_EXPIRATION : ' + coin + ':' + action_index +
                    ' addr=' + address + ' old=' + oldExpiration + ' new=' + newExpiration +
                    ' delta=' + delta + ' block=' + block_index);
    }

    // A DISPENSE trigger matched no open dispenser because the dispenser at the
    // paid address was already cancelled or expired. `reason` is 'cancelled' or
    // 'expired'. Observational only: the trigger is still dropped as before.
    recordRejectedDispense(coin, block_index, address, action_index, reason){
        this._track(block_index);
        if(reason === 'cancelled') this._bump('rejectedCancelled');
        else if(reason === 'expired') this._bump('rejectedExpired');
        console.log('\t DISPENSER_DIVERGENCE : DISPENSE_REJECTED : ' + coin +
                    ' addr=' + address + ' dispenser=' + action_index +
                    ' reason=' + reason + ' block=' + block_index);
    }

    // Emit the accumulated per-block summary plus running totals, then reset the
    // per-block tallies. Called automatically on a block boundary.
    flush(){
        let b = this.block;
        let t = this.totals;
        // Only emit when the finished block actually saw divergence activity.
        if(b.cancels || b.edits || b.rejectedCancelled || b.rejectedExpired){
            console.log('\t DISPENSER_DIVERGENCE : SUMMARY block=' + this.currentBlock +
                        ' cancels=' + b.cancels +
                        ' edits=' + b.edits + '(short=' + b.editsShortened + ',long=' + b.editsLengthened + ')' +
                        ' rejected(cancelled=' + b.rejectedCancelled + ',expired=' + b.rejectedExpired + ')' +
                        ' | totals cancels=' + t.cancels +
                        ' edits=' + t.edits + '(short=' + t.editsShortened + ',long=' + t.editsLengthened + ')' +
                        ' rejected(cancelled=' + t.rejectedCancelled + ',expired=' + t.rejectedExpired + ')');
        }
        this.block = emptyCounts();
    }
}

// Export a single process-wide instance so counts accumulate across handlers.
module.exports = new DispenserDivergenceMetrics();
