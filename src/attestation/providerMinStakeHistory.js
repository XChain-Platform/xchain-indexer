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
 * XChain Indexer: as-of-block PROVIDER min_stake_xchain reconstruction.
 *
 * Two different stake bars gate an attestation round, and they are not the
 * same number:
 *   - the CAPABILITY threshold (STAKING.CAPABILITIES.attestation.MIN_STAKE,
 *     1000 XCHAIN) decides who holds the `attestation` capability at all;
 *   - the PROVIDER floor (this file) is a HIGHER, per-provider bar on top of
 *     it, because serving an `llm` attestation should cost more stake than
 *     serving an `http_get` one.
 *
 * The provider floor is consensus input: at/above STAKE_WEIGHTED_QUORUM the
 * responsible-set derivation drops below-floor sources, so a hub and an
 * indexer that resolve different floors for the same block select different
 * responsible validators, drop each other's signatures, and fork. That makes
 * the floor a function of BLOCK HEIGHT, exactly like the capability threshold
 * in capability_min_stake_history.js, whose shape this file mirrors.
 *
 * WHY A FROZEN TABLE RATHER THAN A HUB READ. xchain-hub resolves the same
 * value through ProviderRegistry.getMinStake(providerId, blockIndex), walking
 * a block-anchored history seeded from its static DEFAULTS and layered with
 * finalized ATTESTATION_PROVIDER governance activations. The indexer mirrors
 * no hub governance table (its getallconfigs mirror is a LIVE snapshot with
 * no activation history), so reading the hub would make a consensus value
 * depend on when each indexer last polled. A frozen table shipped in the
 * software is the only source that resolves identically on every node and
 * survives a total hub loss.
 *
 * ARMING IS A COORDINATED FLEET ACT, NOT AN EDIT HERE. PROVIDER_MIN_STAKE_
 * ACTIVATIONS is empty on every network: no ATTESTATION_PROVIDER governance
 * proposal has ever activated, so the floor at every block is the genesis
 * value shipped in providerRegistry.js PROVIDERS, which equals the hub's
 * ProviderRegistry DEFAULTS. Adding an entry changes which validators are
 * responsible, so it must land in the SAME coordinated release as the
 * matching hub-side governance activation. Never add an entry to "match" a
 * hub that has already moved: hold the hub's activation instead.
 *
 * PLANE. The floor resolves at the request's DECLARED block, not the buried
 * one, because that is the height xchain-hub AttestationRound resolves its
 * own block-anchored provider config at (it hands CapabilitySnapshot the raw
 * request.block_index and the snapshot buries internally). Validator sets are
 * resolved at the buried height; the threshold is not. Moving either plane
 * alone reintroduces the split both anchorings exist to remove.
 *
 ********************************************************************/

'use strict';

const mathjs = require('mathjs');

// Frozen block-anchored governance min_stake_xchain history, per network, per
// provider: an ascending list of { activation_block, value } entries, each the
// floor EFFECTIVE FROM that block until the next entry. Mirrors the shape of
// xchain-hub ProviderRegistry.providerConfigHistory (whose entries carry
// min_stake_xchain alongside additional_config) and of MIN_STAKE_ACTIVATIONS
// in capability_min_stake_history.js.
//
// EMPTY on every network. See the header before adding an entry: it is a
// consensus flag day, not config.
const PROVIDER_MIN_STAKE_ACTIVATIONS = {
    mainnet: {},
    testnet: {},
    regtest: {},
};

// A provider floor is usable only as a plain non-negative decimal string. This is
// the SAME acceptance regex as xchain-hub ProviderRegistry.normalizeMinStakeXchain,
// deliberately not Number(): the value is compared against staked amounts at full
// precision on both sides of the federation, and a float round-trip would put the
// divergence back that the anchoring removes.
function normalizeFloor(value){
    if(value === null || value === undefined || typeof value === 'boolean') return null;
    let s = String(value).trim();
    if(!/^\d+(\.\d+)?$/.test(s)) return null;
    return s;
}

// The governance history in force for `network`. `override` (an operator-supplied
// map of the SAME shape) wins when present, so a test or a DR replay can pin a
// history that is not in this build without editing a frozen consensus table.
function historyFor(network, override){
    let src = (override && typeof override === 'object') ? override : PROVIDER_MIN_STAKE_ACTIVATIONS[network];
    return (src && typeof src === 'object') ? src : null;
}

// The provider floor effective at `blockIndex`: the value of the entry with the
// greatest activation_block <= blockIndex, else `genesisFloor`. Byte-mirrors
// xchain-hub ProviderRegistry.getMinStake(providerId, blockIndex).
//
// Returns a decimal STRING, or null when nothing resolves. Null is FAIL-CLOSED
// for a consensus caller: it means "this node cannot know the bar", and the
// responsible set must come back empty rather than be computed against an
// invented floor of 0, which would silently widen the serving set. That is the
// same posture xchain-hub CapabilitySnapshot._resolveMinStake takes (#S-F3).
//
// Falls back to the GENESIS floor, never to a bar of its own invention, on
// anything it cannot evaluate (unparseable height, malformed entry, unknown
// network).
function providerMinStakeAt(providerId, blockIndex, network, genesisFloor, override){
    let genesis = normalizeFloor(genesisFloor);
    let hist    = historyFor(network, override);
    let entries = (hist && Array.isArray(hist[providerId])) ? hist[providerId] : null;
    if(!entries || entries.length === 0) return genesis;
    // Reject the empty-ish heights BEFORE Number(), which maps null/''/false to a
    // perfectly finite 0 and would then pick up a block-0 activation entry.
    if(blockIndex === null || blockIndex === undefined || blockIndex === '' || typeof blockIndex === 'boolean')
        return genesis;
    let bi = Number(blockIndex);
    if(!Number.isFinite(bi)) return genesis;
    let resolved = null, resolvedAt = -1;
    for(let e of entries){
        if(!e) continue;
        let ab = Number(e.activation_block);
        if(!Number.isInteger(ab) || ab < 0) continue;   // malformed entry: ignore, don't guess
        if(normalizeFloor(e.value) === null) continue;  // ditto for a malformed floor
        if(ab > bi) continue;                           // not in effect at this block yet
        // >= so a later-listed entry at the same activation_block wins deterministically,
        // whatever order the table lists them in.
        if(ab >= resolvedAt){ resolved = normalizeFloor(e.value); resolvedAt = ab; }
    }
    return (resolved !== null) ? resolved : genesis;
}

// CONSENSUS-CRITICAL predicate: does a weighted-snapshot row clear the provider
// floor? `weight` is the row's SOURCE-AGGREGATE stake (getStakeWeightsByCapability
// gives every key of a source the same weight), so the floor is a bar on the
// staking address, not on each delegated key: a source cannot clear a 25000 floor
// by splitting 25000 across five keys, and does not have to stake 25000 per key.
//
// An unusable weight or an unusable floor EXCLUDES the row. Excluding is the safe
// direction (it can only shrink the responsible set, which the callers' existing
// unfinalizable-round guards already handle) and it is what makes the rule
// writable identically in all four copies. This mirrors
// xchain-hub AttestationRound._meetsProviderFloor byte for byte.
//
// The comparison is decimal.js `.gte()` on mathjs bignumbers, which is what BOTH
// bcgte implementations reduce to (xchain-hub src/bcmath.js, xchain-indexer
// src/utility.js). It is deliberately NOT mathjs.largerEq / cmpAmount: those apply
// mathjs's ~1e-12 relative comparison epsilon, so two amounts a hair apart compare
// EQUAL, and a consensus predicate that rounds is a fork surface. Reimplemented
// here rather than taken from utility.js because rollback.js and actions/attest.js
// must apply the identical rule and only one of them holds a Utility instance.
function meetsProviderFloor(weight, minStake){
    let floor = normalizeFloor(minStake);
    if(floor === null) return false;
    let w = normalizeFloor(weight);
    if(w === null) return false;
    return mathjs.bignumber(w).gte(mathjs.bignumber(floor));
}

module.exports = {
    PROVIDER_MIN_STAKE_ACTIVATIONS,
    normalizeFloor,
    providerMinStakeAt,
    meetsProviderFloor,
};
