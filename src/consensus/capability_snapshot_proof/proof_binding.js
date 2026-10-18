/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const M = require('../merkle.js');
const stateSubtree = require('../gates/state_subtree_gate.js');

const HEX_32 = /^[0-9a-fA-F]{64}$/;

function verdict(value, reason){
    return { verdict: value, reason };
}

function held(reason){
    return verdict('held', reason);
}

function refused(reason){
    return verdict('refused', reason);
}

function blockMatches(proofBlock, checkpointBlock){
    const valid = value => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
        (typeof value === 'string' && /^\d+$/.test(value));
    if(!valid(proofBlock) || !valid(checkpointBlock)) return false;
    return BigInt(proofBlock) === BigInt(checkpointBlock);
}

function stampedVersion(value){
    if(typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if(typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return null;
}

function findMember(members, signingPubkey){
    if(typeof signingPubkey !== 'string') return null;
    const wanted = signingPubkey.toLowerCase();
    return members.find(member => member && typeof member.pubkey === 'string' &&
        member.pubkey.toLowerCase() === wanted) || null;
}

function judgeCapabilityStakeProof(row, checkpoint, proof){
    if(!proof || typeof proof !== 'object' || Array.isArray(proof))
        return held('capability stake proof is missing');
    if(!checkpoint || typeof checkpoint !== 'object' ||
       !blockMatches(proof.block_index, checkpoint.block_index))
        return held('capability stake proof block does not match checkpoint');

    let expectedVersion;
    try {
        expectedVersion = stateSubtree.stateRootVersion(
            checkpoint.block_index, checkpoint.network, 'BTC');
    } catch(e){
        return held('checkpoint state root version cannot be derived');
    }
    if(stampedVersion(checkpoint.state_root_version) !== expectedVersion)
        return held('checkpoint state root version does not match derived version');

    const subRoots = proof.sub_roots;
    if(!subRoots || typeof subRoots !== 'object' || Array.isArray(subRoots) ||
       typeof subRoots.stakes_root !== 'string' || !HEX_32.test(subRoots.stakes_root))
        return held('capability stake proof sub-roots are malformed');

    let assembledRoot;
    try {
        assembledRoot = M.toHex(M.stateRoot(subRoots));
    } catch(e){
        return held('capability stake proof sub-roots are malformed');
    }
    if(typeof checkpoint.state_root !== 'string' ||
       assembledRoot.toLowerCase() !== checkpoint.state_root.toLowerCase())
        return held('capability stake proof sub-roots do not match checkpoint');

    if(!Array.isArray(proof.members))
        return held('capability stake proof members are malformed');
    const member = findMember(proof.members, row && row.signing_pubkey);
    if(!member)
        return held('capability stake proof has no matching member');

    let proofValid;
    try {
        const key = M.stakeKey(row.signing_pubkey, row.capability);
        proofValid = M.verifySmtProof(
            subRoots.stakes_root.toLowerCase(), key, member.leaf_value, member.siblings);
    } catch(e){
        return held('capability stake member proof is malformed');
    }
    if(!proofValid)
        return held('capability stake member proof is invalid');
    if(member.leaf_value === null)
        return refused('signing key is not a capability stake member');

    const committed = member.committed;
    if(!committed || typeof committed !== 'object' || Array.isArray(committed) ||
       typeof committed.source !== 'string' || typeof committed.weight !== 'string')
        return held('capability stake member commitment is missing');

    let committedLeaf;
    try {
        committedLeaf = M.toHex(M.stakeMemberLeaf(committed.source, committed.weight));
    } catch(e){
        return held('capability stake member commitment is malformed');
    }
    if(typeof member.leaf_value !== 'string' ||
       committedLeaf.toLowerCase() !== member.leaf_value.toLowerCase())
        return held('capability stake member commitment does not match leaf');

    if(committed.source !== (row && row.source))
        return held('multi-source key cannot bind this snapshot row');

    let committedAmount;
    let rowAmount;
    try {
        committedAmount = M.canonicalAmount(committed.weight);
        rowAmount = M.canonicalAmount(row.amount);
    } catch(e){
        return held('capability stake amount is malformed');
    }
    if(committedAmount !== rowAmount)
        return refused('capability stake amount does not match snapshot row');

    return verdict('verified', 'capability stake proof matches snapshot row');
}

module.exports = { judgeCapabilityStakeProof };
