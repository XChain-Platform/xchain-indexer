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
 * ATTEST responsible-set widening (framework spec §8.2 liveness ladder).
 *
 * A request's responsible set is the top-REDUNDANCY validators by
 * SHA256(request_id || pubkey), drawn from the on-chain capability stake
 * snapshot at the request's block. That snapshot filters on stake and
 * MIN_STAKE and nothing else (db.getValidatorsByCapability), deliberately: the
 * set has to be derivable identically by every hub and every indexer from
 * chain state alone.
 *
 * THE HOLE THAT LEAVES. A validator that is staked and serving nothing keeps
 * its slot forever. Every request whose hash order lands on it then needs
 * `redundancy` signatures from a set that can only ever produce
 * `redundancy - 1`, so the round cannot finalize, every retry dies on the
 * consensus round timeout, and the request burns its whole deadline window and
 * expires with zero responses. Measured on BTC testnet4 2026-09-02: request
 * 77f37a86..., redundancy 3, a responsible set of 3 whose middle member has
 * never once connected to the federation. The existing leader-rotation ladder
 * does not help, because it moves which member goes FIRST, never which members
 * may SIGN.
 *
 * WHY THE LADDER CANNOT KEY ON LIVENESS. Hubs disagree about who is reachable,
 * so any rule shaped like "skip a member that looks silent" forks the set
 * between two honest hubs. This ladder is therefore a pure function of chain
 * height, exactly like the leader-rotation and model-fallback ladders it sits
 * beside (xchain-hub/src/attestation_escalation.js): the set widens on a fixed
 * schedule whether or not anyone is actually down, and a healthy round
 * finalizes inside the first segment, before any widening is visible at all.
 *
 * WHAT IT DOES NOT RELAX. Finalization still requires `redundancy` VALID
 * signatures, so the independent-replication count the requesting contract
 * asked for is unchanged. Widening only grows the pool of validators permitted
 * to supply them, and only after the assigned set has had the first third of the
 * request's own window to itself and demonstrably failed in it.
 *
 * MONOTONICITY, which is what makes the two sides safe to evaluate at
 * different heights. The hub derives its step from the indexer tip it polled;
 * this module is asked for the v1 verify filter's step at the block the
 * RESPONSE landed in, which is always at or above that tip. The indexer's set
 * is therefore always a SUPERSET of the one the signing hub used, and a
 * signature authorized at proposal time can never be rejected at validation
 * time. The reverse ordering is impossible: a response cannot be mined before
 * it was built.
 *
 * ACTIVATION PLANE: the REQUEST's own block, never the response's. A request
 * admitted below the height never widens and one admitted above always may, so
 * the rule for a given request is fixed the moment it is admitted and cannot
 * change under it mid-window. Evaluated on BTC heights; the responsible set is
 * BTC-only (attest.js returns [] off BTC before any of this is consulted).
 *
 * LOCAL COPY of the canonical map in xchain-documentation/protocol/constants.js
 * and the byte-twin of xchain-hub/src/attest_responsible_widening_activation.js; kept
 * value-identical by the activation-constants parity suite. A one-sided edit
 * forks ATTEST v1 signature admission at the flag-day.
 *
 ********************************************************************/

'use strict';

const { get, copy, activeAt } = require('./consensus/gate_registry');

// The stage-2 selector. Required at the top: this module never feeds that one.
const zc = require('./attest_zero_conf_activation.js');

const ATTEST_RESPONSIBLE_WIDENING_ACTIVATION = copy('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION');

const ATTEST_RESPONSIBLE_WIDENING = copy('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING');

const ATTEST_RESPONSIBLE_WIDENING_V2 = copy('attest_responsible_widening_activation.ATTEST_RESPONSIBLE_WIDENING_V2');

// Extra responsible slots at `atBlock` for a request admitted at `requestBlock` with
// deadline `deadlineBlock`. Returns 0 (the legacy fixed-REDUNDANCY set, byte for byte)
// whenever the network is unratified, the request predates the flag-day, any height is
// unusable, the span is degenerate, or the ladder is still inside its first segment.
//
// Above ATTEST_ZERO_CONF_ACTIVATION (on the request block) the stage-2 ladder runs
// instead: it starts at the request block and never returns less than the headroom, so
// the two early returns that read 0 below read `headroom` there. At the round's own
// start elapsed is 0, and a 0 on that branch would make headroom inert on exactly the
// block it exists for.
//
// A height past the deadline clamps to maxSlots rather than running off the end; the
// deadline check itself lives in the callers, which reject a late v1 outright.
// Monotonic in atBlock under both stages, which is what lets the indexer evaluate it at
// the response block and still hold a superset of the signing hub's set.
function widenSlots(atBlock, requestBlock, deadlineBlock, network){
    let threshold = ATTEST_RESPONSIBLE_WIDENING_ACTIVATION[network];
    // null is the UNRATIFIED sentinel and must read as "off". Without the explicit
    // null test `req >= null` coerces to `req >= 0` and arms the ladder on every
    // block of an unratified network, which is the inverse of what the sentinel means.
    if(threshold === null || threshold === undefined) return 0;
    let req = parseInt(requestBlock);
    let at  = parseInt(atBlock);
    let dl  = parseInt(deadlineBlock);
    if(!Number.isFinite(req) || !Number.isFinite(at) || !Number.isFinite(dl)) return 0;
    if(req < threshold) return 0;
    if(zc.isZeroConfActive(req, network)) return widenSlotsV2(at, req, dl);
    let start = req + ATTEST_RESPONSIBLE_WIDENING.confirmations;
    let span  = dl - start;
    // Degenerate span (a deadline at or inside the confirmation lag): no room to
    // escalate, so the assigned set stands for the whole window. Mirrors
    // attestation_escalation.modelIndex's contract for the same shape of input.
    if(!(span > 0)) return 0;
    let elapsed = at - start;
    if(!(elapsed > 0)) return 0;
    let segment = span / (ATTEST_RESPONSIBLE_WIDENING.maxSlots + 1);
    let idx     = Math.floor(elapsed / segment);
    return Math.max(0, Math.min(idx, ATTEST_RESPONSIBLE_WIDENING.maxSlots));
}

// Stage 2 (spec §4.1): headroom from step 0, the ladder from the request block, clamped
// to headroom + maxSlots. Inputs are already parsed finite integers past the activation
// guards above.
function widenSlotsV2(at, req, dl){
    const V2 = ATTEST_RESPONSIBLE_WIDENING_V2;
    let start = req + V2.startOffset;
    let span  = dl - start;
    // Degenerate span: the assigned set plus headroom stands for the whole window.
    if(!(span > 0)) return V2.headroom;
    let elapsed = at - start;
    // At the request's own block elapsed is 0; headroom is the whole point of that block.
    if(!(elapsed > 0)) return V2.headroom;
    let segment = span / (V2.maxSlots + 1);
    let idx     = Math.floor(elapsed / segment);
    return V2.headroom + Math.min(idx, V2.maxSlots);
}

module.exports = {
    ATTEST_RESPONSIBLE_WIDENING_ACTIVATION,
    ATTEST_RESPONSIBLE_WIDENING,
    ATTEST_RESPONSIBLE_WIDENING_V2,
    widenSlots
};
