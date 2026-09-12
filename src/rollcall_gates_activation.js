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
 * ROLLCALL gates: the roll-call names the consensus gates its signers know, and
 * the attestation capability set drops a validator whose last rolled call lacks
 * a gate active at the request block.
 *
 * WHY A HEIGHT OF ITS OWN. This changes the ROLLCALL wire (v1 carries a GATES
 * field), the ROLLCALL canonical (gatesHash is appended), and the attestation
 * capability-set derivation. The zero-conf flip changes a different canonical
 * on a different cadence (per request, not per epoch), so the two are keyed
 * separately: ATTEST_ZERO_CONF_ACTIVATION on the request block, this one on
 * the EPOCH height.
 *
 * KEYED ON THE EPOCH. An epoch whose height is at or above this value is
 * published as ROLLCALL v1 and its close writes one rollcall_gates row per
 * verified signer. The filter itself runs at a request block H, reads the most
 * recent ROLLED epoch at or below the buried snapshot block that is at or above
 * this height, and drops a pubkey whose recorded list is NOT a superset of the
 * gates active at H. A pubkey with no such row (no rolled epoch above the
 * height yet, or a key that never rolled) is never dropped: liveness eviction
 * owns the never-rolled case, so the bootstrap epoch after arming filters
 * nobody.
 *
 * WHAT IT COSTS. A new gate cannot arm before every validator that should serve
 * has rolled a call naming it, so arming lags the fleet roll by one epoch close
 * (1008 BTC blocks on testnet and mainnet). Signers sign over the PUBLISHER's
 * list, so a fleet mid-roll across an epoch fails to roll that epoch: roll the
 * fleet between epochs, never across one.
 *
 * REGTEST IS ENV-DERIVED on the ROLLCALL precedent, and unset ships INERT for
 * the same reason: arming commits the venue to a wired DOGE peer. A venue that
 * arms the ROLLCALL rail opts in here separately, so a rail-armed venue can
 * still drive the below-height (v0) behaviour as its control.
 *
 * LOCAL COPY of the canonical map in xchain-documentation/protocol/constants.js
 * and the value twin of xchain-hub/src/rollcall_gates_activation.js. The mainnet
 * and testnet heights are held value-identical to the canonical map by
 * test/unit/activationConstantsParity.test.js, which compares those two keys and
 * only those; regtest is env-derived and is deliberately not compared.
 *
 ********************************************************************/

'use strict';

// The documented regtest arming height: genesis, a multiple of the 30-block
// regtest interval, so epoch 0 is a real v1 epoch.
const ROLLCALL_GATES_REGTEST_ARMED_HEIGHT = 0;

// The one environment variable this module reads, and only ever for regtest.
const ROLLCALL_GATES_REGTEST_ENV = 'XC_ROLLCALL_GATES_REGTEST_ACTIVATION';

// Same grammar as rollcall_activation.resolveRegtestActivation, read ONCE at
// require time: armed | genesis | on | true | yes arm at genesis, a non-negative
// integer arms at that height, unset | '' | off | inert | false | no | none stay
// inert, anything else fails CLOSED to inert and says so.
function resolveRegtestGatesActivation(env){
    let raw = (env || {})[ROLLCALL_GATES_REGTEST_ENV];
    if(raw === undefined || raw === null) return null;
    let s = String(raw).trim().toLowerCase();
    if(s === '' || s === 'off' || s === 'inert' || s === 'false' || s === 'no' || s === 'none') return null;
    if(s === 'armed' || s === 'genesis' || s === 'on' || s === 'true' || s === 'yes')
        return ROLLCALL_GATES_REGTEST_ARMED_HEIGHT;
    if(/^\d+$/.test(s)){
        let h = parseInt(s, 10);
        if(Number.isFinite(h) && h >= 0) return h;
    }
    console.error('ROLLCALL gates: ignoring ' + ROLLCALL_GATES_REGTEST_ENV + '=' + JSON.stringify(String(raw)) +
                  '; regtest stays INERT. Expected a non-negative height, "armed", or "off".');
    return null;
}

// Per-network EPOCH height at/above which ROLLCALL is published as v1 with the
// GATES field and the epoch close records each signer's list.
const ROLLCALL_GATES_ACTIVATION = {
    mainnet: null,        // INERT placeholder: the operator owns this height
    testnet: 152208,      // SIZED 2026-09-08: the first epoch boundary (151200 + 1008) after the v0.16.0 roll, which lands between the 151200 and 152208 closes
    regtest: resolveRegtestGatesActivation(process.env),   // ARMS AT 0 when the venue sets XC_ROLLCALL_GATES_REGTEST_ACTIVATION
};

// True when the epoch at `epochHeight` publishes ROLLCALL v1 and records gates.
// null reads as "off" through the isFinite guard, never through `>=`.
function isRollcallGatesActive(epochHeight, network){
    let threshold = ROLLCALL_GATES_ACTIVATION[network];
    if(!Number.isFinite(threshold)) return false;
    let h = parseInt(epochHeight);
    if(!Number.isFinite(h)) return false;
    return h >= threshold;
}

module.exports = {
    ROLLCALL_GATES_ACTIVATION,
    ROLLCALL_GATES_REGTEST_ARMED_HEIGHT,
    ROLLCALL_GATES_REGTEST_ENV,
    resolveRegtestGatesActivation,
    isRollcallGatesActive
};
