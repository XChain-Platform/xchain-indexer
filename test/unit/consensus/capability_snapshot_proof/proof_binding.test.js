/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict';

const assert = require('assert');
const M = require('../../../../src/consensus/merkle.js');
const stateSubtree = require('../../../../src/consensus/gates/state_subtree_gate.js');
const { judgeCapabilityStakeProof } = require(
    '../../../../src/consensus/capability_snapshot_proof/proof_binding.js');

const CAPABILITY = 'oracle_publish';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const BLOCK_INDEX = 100;

function fixture(){
    const tree = new M.SparseMerkleTree();
    tree.set(M.stakeKey(A, CAPABILITY), M.stakeMemberLeaf('source-a', '5'));
    tree.set(M.stakeKey(B, CAPABILITY), M.stakeMemberLeaf('source-b', '7'));

    const subRoots = {
        balances_root: 'd'.repeat(64),
        stakes_root: tree.rootHex(),
    };

    function checkpoint(network = 'testnet'){
        return {
            chain: 'BTC',
            network,
            block_index: BLOCK_INDEX,
            block_hash: 'e'.repeat(64),
            state_root: M.toHex(M.stateRoot(subRoots)),
            state_root_version: stateSubtree.stateRootVersion(BLOCK_INDEX, network, 'BTC'),
        };
    }

    function member(pubkey, source, weight){
        const proof = tree.prove(M.stakeKey(pubkey, CAPABILITY));
        return {
            pubkey,
            leaf_value: proof.leaf_value,
            siblings: proof.siblings,
            committed: proof.leaf_value === null ? null : { source, weight },
        };
    }

    function proof(members, override = {}){
        return Object.assign({ block_index: BLOCK_INDEX, sub_roots: subRoots, members }, override);
    }

    function row(pubkey = A, source = 'source-a', amount = '5'){
        return {
            snapshot_block: 106,
            capability: CAPABILITY,
            signing_pubkey: pubkey,
            source,
            amount,
        };
    }

    return { tree, subRoots, checkpoint, member, proof, row };
}

function expectVerdict(actual, expected, reason){
    assert.deepStrictEqual(Object.keys(actual).sort(), ['reason', 'verdict']);
    assert.strictEqual(actual.verdict, expected);
    assert.strictEqual(typeof actual.reason, 'string');
    assert.ok(actual.reason.length > 0);
    if(reason) assert.match(actual.reason, reason);
}

describe('capability snapshot proof binding @regression @tier1', function () {
    it('verifies a real member on testnet, mainnet, and regtest', function () {
        const f = fixture();
        const members = [f.member(B, 'source-b', '7'), f.member(A, 'source-a', '5')];

        for(const network of ['testnet', 'mainnet', 'regtest']){
            const checkpoint = f.checkpoint(network);
            assert.strictEqual(checkpoint.state_root_version,
                stateSubtree.stateRootVersion(BLOCK_INDEX, network, 'BTC'));
            expectVerdict(
                judgeCapabilityStakeProof(f.row(A, 'source-a', '5.0'), checkpoint, f.proof(members)),
                'verified');
        }
    });

    it('holds proofs that are absent, at another block, or stamped with another version', function () {
        const f = fixture();
        const checkpoint = f.checkpoint();
        const member = f.member(A, 'source-a', '5');

        expectVerdict(judgeCapabilityStakeProof(f.row(), checkpoint, null), 'held');
        expectVerdict(judgeCapabilityStakeProof(
            f.row(), checkpoint, f.proof([member], { block_index: BLOCK_INDEX + 1 })), 'held');
        expectVerdict(judgeCapabilityStakeProof(f.row(),
            Object.assign({}, checkpoint, { state_root_version: checkpoint.state_root_version === 1 ? 2 : 1 }),
            f.proof([member])), 'held');
        expectVerdict(judgeCapabilityStakeProof(f.row(),
            Object.assign({}, checkpoint, { state_root_version: String(checkpoint.state_root_version) }),
            f.proof([member])), 'verified');
    });

    it('holds malformed, unbound, and mismatched state roots', function () {
        const f = fixture();
        const checkpoint = f.checkpoint();
        const member = f.member(A, 'source-a', '5');

        expectVerdict(judgeCapabilityStakeProof(
            f.row(), checkpoint, f.proof([member], { sub_roots: null })), 'held');
        expectVerdict(judgeCapabilityStakeProof(f.row(), checkpoint,
            f.proof([member], { sub_roots: { balances_root: 'd'.repeat(64), stakes_root: '0'.repeat(64) } })),
        'held');
        expectVerdict(judgeCapabilityStakeProof(f.row(),
            Object.assign({}, checkpoint, { state_root: 'f'.repeat(64) }), f.proof([member])), 'held');
        expectVerdict(judgeCapabilityStakeProof(f.row(), checkpoint,
            f.proof([member], { sub_roots: { balances_root: 'not-hex', stakes_root: f.subRoots.stakes_root } })),
        'held');
    });

    it('holds malformed member collections and missing signer entries', function () {
        const f = fixture();
        const checkpoint = f.checkpoint();

        expectVerdict(judgeCapabilityStakeProof(f.row(), checkpoint, f.proof('members')), 'held');
        expectVerdict(judgeCapabilityStakeProof(
            f.row(), checkpoint, f.proof([f.member(B, 'source-b', '7')])), 'held');
        expectVerdict(judgeCapabilityStakeProof(
            f.row(A), checkpoint,
            f.proof([Object.assign(f.member(A, 'source-a', '5'), { pubkey: A.toUpperCase() })])),
        'verified');
    });

    it('holds invalid and malformed sibling paths without throwing', function () {
        const f = fixture();
        const checkpoint = f.checkpoint();
        const member = f.member(A, 'source-a', '5');
        const otherPath = f.member(B, 'source-b', '7').siblings;

        expectVerdict(judgeCapabilityStakeProof(f.row(), checkpoint,
            f.proof([Object.assign({}, member, { siblings: otherPath })])), 'held');
        expectVerdict(judgeCapabilityStakeProof(f.row(), checkpoint,
            f.proof([Object.assign({}, member, { siblings: member.siblings.slice(1) })])), 'held');
        expectVerdict(judgeCapabilityStakeProof(f.row(), checkpoint,
            f.proof([Object.assign({}, member, { siblings: member.siblings.map(() => 'not-hex') })])), 'held');
    });

    it('refuses a verified non-member', function () {
        const f = fixture();
        expectVerdict(judgeCapabilityStakeProof(
            f.row(C, 'source-c', '1'), f.checkpoint(), f.proof([f.member(C)])), 'refused');
    });

    it('holds missing, malformed, and leaf-inconsistent commitments', function () {
        const f = fixture();
        const checkpoint = f.checkpoint();
        const member = f.member(A, 'source-a', '5');

        expectVerdict(judgeCapabilityStakeProof(f.row(), checkpoint,
            f.proof([Object.assign({}, member, { committed: null })])), 'held');
        expectVerdict(judgeCapabilityStakeProof(f.row(), checkpoint,
            f.proof([Object.assign({}, member, { committed: { source: 'source-a', weight: 5 } })])), 'held');
        expectVerdict(judgeCapabilityStakeProof(f.row(A, 'source-a', '9'), checkpoint,
            f.proof([Object.assign({}, member,
                { committed: { source: 'source-a', weight: '9' } })])), 'held');
    });

    it('holds another source, refuses another amount, and holds malformed row amounts', function () {
        const f = fixture();
        const checkpoint = f.checkpoint();
        const proof = f.proof([f.member(A, 'source-a', '5')]);

        expectVerdict(judgeCapabilityStakeProof(
            f.row(A, 'source-z', '5'), checkpoint, proof), 'held', /multi-source key/);
        expectVerdict(judgeCapabilityStakeProof(
            f.row(A, 'source-a', '6'), checkpoint, proof), 'refused');
        expectVerdict(judgeCapabilityStakeProof(
            f.row(A, 'source-a', 'not-an-amount'), checkpoint, proof), 'held');
        expectVerdict(judgeCapabilityStakeProof(
            f.row(A, 'source-a', 5), checkpoint, proof), 'held');
    });
});
