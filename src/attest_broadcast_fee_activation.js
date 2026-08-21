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
 * ATTEST leader broadcast-fee reimbursement flag-day (framework spec §11).
 *
 * §11 says the leader that broadcasts an ATTEST v1 response "additionally
 * receives the native-coin equivalent of response_broadcast_native_fee". Until
 * this gate the leader ate that fee: the whole v0 escrow was released to the
 * REWARD pool and split equally across the responsible set, with nothing set
 * aside for the party that actually paid a miner to carry the response.
 *
 * At/above the activation height the fulfilled settle carves a broadcast
 * reimbursement out of the escrow FIRST and pays it to a single member, then
 * splits what is left. Three pieces make that re-derivable offline by any
 * replaying indexer, which is the whole bar here (the retired RewardTracker
 * lesson: a hub-side push that offline verifiers cannot re-derive is not an
 * option):
 *
 *   1. DENOMINATION. The allowance is a NATIVE-coin amount (the cap below),
 *      converted to XCHAIN at the oracle price read AT THE SETTLE BLOCK through
 *      utility.getFeeOraclePrices, the same block-gated, staleness-guarded read
 *      the native-coin fee check already runs. The ACTUAL miner fee of the
 *      settling transaction is deliberately NOT used: that number comes from
 *      the decoder's own fee computation, which is not consensus-hashed today,
 *      so keying a spendable reward on it would put per-node decoder output
 *      into the ledger. A flat allowance keys the reward on consensus constants
 *      plus a mirror-barriered oracle row instead.
 *
 *      ORACLE LIVENESS IS NOT A WEDGE. A missing or stale price reimburses ZERO
 *      and the settle proceeds unchanged; it never fails the block. The read is
 *      block-gated and the block loop's price barrier guarantees every node
 *      sees the same mirror at the same height, so "no price" is a value every
 *      node agrees on, not a local condition.
 *
 *   2. BROADCASTER. The lowest-hash member of the request's own responsible set
 *      (element 0 of actions/attest.js _computeResponsibleSet, which is already
 *      sorted by SHA256(request_id || pubkey)). Pure derivation from data the
 *      request row already pins, with no dependence on which peer's transaction
 *      actually landed. It pays the ELECTED leader even when a failover peer
 *      broadcast; that is the accepted cost of being re-derivable. The
 *      alternative (mapping the v1 SOURCE back through a staking source) is
 *      only correct if SOURCE is guaranteed to be the leader's staking source,
 *      which nothing enforces.
 *
 *   3. AMOUNT BOUND. A per-provider cap, below. The bound is consensus-visible
 *      because it clamps the escrow: without one, a hostile ATTESTATION.PROVIDERS
 *      overlay could drain a request author's whole escrow into the leader's
 *      pocket. Hence a shipped conservative default AND a HARD_MAX no operator
 *      overlay can exceed.
 *
 * WHY A FLAG-DAY. §11 pays out of the v0 escrow, so this changes v0 escrow
 * computation for every fee-bearing request that settles at/above the height.
 * Below it, the legacy full-escrow-to-the-split behaviour is preserved verbatim
 * so a from-genesis replay stays bit-identical.
 *
 * ACTIVATION PLANE: LOCAL BLOCK HEIGHT of the SETTLING action, and unlike the
 * ATTEST_ADMISSION gate that is safe here without qualification. The
 * reimbursement can only ever fire where the responsible set is non-empty, and
 * _computeResponsibleSet returns [] on every chain but BTC by construction
 * (capability staking is BTC-only). So the only chain that can reach this
 * predicate is the one whose local height IS the BTC height the threshold is
 * denominated in.
 *
 * MAINNET/TESTNET ARE UNALLOCATED (null = INERT). The four sub-decisions this
 * gate encodes were pinned by the operator on 2026-08-11; naming the height was
 * explicitly left as the operator's own piece, so the build lands code-complete
 * and inert until a height is ratified. Nearby anchors in use are 961000,
 * 962500 and 969500. Arming it needs the whole fleet deployed first: a lagging
 * node keeps splitting the full escrow and forks the reward rail.
 *
 * LOCAL COPY of the canonical maps in xchain-documentation/protocol/
 * constants.js; kept value-identical by test/unit/activationConstantsParity.test.js.
 * A one-sided edit forks the ATTEST fee settle at the flag-day.
 *
 ********************************************************************/

'use strict';

// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js). Compared against the LOCAL block_index
// of the SETTLING action (the ATTEST v1 response, or the v4 relay response), which is
// the block whose oracle price the conversion reads and the block the reward rows are
// stamped with.
// TESTNET ARMED AT 0, operator-ratified 2026-08-18 under the standing ruling that every
// platform feature must be ACTIVE on testnet, so nothing is found dormant after release.
// Safe for the same MEASURED reason as ATTEST_REQUEST_CAP_ACTIVATION rather than by
// assumption: this gate only changes how a fulfilled ATTEST settle splits its escrow, and
// the live explorer reports `total: 0` attestation rows EVER recorded on BTC, LTC and DOGE
// testnet alike (/{TBTC,TLTC,TDOGE}/api/attestations, checked 2026-08-18). No settle has
// ever happened on testnet, so there is no reward split to reinterpret and replay stays
// byte-identical. Mainnet is untouched and still operator-owned: it HAS attestation
// history, so pinning a height there needs its own measurement, not this one.
const ATTEST_BROADCAST_FEE_ACTIVATION = {
    mainnet: null,        // INERT placeholder: the operator owns this height (pinned 2026-08-11, unratified)
    testnet: 0,           // ARMED at genesis (operator-ratified 2026-08-18; zero historical attestation settles, so nothing is reinterpreted)
    regtest: 0,           // ARMED at genesis on regtest so the e2e venue exercises the carve-out
};

// Per-provider broadcast-fee allowance, denominated in NATIVE coin (whole coins, not
// satoshis), LOCAL COPY of the canonical map in xchain-documentation/protocol/constants.js.
//
// PROVIDERS holds the shipped per-provider default. DEFAULT covers a provider an
// operator registered through an ATTESTATION.PROVIDERS overlay that this map does not
// name. HARD_MAX is the ceiling every resolved value is clamped to, including one an
// overlay supplied, which is what keeps the bound consensus-visible rather than
// operator-controlled.
//
// SIZING. A BTC ATTEST v1 carrying a small response is a few hundred to a few thousand
// satoshis of miner fee at ordinary congestion. 0.0001 BTC (10,000 sat) covers that with
// room and still costs a fraction of a normal request fee, which is what "conservative"
// means here: the allowance is paid FLAT (see the header, decision 1), so an over-sized
// default would systematically overpay the leader out of the author's escrow. The llm
// provider carries the same figure; its responses are capped SMALLER than http_get's
// (16KB vs 32KB), so it has no case for a wider allowance.
//
// These values are consensus-visible the moment the gate arms, so a change to any of
// them needs its own flag-day exactly as the height does.
const ATTEST_BROADCAST_FEE_CAP = {
    DEFAULT:  '0.00010000',
    HARD_MAX: '0.00100000',
    PROVIDERS: {
        http_get: '0.00010000',
        llm:      '0.00010000',
    },
};

// Whether the leader broadcast-fee carve-out is in effect for a settle at `blockIndex`
// on `network`. Below the threshold (or an inert null / unknown network) -> off, and the
// legacy full-escrow split stays byte-identical.
function isAttestBroadcastFeeActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = ATTEST_BROADCAST_FEE_ACTIVATION[network];
    if(threshold === null || threshold === undefined) return false;
    return b >= threshold;
}

// Parse a cap value to a finite non-negative Number of whole native coin, or null when it
// is not usable. Deliberately strict: an overlay carrying a non-numeric, negative or
// non-finite value resolves to null and the caller falls back to the shipped default
// rather than reimbursing an amount no other node would compute.
function _parseCap(value){
    if(value === null || value === undefined) return null;
    let s = String(value).trim();
    if(s === '') return null;
    let n = Number(s);
    if(!Number.isFinite(n) || n < 0) return null;
    return n;
}

// The effective native-coin broadcast-fee allowance for `providerId`, as a decimal STRING.
//
// Resolution order: the overlay's own broadcast_fee_cap_native (when the operator
// registered one and it parses), else this module's per-provider default, else DEFAULT.
// The result is then clamped to HARD_MAX unconditionally, so no overlay can widen the
// bound past what the protocol ships.
//
// `providerDef` is the EFFECTIVE provider definition (ProviderRegistry.getProvider), which
// already folds any ATTESTATION.PROVIDERS overlay in. Pass null when the provider cannot be
// resolved; the shipped DEFAULT applies.
function broadcastFeeCapNative(providerId, providerDef){
    let hardMax = _parseCap(ATTEST_BROADCAST_FEE_CAP.HARD_MAX);
    let overlay = _parseCap(providerDef && providerDef.broadcast_fee_cap_native);
    let shipped = _parseCap(ATTEST_BROADCAST_FEE_CAP.PROVIDERS[String(providerId)]);
    let resolved = overlay !== null ? overlay
                 : (shipped !== null ? shipped : _parseCap(ATTEST_BROADCAST_FEE_CAP.DEFAULT));
    if(resolved === null) return '0';
    if(hardMax !== null && resolved > hardMax) resolved = hardMax;
    // Fixed 8dp: native-coin amounts are satoshi-precision everywhere else in the
    // codebase, and a fixed rendering keeps the string a node compares byte-stable.
    return resolved.toFixed(8);
}

module.exports = {
    ATTEST_BROADCAST_FEE_ACTIVATION,
    ATTEST_BROADCAST_FEE_CAP,
    isAttestBroadcastFeeActive,
    broadcastFeeCapNative
};
