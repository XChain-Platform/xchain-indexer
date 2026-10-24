/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const sinon = require('sinon');

const M = require('../../../src/consensus/merkle.js');
const stateSubtree = require('../../../src/consensus/gates/state_subtree_gate.js');
const gates = require('../../../src/consensus/gate_registry.js');
const checkpointCanonical = require('../../../src/consensus/snapshot_checkpoint/canonical.js');
const capabilityProof = require('../../../src/consensus/capability_snapshot_proof/verify.js');
const { usesCapabilitySnapshot } = require('../../../src/db/shared.js');
const { verifyCapabilitySnapshotRow } = require('../../../src/db/database/stake_weights.js');

const SNAPSHOT_BLOCK = 106;
const CHECKPOINT_BLOCK = 100;

function keypair(source){
    const pair = crypto.generateKeyPairSync('ed25519');
    const pubkey = pair.publicKey.export({ format: 'der', type: 'spki' })
        .subarray(-32).toString('hex');
    return { privateKey: pair.privateKey, pubkey, source, weight: '1' };
}

function fixture(){
    const signer = keypair('source-a');
    const row = {
        snapshot_block: SNAPSHOT_BLOCK,
        capability: 'archive_publish',
        signing_pubkey: signer.pubkey,
        source: signer.source,
        amount: signer.weight,
    };
    const tree = new M.SparseMerkleTree();
    tree.set(M.stakeKey(row.signing_pubkey, 'oracle_publish'),
        M.stakeMemberLeaf(row.source, row.amount));
    const member = tree.prove(M.stakeKey(row.signing_pubkey, 'oracle_publish'));
    const subRoots = {
        balances_root: 'd'.repeat(64),
        stakes_root: tree.rootHex(),
    };
    const checkpoint = {
        chain: 'BTC',
        network: 'regtest',
        block_index: CHECKPOINT_BLOCK,
        block_hash: 'e'.repeat(64),
        state_root: M.toHex(M.stateRoot(subRoots)),
        state_root_version: stateSubtree.stateRootVersion(
            CHECKPOINT_BLOCK, 'regtest', 'BTC'),
    };
    const canonical = checkpointCanonical.snapshotCheckpointCanonical(checkpoint);
    checkpoint.validator_signatures = [{
        pubkey: signer.pubkey,
        sig: crypto.sign(null, Buffer.from(canonical, 'utf8'), signer.privateKey)
            .toString('hex'),
    }];
    const response = {
        snapshot_block: SNAPSHOT_BLOCK,
        capability: 'oracle_publish',
        checkpoint,
        proof: {
            block_index: CHECKPOINT_BLOCK,
            sub_roots: subRoots,
            members: [{
                pubkey: signer.pubkey,
                leaf_value: member.leaf_value,
                siblings: member.siblings,
                committed: { source: row.source, weight: row.amount },
            }],
        },
    };
    return { row, response };
}

afterEach(function(){ sinon.restore(); });

describe('archive_publish mirror capability reads @regression @tier1', function(){
    it('uses the capability snapshot off BTC but not on BTC', function(){
        assert.strictEqual(usesCapabilitySnapshot({ COIN: 'LTC' }, 'archive_publish'), true);
        assert.strictEqual(usesCapabilitySnapshot({ COIN: 'DOGE' }, 'archive_publish'), true);
        assert.strictEqual(usesCapabilitySnapshot({ COIN: 'BTC' }, 'archive_publish'), false);
    });

    it('proves an archive row under oracle_publish without mutating or holding it', async function(){
        sinon.stub(gates, 'activeAt').returns(true);
        const verifier = sinon.spy(capabilityProof, 'verifyCapabilitySnapshotProof');
        const f = fixture();
        const fetchProof = sinon.stub().resolves(f.response);

        const actual = await verifyCapabilitySnapshotRow.call(
            { config: { COIN: 'LTC', NETWORK: 'regtest' } }, f.row, {
                fetchProof,
                readEnv: () => undefined,
            });

        assert.strictEqual(actual.verdict, 'verified');
        assert.notStrictEqual(actual.verdict, 'held');
        assert.deepStrictEqual(fetchProof.firstCall.args,
            [SNAPSHOT_BLOCK, 'oracle_publish', [f.row.signing_pubkey]]);
        assert.notStrictEqual(verifier.firstCall.args[0], f.row);
        assert.strictEqual(verifier.firstCall.args[0].capability, 'oracle_publish');
        assert.strictEqual(f.response.capability, 'oracle_publish');
        assert.strictEqual(f.row.capability, 'archive_publish');
    });
});
