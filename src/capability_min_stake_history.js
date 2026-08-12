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
 * XChain Platform: as-of-block capability MIN_STAKE reconstruction.
 *
 * A capability's qualifying validator set is defined by a threshold that is
 * BLOCK-ANCHORED: xchain-hub resolves it through
 * CapabilityRegistry.getMinStake(capability, blockIndex), walking a
 * block-anchored history (genesis value, then one entry per finalized
 * governance change) to the value effective AT that block. Making the
 * threshold a deterministic function of block height is what makes a
 * snapshot federation-deterministic: every hub resolving the same block
 * folds in the same min_stake and agrees on quorum N. db.js honours a
 * caller-supplied minStake verbatim for the same reason: it never clamps to
 * this node's own coin-config floor, since local config drifts between
 * independently-operated indexers.
 *
 * THE HOLE THIS CLOSES. AnchorRecovery._verifyCompleteness re-derives the
 * qualifying set for an archived snapshot and checks that the archive
 * dropped no qualifying source, but it passed no threshold, so db.js applied
 * this node's local coin-config MIN_STAKE, not the bar the archive was built
 * at. A governance MIN_STAKE above the local floor makes the check stricter
 * than the honest hub that wrote the archive: the re-resolution reports
 * sources the hub correctly excluded, and disaster recovery halts on honest
 * data. Below the local floor the check merely under-catches.
 *
 * Recovery runs with no surviving hub database and the indexer mirrors no
 * hub governance table, so the only source that survives a total hub loss is
 * a frozen, block-anchored table shipped in the software itself. This module
 * is that table plus the resolution rule, so recovery reconstructs the
 * threshold the archive was built at from the snapshot block alone.
 *
 * ARMING IS A COORDINATED FLEET ACT, NOT AN EDIT HERE. MIN_STAKE_ACTIVATIONS
 * is empty on every network today: the hub pins governance MIN_STAKE changes
 * off and asserts its genesis value against the canonical coins registry at
 * boot, so the effective threshold everywhere is the genesis floor and this
 * module reproduces that exactly. Adding an entry changes acceptance (which
 * archives verify, and on the live path which validators qualify), so it
 * must land in the SAME coordinated release as the matching hub-side history
 * or the two resolve different sets for the same block and fork. Never add
 * an entry to "match" a hub that has already moved: fix the hub.
 *
 * PLANE. Callers resolve at the height they actually re-derive the validator
 * set at, which for a capability snapshot is the declared snapshot_block
 * already buried by snapshot_reorg_buffer.js (the hub buries first and
 * resolves its own threshold at the buried height). Resolving the threshold
 * at the raw height while resolving the set at the buried one would
 * reintroduce, in the threshold, precisely the split this module removes.
 *
 ********************************************************************/

'use strict';

const mathjs = require('mathjs');

// Frozen block-anchored governance MIN_STAKE history, per network, per capability:
// an ascending list of { activation_block, value } entries, each the threshold
// EFFECTIVE FROM that block until the next entry. Mirrors the shape of
// xchain-hub CapabilityRegistry.minStakeHistory.
//
// EMPTY on every network: no governance MIN_STAKE change has ever activated, so
// the threshold at every block is the genesis floor the caller supplies (the
// frozen coin-config constant the hub asserts its own value against at boot).
// See the header before adding an entry - it is a consensus flag day, not config.
const MIN_STAKE_ACTIVATIONS = {
    mainnet: {},
    testnet: {},
    regtest: {},
};

// Decimal-string amount as a full-precision bignumber (never a JS double).
// Non-numeric input is NOT coerced to 0 here - callers need to tell "0" from
// "unusable", so this returns null and each call site decides.
function amount(v){
    if(v === null || v === undefined || typeof v === 'boolean') return null;
    let s = String(v).trim();
    if(s === '' || !/^\d+(\.\d+)?$/.test(s)) return null;
    return mathjs.bignumber(s);
}

// The governance history in force for `network`. `override` (an operator-supplied
// map of the SAME shape) wins when present: a DR operator replaying a federation
// whose ratified history is not in this build, and the tests that pin the
// resolution, need a way in that does not involve editing a frozen consensus
// table. It is an OPERATOR input, never an archive-derived one - the whole point
// of this module is that the archive cannot choose the bar it is judged at.
function historyFor(network, override){
    let src = (override && typeof override === 'object') ? override : MIN_STAKE_ACTIVATIONS[network];
    return (src && typeof src === 'object') ? src : null;
}

// The capability MIN_STAKE effective at `blockIndex`: the value of the entry with
// the greatest activation_block <= blockIndex, else `genesisFloor`. Byte-mirrors
// xchain-hub CapabilityRegistry.getMinStake(capability, blockIndex).
//
// Returns a decimal STRING, or null when nothing can be resolved (no history entry
// applies AND no genesis floor was supplied). Null is meaningful to callers: it
// means "pass no override", which leaves db.js applying its own local floor, i.e.
// exactly the prior behaviour. That keeps a handle with no coin config (a
// unit fixture, an embedder holding a bare query handle) working unchanged
// instead of failing on a threshold it has no way to know.
//
// Fails to the GENESIS floor, never to a bar of its own invention, on anything it
// cannot evaluate (unparseable height, malformed entry, unknown network).
function minStakeAt(capability, blockIndex, network, genesisFloor, override){
    let genesis = (amount(genesisFloor) === null) ? null : String(genesisFloor).trim();
    let hist    = historyFor(network, override);
    let entries = (hist && Array.isArray(hist[capability])) ? hist[capability] : null;
    if(!entries || entries.length === 0) return genesis;
    // Reject the empty-ish values BEFORE Number(), which maps null/''/false to a
    // perfectly finite 0 and would then pick up a block-0 activation entry.
    if(blockIndex === null || blockIndex === undefined || blockIndex === '' || typeof blockIndex === 'boolean')
        return genesis;
    let bi = Number(blockIndex);
    if(!Number.isFinite(bi)) return genesis;
    let resolved = null, resolvedAt = -1;
    for(let e of entries){
        if(!e) continue;
        let ab = Number(e.activation_block);
        if(!Number.isInteger(ab) || ab < 0) continue;         // malformed entry: ignore, don't guess
        if(amount(e.value) === null) continue;                // ditto for a malformed threshold
        if(ab > bi) continue;                                 // not in effect at this block yet
        // >= so a later-listed entry at the same activation_block wins deterministically,
        // whatever order the table lists them in.
        if(ab >= resolvedAt){ resolved = String(e.value).trim(); resolvedAt = ab; }
    }
    return (resolved !== null) ? resolved : genesis;
}

// a + b as a decimal string, with an unusable operand treated as 0 (the caller has
// already decided the operand is optional; see AnchorRecovery._slashRestoresAfter,
// where a source with no slash debit simply restores nothing).
function addAmount(a, b){
    let x = amount(a) || mathjs.bignumber(0);
    let y = amount(b) || mathjs.bignumber(0);
    return mathjs.format(mathjs.add(x, y), { notation: 'fixed' });
}

// -1 / 0 / 1 for a<b / a==b / a>b, or null when either side is unusable so the
// caller can fail closed rather than read a bogus 0.
function cmpAmount(a, b){
    let x = amount(a), y = amount(b);
    if(x === null || y === null) return null;
    if(mathjs.smaller(x, y)) return -1;
    if(mathjs.larger(x, y))  return 1;
    return 0;
}

// Numeric equality of two decimal strings ('5' == '5.00000000'). Unusable input is
// never "equal".
function amountsEqual(a, b){
    return cmpAmount(a, b) === 0;
}

module.exports = {
    MIN_STAKE_ACTIVATIONS,
    minStakeAt,
    addAmount,
    cmpAmount,
    amountsEqual,
};
