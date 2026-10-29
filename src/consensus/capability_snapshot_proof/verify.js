'use strict';

// Copyright 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const ed25519 = require('../ed25519.js');
const M = require('../merkle.js');
const checkpointCanonical = require('../snapshot_checkpoint/canonical.js');
const { judgeCapabilityStakeProof } = require('./proof_binding.js');

const CHECKPOINT_VALIDATION_MEMO_CAP = 64;
const checkpointValidationMemo = new Map();

function held(reason){
    return { verdict: 'held', reason };
}

function sameBlock(left, right){
    const valid = value => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
        (typeof value === 'string' && /^\d+$/.test(value));
    if(!valid(left) || !valid(right)) return false;
    return BigInt(left) === BigInt(right);
}

function signatureRows(value){
    if(Array.isArray(value)) return value;
    if(typeof value !== 'string') return null;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : null;
    } catch(e){
        return null;
    }
}

// The signer pubkeys of a first-use checkpoint, lowercased, or null when it has no
// signatures or any listed signature fails. First use trusts the checkpoint's own
// signers, so a single bad signature voids the whole checkpoint.
function firstUseSigners(checkpoint){
    const signatures = signatureRows(checkpoint && checkpoint.validator_signatures);
    if(!signatures || signatures.length === 0) return null;

    let canonical;
    try {
        canonical = checkpointCanonical.snapshotCheckpointCanonical(checkpoint);
    } catch(e){
        return null;
    }

    const valid = signatures.every(signature => signature &&
        ed25519.verify(canonical, signature.sig, signature.pubkey));
    if(!valid) return null;
    return new Set(signatures.map(signature => String(signature.pubkey).toLowerCase()));
}

// Checkpoint quorum is shared by every capability row proved from that checkpoint.
// Include the signed canonical value, the exact signature carrier, the mode, and the
// exact pinned set including its non-index array metadata. A malformed cyclic carrier
// simply takes the uncached path.
function checkpointValidationKey(checkpoint, trustSet, firstUse){
    try {
        return JSON.stringify([
            checkpointCanonical.snapshotCheckpointCanonical(checkpoint),
            JSON.stringify(checkpoint.validator_signatures),
            firstUse === true ? 'first-use' : 'pinned',
            JSON.stringify(trustSet),
            Array.isArray(trustSet) && trustSet.truncated === true,
        ]);
    } catch(e){
        return null;
    }
}

function rememberCheckpointValidation(key, validation){
    if(key === null) return validation;
    checkpointValidationMemo.set(key, validation);
    while(checkpointValidationMemo.size > CHECKPOINT_VALIDATION_MEMO_CAP)
        checkpointValidationMemo.delete(checkpointValidationMemo.keys().next().value);
    return validation;
}

function checkpointValidation(checkpoint, trustSet, opts){
    const firstUse = trustSet === null && opts && opts.firstUse === true;
    const key = checkpointValidationKey(checkpoint, trustSet, firstUse);
    if(key !== null && checkpointValidationMemo.has(key)){
        const hit = checkpointValidationMemo.get(key);
        checkpointValidationMemo.delete(key);
        checkpointValidationMemo.set(key, hit);
        return hit;
    }

    if(trustSet !== null){
        let quorum = false;
        try {
            quorum = checkpointCanonical.snapshotCheckpointQuorum(
                checkpoint, trustSet, ed25519.verify);
        } catch(e){
            quorum = false;
        }
        return rememberCheckpointValidation(key, { quorum, firstUseSet: null, firstUseSetKey: null });
    }

    const firstUseSet = firstUse ? firstUseSigners(checkpoint) : null;
    return rememberCheckpointValidation(key, {
        quorum: firstUseSet !== null,
        firstUseSet,
        firstUseSetKey: firstUseSet === null ? null : Array.from(firstUseSet).sort().join(','),
    });
}

// The hub's regtest seam XDEX_SEED_LOCAL_VALIDATOR (xchain-hub
// src/lib/regtest_snapshot_seams.js) lets a single-hub regtest stack with no BTC stake
// finalize by writing its own key as the whole set, with source 'seed:<pubkey>' and
// weight 1. That row is never a stakes_root leaf, so the stake proof is a valid
// non-membership proof and the binding judge refuses it. On an unpinned regtest venue
// the hub's checkpoint signers are already the only trust anchor, so a seeded row
// whose key signed that same checkpoint claims nothing more than the checkpoint does.
// It is accepted only there: regtest, first use (no pin), the exact seed shape, a
// verified non-membership refusal, and the key among the checkpoint's signers.
// Every other network and every pinned venue keeps the refusal.
function isRegtestSeededSigner(row, network, signers, judged){
    if(network !== 'regtest' || !signers) return false;
    if(!judged || judged.verdict !== 'refused' ||
       judged.reason !== 'signing key is not a capability stake member') return false;
    if(!row || typeof row.signing_pubkey !== 'string' || typeof row.source !== 'string') return false;
    const pubkey = row.signing_pubkey.toLowerCase();
    if(row.source.toLowerCase() !== 'seed:' + pubkey) return false;
    let amount;
    try {
        amount = M.canonicalAmount(row.amount);
    } catch(e){
        return false;
    }
    if(amount !== M.canonicalAmount('1')) return false;
    return signers.has(pubkey);
}

function verifyCapabilitySnapshotProof(row, response, trustSet, opts){
    if(!response || typeof response !== 'object' || Array.isArray(response))
        return held('capability snapshot proof response is missing');
    if(!row || !sameBlock(response.snapshot_block, row.snapshot_block) ||
       response.capability !== row.capability)
        return held('capability snapshot proof response is for another snapshot');

    const network = opts && opts.network;
    const checkpoint = response.checkpoint;
    let expectedBlock;
    try {
        expectedBlock = checkpointCanonical.snapshotCheckpointBlock(row.snapshot_block, network);
    } catch(e){
        return held('snapshot checkpoint block cannot be derived');
    }
    if(!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint) ||
       checkpoint.chain !== 'BTC' || checkpoint.network !== network ||
       !sameBlock(checkpoint.block_index, expectedBlock))
        return held('snapshot checkpoint is for another chain, network, or block');

    const validation = checkpointValidation(checkpoint, trustSet, opts);
    if(!validation.quorum) return held('snapshot checkpoint does not have a valid quorum');
    if(validation.firstUseSetKey !== null && opts && typeof opts.noteFirstUseSet === 'function'){
        try {
            opts.noteFirstUseSet(validation.firstUseSetKey);
        } catch(e){
            // Observability must not alter the proof verdict.
        }
    }

    const judged = judgeCapabilityStakeProof(row, checkpoint, response.proof);
    if(isRegtestSeededSigner(row, network, validation.firstUseSet, judged))
        return { verdict: 'verified', reason: 'regtest seeded validator signed the snapshot checkpoint' };
    return judged;
}

function resetCheckpointValidationMemoForTest(){
    checkpointValidationMemo.clear();
}

module.exports = {
    verifyCapabilitySnapshotProof,
    _resetCheckpointValidationMemoForTest: resetCheckpointValidationMemoForTest,
};
