/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Step (4) of the ROLLCALL close: which keys of the responsible set count as
 * present, verified against this indexer's own ledger_hash and the canonical
 * the epoch calls for, and why each key that did not count was dropped.
 *
 ********************************************************************/

const ed25519 = require('../ed25519.js');
const rcc     = require('../../actions/rollcall/rollcall_canonical.js');
const rga     = require('../gates/rollcall_gates_gate.js');

// (4) Verify. A row counts only if it carries THIS indexer's ledger_hash and
// its signature verifies over the canonical rebuilt here.
//
// Which canonical is decided by the EPOCH, not by the row: at or above
// ROLLCALL_GATES_ACTIVATION every roll call is ROLLCALL v1 and its canonical
// commits to sha256(GATES), below it every roll call is v0 and there is no
// gates field at all. So a row whose form disagrees with its epoch is not a
// valid signer, the same way a row bound to another ledger_hash is not: a v0
// row at a v1 epoch was signed by a build that does not know the gates rule,
// and a v1 row at a v0 epoch is a form that epoch cannot carry.
//
// Returns { gatesActive, presentKeys, presentSources, gatesRows, dropped }.
function verifySigners(answer, keys, sourceOf, ledgerHash, network, epochHeight){
    let gatesActive = rga.isRollcallGatesActive(epochHeight, network);
    let v0Canonical = Buffer.from(
        rcc.buildRollcallCanonical({ network: network, epochHeight: epochHeight, ledgerHash: ledgerHash }), 'utf8');

    let presentKeys    = [];
    let presentSources = new Set();
    let gatesRows      = [];
    // Why a key was NOT counted, tallied per reason and printed on the close line.
    // Every drop below is deliberate and consensus-neutral, but a silent one is
    // indistinguishable from an absence: a whole federation dropped on the form
    // test read as "present 0/N" with nothing to say a v1 canonical was ever
    // involved, and the operator went looking at the venue instead of the close.
    let dropped = { no_row: 0, ledger_hash: 0, form: 0, sig: 0 };
    for(let key of keys){
        let row = answer.signers ? answer.signers[key] : null;
        if(!row || !row.sig){ dropped.no_row++; continue; }
        // The carried hash must be ours. A signature bound to a different epoch
        // block is a signature about a chain this node is not on.
        if(String(row.ledger_hash).toLowerCase() !== ledgerHash){ dropped.ledger_hash++; continue; }

        // An empty GATES reads as ABSENT, never as a v1 row with an empty list.
        // The column defaults to NULL, but a default of '' anywhere upstream would
        // otherwise turn every honest v0 signer into an absence, and two absences
        // evict. A real v1 list is never empty: knownGateKeys() has entries at
        // every build that can publish one.
        let gates = (row.gates === undefined || row.gates === null || String(row.gates) === '')
                    ? null : String(row.gates);
        if(gatesActive !== (gates !== null)){ dropped.form++; continue; }

        let canonical = gatesActive
            ? Buffer.from(rcc.buildRollcallCanonical(
                  { network: network, epochHeight: epochHeight, ledgerHash: ledgerHash, gates: gates }), 'utf8')
            : v0Canonical;
        if(!ed25519.verify(canonical, String(row.sig).toLowerCase(), key)){ dropped.sig++; continue; }

        presentKeys.push(key);
        presentSources.add(sourceOf.get(key));
        // Signers sign over the PUBLISHER's list, so in practice every verified row
        // at one epoch carries the same string and this loop records it once per
        // key. Storing it PER KEY rather than once per epoch is what keeps the
        // filter honest if that ever stops being true: the filter's question is
        // "what did THIS key accept", and a per-epoch list would answer a different
        // one. Written only after the epoch is decided ROLLED, by the close.
        if(gatesActive) gatesRows.push({ pubkey: key, gates: gates.split(',') });
    }
    return { gatesActive, presentKeys, presentSources, gatesRows, dropped };
}

// The drop tally as the close line prints it, or '' when no key was dropped.
function formatDropped(dropped, gatesActive){
    return (dropped.no_row + dropped.ledger_hash + dropped.form + dropped.sig > 0)
        ? ' dropped[no_row=' + dropped.no_row + ' ledger_hash=' + dropped.ledger_hash +
          ' form=' + dropped.form + ' sig=' + dropped.sig + ' ' + (gatesActive ? 'v1' : 'v0') + ' epoch]'
        : '';
}

module.exports = { verifySigners, formatDropped };
