/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Gated-SEND key-handoff flag-day: the paired MESSAGE is matched by ADDRESS.
 *
 * THE RULE AS SPECIFIED. A SEND of a token carrying an active gated content
 * pack is valid only inside a transaction that also carries a MESSAGE v2
 * addressed to the SEND's DESTINATION (protocol/actions/send.md and
 * protocol/token-gated-content.md in xchain-documentation). Both texts state a
 * rule about the ADDRESS, not about how that address is spelled on the wire.
 *
 * THE DEFECT. The gate in actions/send.js matches by raw byte compare of the
 * sibling's DESTINATION parameter. Siblings are built in actions/batch.js by
 * splitting the raw wire command on '|' with only sub-action normalization
 * applied, so that parameter holds the WIRE value with no address-reference
 * resolution. MESSAGE.DESTINATION is compaction-eligible (addressRefFields.js:
 * single-valued, no noCompact), and the SDK's batch builder resolves every
 * BATCH sub-action with compaction on by default, so a wallet-composed
 * BATCH(SEND, MESSAGE) to an already-indexed recipient emits
 * MESSAGE|2|<COIN>|^<id>|<ciphertext>. SEND.DESTINATION is multi-valued and is
 * never compacted, so the gate compares '^<id>' against a full address, finds
 * no match, and records 'invalid: gated token transfer requires key handoff
 * message'. The rest of the BATCH commits as specified: the sender pays the
 * fee and publishes the key envelope, and the tokens do not move. A
 * hand-composed or third-party transaction using the same compact spelling
 * fails identically.
 *
 * THE FIX. Above the threshold a caret-spelled sibling DESTINATION is resolved
 * through db.resolveAddressRefChecked before the compare, the same call every
 * other address-bearing handler makes for its own record, and the comparison
 * runs on canonical addresses. Resolution is caret-only and short-circuits on
 * the first match, so a full-address handoff, an ungated SEND, and every
 * non-gated leg cost no extra read. Fail-closed on both edges: a reference the
 * resolver rejects, and a value that is still caret-prefixed after resolution
 * (malformed or dangling), match nothing.
 *
 * WHY GATED. It moves the ledger. A SEND recorded invalid under the byte
 * compare becomes valid, which credits the destination and debits the source in
 * that block, so the block's balances and therefore the ledger hash change. A
 * replay under the new rule diverges from every node that already processed
 * those blocks under the old one. Below the threshold the byte compare runs
 * untouched, no resolution call is made at all, and historical replay stays
 * byte-identical.
 *
 * PLANE: the block's consensus timestamp (data['BLOCK_TIME']), keyed per
 * network, matching consolidation_leg_amount_activation.js, the sibling gate in
 * this same handler. SEND lands on every chain, and a timestamp names one
 * instant across all of them rather than three heights that have to be kept in
 * step.
 *
 * MAINNET IS UNARMED, on the house sentinel (9999999999, year 2286). Naming the
 * activation instant is a separate operator act and a one-line edit here; the
 * incidence data that should inform it, how many gated SENDs live history has
 * already rejected on a compact spelling, is a query against the live indexer
 * databases and is not measured yet.
 *
 * testnet and regtest are genesis-active, the posture every sibling
 * execution-path gate takes: testnet restarted at a fresh genesis and carries no
 * value, so a resync applying the rule from firstBlock costs nothing worth
 * gating, and a fresh regtest stack exercises the corrected compare end to end.
 *
 * Execution-path gate (whether an action validates), not a change to how a row
 * is hashed, so indexer-only with no xchain-sync twin: xchain-sync replicates
 * materialized rows and never runs an action handler. No wire-format change
 * either: addressRefFields.js is untouched in both the indexer and the SDK, and
 * their byte-identical conformance test keeps holding.
 *
 ********************************************************************/

// Per-network activation, interpreted against the block's consensus timestamp
// (data['BLOCK_TIME']).
const GATED_HANDOFF_REF_ACTIVATION = {
    mainnet: 9999999999,    // UNARMED sentinel; the instant is the operator's to name
    testnet: 0,
    regtest: 0,
};

// Whether the gated-SEND handoff gate resolves a caret-spelled sibling
// DESTINATION before comparing, for a block whose consensus timestamp is
// `blockTime` on `network`. Below the threshold -> off (legacy byte compare,
// byte-identical historical replay). Unknown network or unparseable timestamp
// -> off (safe: keeps deployed behavior).
function isGatedHandoffRefActive(blockTime, network){
    let t = parseInt(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = GATED_HANDOFF_REF_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

module.exports = {
    GATED_HANDOFF_REF_ACTIVATION,
    isGatedHandoffRefActive
};
