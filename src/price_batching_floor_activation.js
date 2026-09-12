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
 * PRE-BATCH ERA FLOOR for the price sync barriers.
 *
 * THE DEFECT (measured 2026-09-09 on testnet). A node replaying history older
 * than the price rail pays one FULL price-barrier timeout per transaction-
 * bearing block. With an empty local price_snapshots neither barrier escape
 * can open: no finalized round is anchored at or past the block (the content
 * case), and nothing advances the hub stream watermark past it (the watermark
 * case), so the block proceeds only when the barrier gives up, about 16 min a
 * block. A chain-only bootstrap across a pre-rail era therefore needs weeks,
 * which is what makes the chain-as-backup-of-last-resort posture true in
 * principle and unaffordable in practice.
 *
 * THE RULE (operator ruling, 2026-09-11, option b). The price barriers apply
 * only from the price rail's own start onward. Below that instant the era held
 * no price rounds at all, so there is nothing for a barrier to wait for and no
 * mirror completeness to police: the barrier resolves immediately instead of
 * waiting out its timeout. At or above it the barrier is byte-for-byte the
 * barrier that ships today.
 *
 * WHY THIS IS IDENTITY BELOW THE FLOOR, not a relaxed guard. The barriers
 * exist so that every node of a chain reads the SAME set of price rounds for a
 * block. A floor at or below the first round the network ever finalized means
 * every block under it has an empty eligible set on every node, connected or
 * chain-only, so skipping the wait changes no read. That bound is the arming
 * contract: a floor must never be set above the earliest finalized round's
 * consensus timestamp on that network, because a block between the first round
 * and the floor WOULD have rounds to read and would then read them off a
 * mirror nobody proved complete.
 *
 * THE AXIS IS TIME, not a chain height, for the reason
 * price_fee_batch_landed_activation.js records for its own bound and
 * price_pair_activation.js records for the pair widening: the barriers run on
 * every chain (the time-keyed one has no height argument at all, and the
 * height-keyed one's height belongs to the ORACLE REFERENCE chain, not to the
 * chain being processed), and BTC/LTC/DOGE heights diverge, so no single
 * height names one era boundary across them. The rail's start is one instant
 * and every barrier caller already supplies the chain-derived block time.
 *
 * FAILS CLOSED. Anything this module cannot evaluate - an unparseable or
 * missing block time, an unknown network, a network with no floor - yields
 * "the barrier applies", which is the behaviour the deployed fleet already
 * has. Closed costs a wait; open would let a block settle against a mirror no
 * one proved complete.
 *
 * NODE-LOCAL TIMING, NOT CONSENSUS. The barriers are never persisted and
 * never hashed; they decide WHEN a node may process a block, not what it
 * derives from it. So this floor has no canonical twin in
 * xchain-documentation and no parity row: it is the same class of constant as
 * HUB_SYNC_WATERMARK_GRACE_S, which the batching spec documents as needing no
 * activation gate for exactly this reason. It still moves fleet-wide in
 * lockstep, because two nodes with different floors disagree about which
 * blocks may proceed without a complete mirror.
 *
 * SHIPPED VALUES, and what arming each one needs. 0 means "no pre-batch era
 * is recognized on this network": the barrier applies to every block, which is
 * the deployed path. A positive value is a unix-second instant.
 *
 *   mainnet  0. No PRICE action has ever been indexed on any mainnet chain
 *            (measured 2026-09-09) and mainnet writes are held, so the rail
 *            has no start instant yet. Arm it to the mainnet rail's first
 *            finalized round when the price rail deploys there.
 *   testnet  0. The escape is where it is needed - testnet is the network the
 *            defect was measured on - but the floor's arming bound is a
 *            measurement, not a choice: the value is MIN(block_timestamp) over
 *            finalized price_snapshots rows on the testnet hub, which is a
 *            read this module cannot make. Arm it to that stamp (or to any
 *            earlier instant; earlier is always the safe direction).
 *   regtest  0, deliberately and not pending anything. A regtest stack has no
 *            oracle federation: rounds are SEEDED straight into
 *            price_snapshots at stamps the seeder chooses, including
 *            re-stamped synthetic rounds below early blocks, so no instant on
 *            a regtest chain is provably below every round it will ever hold.
 *
 ********************************************************************/

'use strict';

// Per-network pre-batch era floor, as a unix-second block time. 0 (or an
// absent/unknown network) means the barrier applies at every block. A
// '<COIN>:<network>' key wins over the bare network key, so one chain's rail
// start can differ from its siblings' without splitting the map.
const PRICE_BATCHING_FLOOR_ACTIVATION = {
    mainnet: 0,
    testnet: 0,
    regtest: 0,
};

// Resolve the raw map entry: '<COIN>:<network>' first, then the bare network.
function _floorEntry(network, coin) {
    if (coin != null && PRICE_BATCHING_FLOOR_ACTIVATION[coin + ':' + network] !== undefined)
        return PRICE_BATCHING_FLOOR_ACTIVATION[coin + ':' + network];
    return PRICE_BATCHING_FLOOR_ACTIVATION[network];
}

// The floor in force for `network`/`coin`, as a positive unix-second instant, or
// 0 for "no pre-batch era" - which is what an unknown network, an unarmed entry
// and an unusable value all resolve to, so every caller gets the fail-closed
// answer from one place.
function priceEraFloorS(network, coin) {
    let floor = Number(_floorEntry(network, coin));
    if (!Number.isFinite(floor) || floor <= 0) return 0;
    return floor;
}

// Whether a block at `blockTime` sits in the pre-batch era of a rail whose floor
// is `floorS`. The one comparator both the resolved-map form below and the
// barriers themselves use, so an instance carrying its own resolved floor cannot
// drift from the map.
//
// The empty-ish values are rejected BEFORE Number(), which maps null, '' and
// false to a perfectly finite 0: an armed floor would read a missing block time
// as the oldest possible block and skip the barrier on it, which is the one
// thing failing closed must never do.
function isPreBatchEraFloor(blockTime, floorS) {
    let floor = Number(floorS);
    if (!Number.isFinite(floor) || floor <= 0) return false;
    if (blockTime === null || blockTime === undefined || blockTime === '' ||
        typeof blockTime === 'boolean') return false;
    let t = Number(blockTime);
    if (!Number.isFinite(t) || t <= 0) return false;
    return t < floor;
}

// Whether a block at `blockTime` on `network`/`coin` is below that network's
// pre-batch era floor, i.e. the price barriers have nothing to wait for.
function isPreBatchEra(blockTime, network, coin) {
    return isPreBatchEraFloor(blockTime, priceEraFloorS(network, coin));
}

// Whether the price barriers apply to a block at `blockTime` on `network`/`coin`.
// The inverse of isPreBatchEra, named for the call site that reads better as a
// positive: everything unevaluable answers true.
function isPriceBarrierRequired(blockTime, network, coin) {
    return !isPreBatchEra(blockTime, network, coin);
}

module.exports = {
    PRICE_BATCHING_FLOOR_ACTIVATION,
    priceEraFloorS,
    isPreBatchEraFloor,
    isPreBatchEra,
    isPriceBarrierRequired,
};
