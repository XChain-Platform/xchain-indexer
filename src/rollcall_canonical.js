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
 * The ROLLCALL signing canonical, v0 and v1, in ONE place.
 *
 * CONSENSUS-CRITICAL. Three sites rebuild these bytes from carried fields and
 * must agree to the byte: the publishing hub (RollcallRound), the DOGE indexer's
 * parser (actions/rollcall.js) and the BTC indexer's epoch close
 * (rollcall_close.js). Before v1 each site spelled the concatenation inline;
 * with a second form that is three places to drift, so the spelling lives here
 * and the sites call it. Frozen by
 * xchain-documentation/protocol/test-vectors/rollcall_canonical.json.
 *
 *   v0:  network|epochHeight|ledgerHash
 *   v1:  network|epochHeight|ledgerHash|gatesHash     gatesHash = sha256(GATES)
 *
 * both wrapped in the uniform equivocation header
 * (equivocation_header.buildEquivCanonical, engine tag ROLLCALL, round id the
 * epoch height, view 0), exactly as v0 always was. Every ROLLCALL that can exist
 * is at or above EQUIV_HEADER_ACTIVATION, so only the wrapped form is built.
 *
 * GATES is the v1 wire field as carried: the publisher's comma-joined, sorted
 * `<module>.<EXPORT>` list (consensus_rules_digest.knownGateKeys().join(',')).
 * Signers sign over the PUBLISHER's list, which is why a signer whose build
 * knows a different list verifies against nothing. The hash, not the list, is
 * what the canonical commits to; the list itself is what the close records.
 *
 * BYTE-TWIN of xchain-hub/src/rollcall_canonical.js.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const eq     = require('./equivocation_header.js');

// sha256 of the GATES field exactly as carried, lowercase hex.
function gatesHash(gates){
    return crypto.createHash('sha256').update(String(gates), 'utf8').digest('hex');
}

// The signed canonical for an epoch. Pass `gates` (the carried GATES string) for
// a v1 roll-call; omit it, or pass null, for v0. The v0 bytes are byte-identical
// to the inline form every site built before this module existed.
function buildRollcallCanonical({ network, epochHeight, ledgerHash, gates }){
    let content = String(network) + '|' + Number(epochHeight) + '|' + String(ledgerHash).toLowerCase();
    if(gates !== undefined && gates !== null) content += '|' + gatesHash(gates);
    return eq.buildEquivCanonical(eq.ENGINE_TAGS.ROLLCALL, String(Number(epochHeight)), 0, content);
}

module.exports = {
    gatesHash,
    buildRollcallCanonical
};
