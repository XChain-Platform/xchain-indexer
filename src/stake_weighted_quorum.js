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
 * XChain Platform: Stake-Weighted Quorum (STAKE_WEIGHTED_QUORUM / WI-1)
 *
 * THE single, CONSENSUS-CRITICAL implementation of the stake-weighted quorum
 * predicate. The canonical source of record is
 * xchain-documentation/protocol/reference-impl/stake_weighted_quorum.js; it is
 * vendored BYTE-IDENTICALLY into xchain-hub, xchain-indexer, xchain-explorer,
 * xchain-sdk and xchain-sync. Every PBFT tally engine, every settlement gate
 * (cross_settle, xexec, xcall, anchor, price, attest), the recovery verifier and
 * the client/explorer checkpoint verifiers resolve through this predicate so they
 * can never drift; a divergence forks the chain.
 *
 * The cross-service conformance suite (ConsensusPrimitiveConformance.test.js,
 * driven by xchain-documentation/protocol/test-vectors) runs in every repo and
 * asserts BOTH the behavior (canonical vectors) AND byte-identity of the local
 * copy to this canonical source, so any unmirrored edit fails CI everywhere.
 *
 * Self-contained on mathjs bignumber (exact, never a JS double): the predicate is
 * a pure function with no injected utility instance, so it is identical in every
 * repo regardless of that repo's local math helpers.
 *
 ********************************************************************/

const mathjs = require('mathjs');

// Per-network activation height (LOCAL COPY of the canonical map in
// xchain-documentation/protocol/constants.js, kept equal by the cross-service
// regression suite). Keyed on the BTC-anchored snapshot_block, NOT each chain's
// local height, so every chain + the hub flip on the same anchor.
const STAKE_WEIGHTED_QUORUM_ACTIVATION = {
    mainnet: 961000,      // ARMED 2026-07-07: BTC anchor ~2026-08-04; deploy hub + ALL indexers (+ sdk/explorer/sync copies) before this height
    testnet: 0,
    regtest: 0,
};

// Whether stake-weighted quorum is in effect for a round whose BTC-anchored
// snapshot is at `snapshotBlock` on `network`. Below this -> legacy count quorum.
function isStakeWeightedQuorumActive(snapshotBlock, network){
    let sb = parseInt(snapshotBlock);
    if(!Number.isFinite(sb)) return false;
    let threshold = STAKE_WEIGHTED_QUORUM_ACTIVATION[network];
    if(threshold === undefined) return false;   // unknown network -> off (safe)
    return sb >= threshold;
}

// Coerce to a full-precision bignumber (never a JS double); non-numeric -> 0.
function bcnum(v){
    let s = (v === null || v === undefined) ? '0' : String(v).trim();
    if(s === '' || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return mathjs.bignumber(0);
    return mathjs.bignumber(s);
}

// Total active snapshot stake S = sum of weight over DISTINCT sources.
function totalStake(validators){
    // A TRUNCATED snapshot (set-building query overflowed its cap and marked the
    // returned array `truncated`) has silently-dropped sources, so its sum is
    // meaningless; hard error, mirroring the blank-source / negative-weight guards
    // below and meetsStakeThreshold's fail-closed truncation check.
    if(validators && validators.truncated === true)
        throw new Error('stake_weighted_quorum.totalStake: truncated snapshot cannot be summed');
    let weightBySource = new Map();
    for(let v of (validators || [])){
        // Hard error on a blank/missing source. See meetsStakeThreshold: a blank source
        // collapses every row into one bucket, so S over a blank-source snapshot is meaningless.
        if(!v || v.source === null || v.source === undefined || String(v.source).trim() === '')
            throw new Error('stake_weighted_quorum.totalStake: blank/missing source would collapse the stake bucket');
        let src = String(v.source);
        if(!weightBySource.has(src))
            weightBySource.set(src, (v.weight === null || v.weight === undefined) ? '0' : String(v.weight));
    }
    let S = mathjs.bignumber(0);
    for(let w of weightBySource.values()){
        let bw = bcnum(w);
        // Mirror meetsStakeThreshold: bcnum accepts a leading '-', and S over a
        // snapshot holding a negative weight is meaningless. Hard error, like the
        // blank-source case above.
        if(bw.lt(0))
            throw new Error('stake_weighted_quorum.totalStake: negative weight in snapshot');
        S = mathjs.add(S, bw);
    }
    return S;
}

// Source-deduped stake-weighted quorum test.
//   validators      full snapshot: [{ pubkey, source, weight }]  (every key of a
//                   source carries the SAME source + weight)
//   signerPubkeys   iterable of pubkeys that produced a VALID signature
// Returns true iff 3*sum(distinct signing-source weight) > 2*S, where
// S = sum(weight over DISTINCT sources). A source counts ONCE no matter how many of
// its keys signed (DELEGATE v0 is additive). Degenerate cases fall out with no
// special-casing: single source -> 3S>2S true; empty/zero-stake set -> 0>0 false.
// A blank/missing source FAILS CLOSED (returns false); it is NOT a single source.
// A NEGATIVE weight anywhere in the snapshot, or a non-positive total stake S,
// also FAILS CLOSED: bcnum accepts a leading '-', and a corrupt/malicious snapshot
// row driving S <= 0 would otherwise let the strict 3*tally > 2*S test hold for an
// EMPTY signer set (0 > negative). A snapshot that cannot express a meaningful
// two-thirds threshold must never finalize.
function meetsStakeThreshold(validators, signerPubkeys){
    // Fail CLOSED on a TRUNCATED snapshot. The set-building query
    // (getStakeWeightsByCapability) caps its result and marks `truncated` on the
    // returned array when the qualifying set overflowed the cap. A truncated snapshot
    // has silently-dropped sources, so S is under-counted and the strict 2/3 bar could
    // finalize a round a full snapshot would reject - a stake-eviction forge (one source
    // spamming keys to evict honest sources), or organic silent drift once the federation
    // outgrows the cap. A snapshot that cannot be fully materialised must never finalize;
    // the operators raise the cap (coordinated) instead. Plain-array callers (no property)
    // are unaffected. CONSENSUS-CRITICAL: keep byte-identical across all vendored copies.
    if(validators && validators.truncated === true) return false;
    let weightBySource = new Map();   // source -> weight (first wins; all equal per source)
    let pubkeyToSource = new Map();   // pubkey(lower) -> source
    for(let v of (validators || [])){
        // Fail CLOSED on a blank/missing source: an empty-string (snapshot schema NOT NULL
        // DEFAULT '') or undefined source collapses every row into ONE dedupe bucket, dropping
        // the threshold to 1-of-N (a single signature would finalize). A malformed snapshot
        // must never finalize; reject the whole tally.
        if(!v || v.source === null || v.source === undefined || String(v.source).trim() === '') return false;
        let src = String(v.source);
        let pk  = String(v.pubkey).toLowerCase();
        pubkeyToSource.set(pk, src);
        if(!weightBySource.has(src))
            weightBySource.set(src, (v.weight === null || v.weight === undefined) ? '0' : String(v.weight));
    }
    // S = sum of weight over distinct sources in the snapshot. Fail CLOSED on any
    // negative weight, then on S <= 0 (see the contract comment above): with S
    // driven to or below zero, 3*tally > 2*S would finalize on zero signatures.
    let S = mathjs.bignumber(0);
    for(let w of weightBySource.values()){
        let bw = bcnum(w);
        if(bw.lt(0)) return false;
        S = mathjs.add(S, bw);
    }
    if(S.lte(0)) return false;
    // Tally = sum of weight over the DISTINCT sources represented by valid signers.
    let countedSources = new Set();
    let seenPubkeys    = new Set();
    let tally          = mathjs.bignumber(0);
    for(let pk of (signerPubkeys || [])){
        let lpk = String(pk).toLowerCase();
        if(seenPubkeys.has(lpk)) continue;
        seenPubkeys.add(lpk);
        let src = pubkeyToSource.get(lpk);
        if(src === undefined) continue;          // signer not in snapshot
        if(countedSources.has(src)) continue;    // source already counted
        countedSources.add(src);
        tally = mathjs.add(tally, bcnum(weightBySource.get(src)));
    }
    // Strictly greater than two-thirds of stake, integer-free: 3*tally > 2*S.
    // Use the bignumber's exact `.gt` (decimal.js), NOT mathjs.larger, which
    // applies a ~1e-12 relative epsilon and would treat large near-equal stake
    // totals as equal, flipping the verdict at the boundary.
    return mathjs.multiply(tally, 3).gt(mathjs.multiply(S, 2));
}

module.exports = {
    STAKE_WEIGHTED_QUORUM_ACTIVATION,
    isStakeWeightedQuorumActive,
    totalStake,
    meetsStakeThreshold,
};
