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
 * ANCHOR quorum verification: the 2f+1 oracle_publish quorum over each
 * checkpoint canonical (the archive head's root signatures, every bundle
 * section's), and the SECOND quorum over the publisher attestation that
 * decides whether a reward is earned. Canonicals come from the handler
 * (index.js); rewards are credited by settle.js.
 *
 ********************************************************************/

const ed25519 = require('../../consensus/ed25519.js');
const swq     = require('../../consensus/stake_weighted_quorum.js');

// Verify 2f+1 oracle_publish signatures over the canonical.
// SNAPSHOT_BLOCK comes from the wire payload (a BTC height), NOT from
// the DOGE block this ANCHOR landed in.
// Hoisted so the publisher-attestation check below can REUSE the same
// oracle_publish set + weighting (no second query, no chance of a divergent set).
async function verifyHeadQuorum(handler, data, sigs, error){
    let weighted = false, validators = null, snapPubkeys = null, oracleN = 0;
    if(!error){
        let snapshotBlock = Number(data['SNAPSHOT_BLOCK']);
        // Stake-weighted (source-deduped) at/above STAKE_WEIGHTED_QUORUM (keyed on
        // the BTC snapshot_block + the checkpoint's network), else legacy 2f+1 count.
        weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, data['NETWORK']);
        validators = weighted
            ? await handler.indexerDb.getStakeWeightsByCapability('oracle_publish', snapshotBlock)
            : await handler.indexerDb.getValidatorsByCapability('oracle_publish', snapshotBlock);
        oracleN = (validators && validators.length) ? validators.length : 0;
        if(oracleN === 0){
            // No oracle_publish snapshot mirrored locally (offline resync / no hub).
            // Store as 'unverified'; recovery re-verifies from archived snapshots.
            data['STATUS'] = 'unverified';
        } else {
            let canonical = handler.canonical(data);
            snapPubkeys = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
            let validSigners = [], seen = new Set();
            for(let s of sigs){
                let pk = String(s.pubkey || '').toLowerCase();
                if(!pk || seen.has(pk)) continue;
                if(!snapPubkeys.has(pk)) continue;
                if(!ed25519.verify(canonical, s.sig, s.pubkey)) continue;
                // Mark seen only AFTER the signature verifies, matching the hub
                // finalizer (StateCheckpointEngine) and the SDK/explorer/sync
                // verifiers. Marking on first encounter lets a garbage-then-valid
                // pair for one qualified validator suppress the real signature
                // (order-dependent quorum under-count), failing a legitimately
                // quorate anchor closed and disagreeing with the hub on the same bytes.
                seen.add(pk);
                validSigners.push(pk);
            }
            let quorumMet = weighted
                ? swq.meetsStakeThreshold(validators, validSigners)
                : (validSigners.length >= ((oracleN <= 1) ? 1 : Math.max(2 * Math.floor((oracleN - 1) / 3) + 1, Math.ceil((oracleN + 1) / 2))));
            if(!quorumMet)
                error = 'invalid: insufficient ' + (weighted ? 'signer stake' : 'valid signatures (' + validSigners.length + '/' + oracleN + ')');
        }
    }
    return { error, weighted, validators, snapPubkeys, oracleN };
}

// Is the archive head's publisher-attestation quorum met, over the XANCPUB
// canonical, against the SAME set and weighting the root quorum resolved (`q`)?
function headAttestationMet(handler, data, publisherSigs, q){
    let { weighted, validators, snapPubkeys, oracleN } = q;
    let rewardCanonical = handler.rewardCanonical(data);
    let attSigners = [], attSeen = new Set();
    for(let s of publisherSigs){
        let pk = String(s.pubkey || '').toLowerCase();
        if(!pk || attSeen.has(pk)) continue;
        if(!snapPubkeys.has(pk)) continue;
        if(!ed25519.verify(rewardCanonical, s.sig, s.pubkey)) continue;
        // Mark seen only AFTER the signature verifies, matching the root-sig
        // loop above (and the hub/SDK verifiers): marking on first encounter
        // lets a garbage-then-valid pair for one qualified validator suppress
        // the real attestation (order-dependent quorum under-count).
        attSeen.add(pk);
        attSigners.push(pk);
    }
    let attQuorumMet = weighted
        ? swq.meetsStakeThreshold(validators, attSigners)
        : (attSigners.length >= ((oracleN <= 1) ? 1 : Math.max(2 * Math.floor((oracleN - 1) / 3) + 1, Math.ceil((oracleN + 1) / 2))));
    return attQuorumMet;
}

// Verify each section's 2f+1 oracle_publish quorum over its OWN canonical, against
// the set at its OWN snapshot block. Sets are memoized per block so the common case
// (every section sharing the bundle block) costs one query, and so two sections at
// the same block can never be judged against two different sets.
function makeOracleSetResolver(handler){
    let sets = new Map();
    const oracleSetFor = async (snapshotBlock, network) => {
        let key = String(snapshotBlock);
        if(sets.has(key)) return sets.get(key);
        let weighted   = swq.isStakeWeightedQuorumActive(Number(snapshotBlock), network);
        let validators = weighted
            ? await handler.indexerDb.getStakeWeightsByCapability('oracle_publish', Number(snapshotBlock))
            : await handler.indexerDb.getValidatorsByCapability('oracle_publish', Number(snapshotBlock));
        let entry = {
            weighted, validators,
            oracleN:     (validators && validators.length) ? validators.length : 0,
            snapPubkeys: new Set((validators || []).map(v => String(v.pubkey).toLowerCase()))
        };
        sets.set(key, entry);
        return entry;
    };
    return oracleSetFor;
}

// The bundle's section verdict: 'unverified' as a whole, a section's quorum
// failure as the whole bundle's error, or quorate, in which case the set at the
// bundle's own SNAPSHOT_BLOCK is returned for the publisher attestation.
async function verifySections(handler, data, sections, oracleSetFor, error){
    let bundleSet = null;
    if(!error){
        // A single section with no locally mirrored snapshot makes the WHOLE bundle
        // 'unverified', never a mix: the verdict is one column on N rows, and recovery
        // re-verifies from the archived snapshots either way.
        for(let s of sections){
            let set = await oracleSetFor(s.SNAPSHOT_BLOCK, s.NETWORK);
            if(set.oracleN === 0){ data['STATUS'] = 'unverified'; break; }
        }
    }
    if(!error && !data['STATUS']){
        for(let s of sections){
            let set = await oracleSetFor(s.SNAPSHOT_BLOCK, s.NETWORK);
            let canonical = handler.canonical(s);
            let validSigners = [], seen = new Set();
            for(let sig of s.SIGS){
                let pk = String(sig.pubkey || '').toLowerCase();
                if(!pk || seen.has(pk)) continue;
                if(!set.snapPubkeys.has(pk)) continue;
                if(!ed25519.verify(canonical, sig.sig, sig.pubkey)) continue;
                // Marked seen only AFTER the signature verifies, matching the archive
                // leg and the hub/SDK/explorer/sync verifiers: marking on first
                // encounter lets a garbage-then-valid pair for one qualified validator
                // suppress the real signature and fail a quorate section closed.
                seen.add(pk);
                validSigners.push(pk);
            }
            let quorumMet = set.weighted
                ? swq.meetsStakeThreshold(set.validators, validSigners)
                : (validSigners.length >= ((set.oracleN <= 1) ? 1 : Math.max(2 * Math.floor((set.oracleN - 1) / 3) + 1, Math.ceil((set.oracleN + 1) / 2))));
            if(!quorumMet){
                error = 'invalid: SECTION ' + s.SECTION_INDEX + ' insufficient ' +
                        (set.weighted ? 'signer stake' : 'valid signatures (' + validSigners.length + '/' + set.oracleN + ')');
                break;
            }
        }
        if(!error) bundleSet = await oracleSetFor(data['SNAPSHOT_BLOCK'], data['NETWORK']);
    }
    return { error, bundleSet };
}

// Is the bundle's ONE publisher-attestation quorum met, against the set at the
// bundle's SNAPSHOT_BLOCK?
function bundleAttestationMet(handler, data, bundleSet, publisherSigs){
    let rewardCanonical = handler.rewardCanonical(data);
    let attSigners = [], attSeen = new Set();
    for(let s of publisherSigs){
        let pk = String(s.pubkey || '').toLowerCase();
        if(!pk || attSeen.has(pk)) continue;
        if(!bundleSet.snapPubkeys.has(pk)) continue;
        if(!ed25519.verify(rewardCanonical, s.sig, s.pubkey)) continue;
        attSeen.add(pk);
        attSigners.push(pk);
    }
    let attQuorumMet = bundleSet.weighted
        ? swq.meetsStakeThreshold(bundleSet.validators, attSigners)
        : (attSigners.length >= ((bundleSet.oracleN <= 1) ? 1 : Math.max(2 * Math.floor((bundleSet.oracleN - 1) / 3) + 1, Math.ceil((bundleSet.oracleN + 1) / 2))));
    return attQuorumMet;
}

module.exports = {
    verifyHeadQuorum, headAttestationMet,
    makeOracleSetResolver, verifySections, bundleAttestationMet
};
