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
 * ATTEST v0 per-block admission caps (framework spec §11.1).
 *
 * The spec promised three rate limits. Two shipped: a per-validator outbound
 * fetch limit (hub-side) and a per-provider payload/deadline bound. The two
 * that bound VOLUME - "per-contract max ATTEST v0s per block" and "per-block
 * global ceiling" - never did, so nothing bounded how many attestation
 * requests a single block could admit.
 *
 * Why that matters more than an ordinary DoS bound: an admitted request makes
 * OTHER people spend. Each one puts `REDUNDANCY` validators on the hook for a
 * provider call, and for the `llm` provider that call is a real invoice on the
 * operator's own vendor account. The requester pays a fixed gas charge
 * (VM_ATTEST_REQUEST) that is identical whether the provider is a free HTTP
 * GET or a paid model, so the cost of asking and the cost of serving are
 * decoupled by construction.
 *
 * On a fee-bearing network economics still bound the shape: a spam loop costs
 * its author real native coin per transaction and real XCHAIN per action. On
 * TESTNET neither is scarce - the coin is faucet-issued and XCHAIN is openly
 * mintable - so the author's cost to make five validators buy vendor tokens is
 * approximately zero, and the bound has to be a protocol rule instead of a
 * price. That is the launch reason this gate exists; the mainnet case is the
 * ordinary one (a funded attacker is merely slowed by fees, not stopped).
 *
 * SEMANTICS: REJECTION, NOT DEFERRAL. This is deliberately unlike the three
 * sibling per-block caps (XCALL_MAX_CALLS_PER_BLOCK,
 * ATTEST_MAX_EXPIRIES_PER_BLOCK, CROSS_SETTLE_MAX_PER_BLOCK), which cap a pass
 * the INDEXER schedules and carry the overflow forward to the next block. Those
 * can defer because they choose when to do work that is already owed. An
 * admission cap cannot: the v0 action is already in THIS block, emitted by the
 * VM during an EXECUTE that has already run, so there is no later block to move
 * it to and no way to re-present it. Over-cap requests are therefore REJECTED
 * ('rejected' request_status, terminal at creation, fee never escrowed), and
 * the author's remedy is to retry in a later block.
 *
 * DETERMINISM: the count is taken from the attests table at
 * (block_index = this block, action_index < this action, request_status <>
 * 'rejected'). Every node processes a block's actions in action_index order
 * inside one transaction, so at any given action every node sees exactly the
 * same set of earlier admissions from that block. The order is total
 * (action_index is unique), so which requests fall inside the cap and which
 * fall outside is identical fleet-wide, and a from-genesis replay reproduces
 * it. Rejected rows are excluded so a refused request never consumes a slot it
 * was never granted.
 *
 * ACTIVATION PLANE: LOCAL BLOCK HEIGHT, matching the ATTEST_ADMISSION gate this
 * check sits beside (see the plane note in attest_admission_activation.js). The
 * comparison is against the request's own BLOCK_INDEX on its own chain.
 *
 * ARMING, and why testnet is NOT genesis-active despite being the reason this
 * exists. The cap is CONSENSUS-VISIBLE: it changes which ATTEST v0s are
 * accepted, so it moves actions rows, the contract hash and the checkpoint
 * preimage. Arming it at height 0 on a chain that ALREADY HAS HISTORY silently
 * reinterprets that history, and it is replay-safe there only if no past block
 * ever admitted more than the cap - a chain-state question no file in this repo
 * can answer, which is exactly the reasoning the CROSS_SETTLE_MAX_PER_BLOCK
 * ruling recorded. So:
 *
 *   regtest 0  - armed at genesis; the e2e venue is rebuilt from scratch, so
 *                there is no history to reinterpret and the suites exercise it.
 *   testnet 0  - armed at genesis, RATIFIED by the operator 2026-08-18 on the
 *                evidence below, so the public testnet launches with the cap in
 *                force rather than discovering it dormant afterwards.
 *   mainnet    - UNRATIFIED. The operator owns this height.
 *
 * WHY 0 IS SAFE ON TESTNET, measured rather than assumed. Arming at genesis on a
 * chain that already has history is replay-safe only if no past block ever
 * admitted more than the cap. That is a chain-state question, and the
 * CROSS_SETTLE_MAX_PER_BLOCK ruling refused to assume its answer. Here it was
 * ANSWERED, for ALL THREE chains the `testnet` key covers rather than just the
 * one that matters most: the live explorer reports `total: 0` attestation rows
 * ever recorded on BTC, LTC and DOGE testnet alike (`/{TBTC,TLTC,TDOGE}/api/
 * attestations`, checked 2026-08-18). Zero requests in a chain's whole history
 * means no block of it can have exceeded a cap of 10, so arming from block 0
 * reinterprets nothing and replay stays byte-identical on every testnet chain.
 * Do not generalize the result: mainnet has real attestation history, so pinning
 * a height there needs its own measurement, not this one.
 *
 * A null height means the rule is INERT on that network and the legacy uncapped
 * admission path runs byte for byte, which is what mainnet still does.
 *
 * LOCAL COPY of the canonical maps in xchain-documentation/protocol/
 * constants.js; kept value-identical by a parity test. A one-sided edit forks
 * ATTEST v0 accept/reject at the flag-day.
 *
 ********************************************************************/

// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js). Compared against the request's own
// LOCAL block_index on its own chain.
const ATTEST_REQUEST_CAP_ACTIVATION = {
    mainnet: null,        // INERT: operator-owned height, unratified
    testnet: 0,           // ARMED at genesis (operator-ratified 2026-08-18; zero historical attestations, so nothing is reinterpreted)
    regtest: 0,           // ARMED at genesis so the e2e venue exercises the cap
};

// The cap VALUES; the map above decides WHEN they apply (LOCAL COPY, parity-tested).
//
// perContract bounds one contract's share of a block, so a single busy (or hostile)
// contract cannot take the whole ceiling and starve every other contract's requests.
// perBlock bounds the network-wide total, which is the number that actually bounds
// validator spend: with REDUNDANCY 3 and BTC's ~144 blocks/day, a full-but-legal
// 10/block admits ~1440 requests/day, i.e. ~4320 provider calls/day spread across the
// responsible sets - a bounded, forecastable bill instead of a mempool-limited one.
//
// Sized to be invisible to legitimate use: a contract firing more than 2 attestations
// in a single block is a batch pattern that can space itself across blocks, and 10
// admitted requests in one block is far above any observed rate on any network today.
const ATTEST_REQUEST_CAPS = {
    perContract: 2,
    perBlock:    10,
};

// Whether the per-block admission caps are in effect for an ATTEST v0 request at
// `blockIndex` on `network`. Below the threshold (or on an unratified/unknown
// network) -> the legacy uncapped admission path, unchanged.
//
// `blockIndex` is the LOCAL height of the chain the request landed on, NOT a BTC
// anchor; callers must pass the request's own BLOCK_INDEX.
function isAttestRequestCapActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = ATTEST_REQUEST_CAP_ACTIVATION[network];
    // null is the UNRATIFIED sentinel and must read as "off". Without the explicit
    // null test `b >= null` coerces to `b >= 0` and arms the gate on every block of
    // an unratified network - the inverse of what the sentinel means.
    if(threshold === null || threshold === undefined) return false;
    return b >= threshold;
}

module.exports = {
    ATTEST_REQUEST_CAP_ACTIVATION,
    ATTEST_REQUEST_CAPS,
    isAttestRequestCapActive
};
