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
const checkpointCanonical = require('../snapshot_checkpoint/canonical.js');
const { judgeCapabilityStakeProof } = require('./proof_binding.js');

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

function firstUseQuorum(checkpoint){
    const signatures = signatureRows(checkpoint && checkpoint.validator_signatures);
    if(!signatures || signatures.length === 0) return false;

    let canonical;
    try {
        canonical = checkpointCanonical.snapshotCheckpointCanonical(checkpoint);
    } catch(e){
        return false;
    }

    return signatures.every(signature => signature &&
        ed25519.verify(canonical, signature.sig, signature.pubkey));
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

    let quorum = false;
    if(trustSet !== null){
        try {
            quorum = checkpointCanonical.snapshotCheckpointQuorum(
                checkpoint, trustSet, ed25519.verify);
        } catch(e){
            quorum = false;
        }
    } else if(opts && opts.firstUse === true){
        quorum = firstUseQuorum(checkpoint);
    }
    if(!quorum) return held('snapshot checkpoint does not have a valid quorum');

    return judgeCapabilityStakeProof(row, checkpoint, response.proof);
}

module.exports = { verifyCapabilitySnapshotProof };
