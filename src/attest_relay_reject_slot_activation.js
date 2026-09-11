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
 * Flag-day: a REFUSED ATTEST v3 relay request claims no request_id slot.
 *
 * THE DEFECT. db.createAttestationRequest keeps at most one v0 row per
 * request_id (the single-v0 guard, which the relaxed non-unique
 * (request_id, version) index leaves as the only such guard) and it counts
 * EVERY stored v0 row, a refused one included. The comment there rests the
 * guard on the request_id preimage being collision-free, which holds for a
 * natively emitted v0 because the VM derives its id from chain data, and does
 * not hold for a relay v3: there the id arrives on the wire as a parameter and
 * is public on the origin chain before the federation broadcasts.
 *
 * So one malformed v3 naming a pending id is stamped 'rejected' and STORED,
 * and the guard then answers for the federation's real relay: the v3 admission
 * checks pass (both relay lookups skip refused rows), the action is stamped
 * valid/pending, and the row is dropped on the floor with a console warning.
 * The request never becomes pending, never gets served, and no later broadcast
 * can dislodge it. One transaction fee, one permanently unservable request.
 *
 * THE RULE. Above the threshold a v3 whose verdict is a refusal persists no
 * `attests` row at all. It is the shape the leg already uses for the two other
 * ways a v3 fails to be a relay: a v3 that strays onto an origin chain and a v3
 * below ATTEST_RELAY_ACTIVATION both hard-return, persisting nothing and
 * hashing nothing. A refused v3 joins them, so the id it named stays free and
 * the honest relay materializes. Its verdict is still recorded, on the
 * `actions` row every node writes identically.
 *
 * WHY GATED. It moves the ledger. The attests row set at version 0 is a
 * state_hash class (tableLifecycle.js), so withholding a row moves the state
 * commitment; and
 * the shared per-id lookup (getAttestationRequestById) reads refused rows, so
 * for an id whose only row is a refused relay the four consensus paths that
 * call it resolve to null instead of that row and record a different verdict
 * string, which a replay re-derives. Below the threshold every one of those
 * reads sees exactly the rows it sees today and a from-genesis replay is
 * byte-identical.
 *
 * PLANE: the LANDING block's consensus timestamp, never the carried
 * SNAPSHOT_BLOCK. The two other relay gates resolve on the snapshot because it
 * is the only value the hub shares when it decides whether to co-sign, and it
 * is safe there because a quorum signs it. Nothing signs the wire this rule
 * grades, so a snapshot-planed gate would let a griefer name a value below the
 * threshold and buy the legacy behaviour back. The v3 leg lands on the home
 * chain only, so one chain's block time names the cutover unambiguously.
 *
 * MAINNET IS ARMED AT GENESIS (operator ruling 2026-09-09). ATTEST relay is
 * armed on mainnet from BTC 963000, so this rule could not borrow the
 * empty-chain argument on its face; the row count that settles it was taken
 * instead, read-only against the live indexer databases on 2026-09-09, and
 * mainnet holds 0 attestations of any version. With no v3 row above that height
 * there is no refusal to withhold, so the rule is the identity function over
 * every mainnet block committed so far and a from-genesis replay cannot
 * diverge. The proof is a per-chain OLD-vs-ON replay witness, not this comment.
 * testnet/regtest run from genesis.
 *
 * Execution-path gate (which rows an action handler persists) rather than a
 * change to how a row is hashed, so there is no xchain-sync twin: xchain-sync
 * replicates materialized rows and never runs a handler.
 *
 * THERE ARE TWO BYTE-IDENTICAL COPIES of this file, one per service:
 * xchain-indexer/src/attest_relay_reject_slot_activation.js and
 * xchain-hub/src/attest_relay_reject_slot_activation.js. The hub's relay driver
 * reads its copy to decide whether a refused v0 row still answers the
 * already-materialized view it polls. That correction was held back while the
 * gate was inert, because a hub that ignored a refused row ahead of the arm
 * would turn a permanent block into a broadcast this indexer still drops, once
 * per relay round and once per fee. The arm lifts the hold, so the two halves ship
 * together and move together: the indexer stops storing the refusal and the hub
 * stops counting one, above the same threshold on the same network.
 *
 ********************************************************************/

// Per-network activation, interpreted against the LANDING block's consensus
// timestamp (data['BLOCK_TIME']) on the home chain.
const ATTEST_RELAY_REJECT_SLOT_ACTIVATION = {
    mainnet: 0,             // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 attestations, measured 2026-09-09)
    testnet: 0,
    regtest: 0,
};

// Whether a refused ATTEST v3 withholds its row for a block whose consensus
// timestamp is `blockTime` on `network`. Below the threshold -> off (the refusal
// is stored as a v0 row, byte-identical historical replay). Unknown network or
// unparseable timestamp -> off (safe: keeps deployed behavior).
function isAttestRelayRejectSlotActive(blockTime, network){
    let t = parseInt(blockTime);
    if(!Number.isFinite(t)) return false;
    let threshold = ATTEST_RELAY_REJECT_SLOT_ACTIVATION[network];
    if(threshold === undefined) return false;
    return t >= threshold;
}

module.exports = {
    ATTEST_RELAY_REJECT_SLOT_ACTIVATION,
    isAttestRelayRejectSlotActive
};
