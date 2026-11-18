/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 * XChain Platform Action - SEND: probe leg verdict folding
 *
 ********************************************************************/

'use strict';

// Read-only pre-flight only: keep each leg's own verdict. A multi-leg action (SEND, AIRDROP,
// DESTROY) settles every leg through a shared STATUS field, so the action-level STATUS ends as
// the LAST leg's, and a dry-run reading only that field answered 'valid' for a transaction
// whose earlier legs the chain refuses (or 'invalid' for one whose earlier legs settle).
// FEE_PROBE is true only on the synthetic transaction the public quote surfaces build
// (actions_class/transaction.js copies it off tx.fee_probe), so this key never exists on a
// decoded transaction and no consensus value moves. Inside a BATCH, batch/probe.js folds the
// legs into the sub-command verdict before the key clear drops them. `leg` is the leg's own
// record: TICK and AMOUNT always, DESTINATION where the action has one.
function recordProbeLegVerdict(data, leg, status){
    if(data['FEE_PROBE'] !== true) return;
    if(!Array.isArray(data['PROBE_LEG_VERDICTS'])) data['PROBE_LEG_VERDICTS'] = [];
    let entry = {
        tick:   leg['TICK'],
        amount: (leg['AMOUNT'] === null || leg['AMOUNT'] === undefined) ? null : String(leg['AMOUNT'])
    };
    if(leg['DESTINATION'] !== undefined) entry.destination = leg['DESTINATION'];
    entry.status = status;
    data['PROBE_LEG_VERDICTS'].push(entry);
}

function foldLegVerdicts(legs, isGuardInert){
    if(!Array.isArray(legs) || legs.length === 0) return null;
    let copied = legs.map((leg) => Object.assign({}, leg));
    let refused = copied.find((leg) => leg.status !== 'valid' && !isGuardInert(leg.status));
    if(!refused) refused = copied.find((leg) => leg.status !== 'valid');
    return { status: refused ? refused.status : 'valid', legs: copied };
}

module.exports = { foldLegVerdicts, recordProbeLegVerdict };
