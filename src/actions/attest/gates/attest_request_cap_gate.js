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
 * price. That is the launch reason this rule exists; the mainnet case is the
 * ordinary one (a funded attacker is merely slowed by fees, not stopped).
 *
 * SEMANTICS: REJECTION, NOT DEFERRAL. This is deliberately unlike the three
 * sibling per-block caps (XCALL_MAX_CALLS_PER_BLOCK,
 * ATTEST_MAX_EXPIRIES_PER_BLOCK, CROSS_SETTLE_MAX_PER_BLOCK), which cap a pass
 * the INDEXER schedules and carry the overflow forward to the next block. Those
 * can defer because they choose when to do work that is already owed. An
 * admission cap cannot: the v0 action is already in THIS block, emitted by the
 * VM during an EXECUTE that has already run, so there is no later block to move
 * it to and no way to re-present it. An over-cap request is therefore REFUSED,
 * and the author's remedy is to retry in a later block.
 *
 * WHAT THE REFUSAL COSTS THE AUTHOR, measured on a live chain rather than read
 * off this handler. actions/attest/request.js (stampRequestStatus) sets the
 * over-cap request's STATUS, which makes REQUEST_STATUS 'rejected' - but a v0
 * exists ONLY as a VM emission, and processEmission in actions/execute/emission.js
 * throws on any emission whose handler returns a non-'valid' STATUS. That throw
 * rolls back the emitting EXECUTE's savepoint, so what a chain actually records
 * is a REVERTED EXECUTE, not a rejected request row:
 *
 *   - the over-cap request row is rolled back, so NO ATTEST v0 is ever stored
 *     'rejected'; that request_status is unreachable for v0 by construction
 *   - the UNDER-cap siblings the same EXECUTE emitted before it are rolled back
 *     with it, so hitting the cap costs a contract the requests it was entitled
 *     to, not just the one over the line
 *   - every state write of that execution is rolled back too
 *   - the EXECUTE lands 'failed' with this rule's message verbatim in
 *     contract_executions.error_message ("emission failed: ATTEST: invalid:
 *     ATTEST cap (...)"), which is the ONLY durable trace of the refusal
 *
 * Driven on BTC regtest 2026-09-02, the first time this gate was ever
 * reached on a chain; the e2e that reaches it is
 * xchain-e2e-test/test/actions/attestationRequestCap.test.js. Nothing above is
 * specific to the caps: every ATTEST v0 admission rule (responsible-set size,
 * fee funding, structural validation) refuses the same way. Making a refusal
 * per-request instead of per-EXECUTE would be a consensus change.
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
 * The caps apply to every ATTEST v0 request. Their values are a local copy of
 * the canonical map in xchain-documentation/protocol/constants.js and are kept
 * value-identical by a parity test. A one-sided edit forks ATTEST v0 admission.
 *
 ********************************************************************/

const { copy } = require('../../../consensus/gate_registry');

const ATTEST_REQUEST_CAPS = copy('attest_request_cap_activation.ATTEST_REQUEST_CAPS');

module.exports = {
    ATTEST_REQUEST_CAPS
};
