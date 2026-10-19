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

const assert = require('assert');
const crypto = require('crypto');
const M = require('../../../../src/consensus/merkle.js');
const stateSubtree = require('../../../../src/consensus/gates/state_subtree_gate.js');
const checkpointCanonical = require('../../../../src/consensus/snapshot_checkpoint/canonical.js');
const { parsePinnedSet } = require('../../../../src/consensus/capability_snapshot_proof/pinned.js');
const { verifyCapabilitySnapshotProof } = require(
    '../../../../src/consensus/capability_snapshot_proof/verify.js');

const CAPABILITY = 'oracle_publish';
const SNAPSHOT_BLOCK = 106;
const CHECKPOINT_BLOCK = 100;

function keypair(source, weight = '1'){
    const pair = crypto.generateKeyPairSync('ed25519');
    const pubkey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    return { privateKey: pair.privateKey, pubkey, source, weight };
}

function signature(checkpoint, signer){
    const canonical = checkpointCanonical.snapshotCheckpointCanonical(checkpoint);
    return {
        pubkey: signer.pubkey,
        sig: crypto.sign(null, Buffer.from(canonical, 'utf8'), signer.privateKey).toString('hex'),
    };
}

function fixture(network = 'testnet'){
    const signers = [keypair('source-a'), keypair('source-b'), keypair('source-c')];
    const row = {
        snapshot_block: SNAPSHOT_BLOCK,
        capability: CAPABILITY,
        signing_pubkey: signers[0].pubkey,
        source: signers[0].source,
        amount: signers[0].weight,
    };
    const tree = new M.SparseMerkleTree();
    tree.set(M.stakeKey(row.signing_pubkey, row.capability),
        M.stakeMemberLeaf(row.source, row.amount));
    const subRoots = {
        balances_root: 'd'.repeat(64),
        stakes_root: tree.rootHex(),
    };
    const checkpoint = {
        chain: 'BTC',
        network,
        block_index: CHECKPOINT_BLOCK,
        block_hash: 'e'.repeat(64),
        state_root: M.toHex(M.stateRoot(subRoots)),
        state_root_version: stateSubtree.stateRootVersion(CHECKPOINT_BLOCK, network, 'BTC'),
    };

    function member(pubkey = row.signing_pubkey, committed = { source: row.source, weight: row.amount }){
        const smt = tree.prove(M.stakeKey(pubkey, row.capability));
        return { pubkey, leaf_value: smt.leaf_value, siblings: smt.siblings, committed };
    }

    function response(options = {}){
        const cp = Object.assign({}, checkpoint, options.checkpoint);
        const selected = options.signers === undefined ? signers : options.signers;
        cp.validator_signatures = selected.map(signer => signature(cp, signer));
        if(options.signatures !== undefined) cp.validator_signatures = options.signatures;
        const proof = Object.assign({
            block_index: CHECKPOINT_BLOCK,
            sub_roots: subRoots,
            members: [member()],
        }, options.proof);
        return Object.assign({
            snapshot_block: SNAPSHOT_BLOCK,
            capability: CAPABILITY,
            checkpoint: cp,
            proof,
        }, options.response);
    }

    return { signers, trustSet: signers.map(({ pubkey, source, weight }) =>
        ({ pubkey, source, weight })), row, tree, subRoots, checkpoint, member, response };
}

function expectVerdict(result, verdict, reason){
    assert.deepStrictEqual(Object.keys(result).sort(), ['reason', 'verdict']);
    assert.strictEqual(result.verdict, verdict);
    assert.strictEqual(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
    if(reason) assert.match(result.reason, reason);
}

describe('capability snapshot proof verifier @regression @tier1', function () {
    it('holds absent and mis-addressed responses before examining signatures', function () {
        const f = fixture();
        expectVerdict(verifyCapabilitySnapshotProof(f.row, null, f.trustSet,
            { network: 'testnet' }), 'held', /response is missing/);
        expectVerdict(verifyCapabilitySnapshotProof(f.row,
            f.response({ response: { snapshot_block: 107 } }), f.trustSet,
            { network: 'testnet' }), 'held', /another snapshot/);
        expectVerdict(verifyCapabilitySnapshotProof(f.row,
            f.response({ response: { capability: 'block_propose' } }), f.trustSet,
            { network: 'testnet' }), 'held', /another snapshot/);
    });

    it('holds checkpoints for another chain, network, or buried block', function () {
        const f = fixture();
        for(const checkpoint of [
            { chain: 'LTC' },
            { network: 'mainnet' },
            { block_index: CHECKPOINT_BLOCK + 1 },
        ]){
            const response = f.response();
            Object.assign(response.checkpoint, checkpoint);
            expectVerdict(verifyCapabilitySnapshotProof(f.row, response, f.trustSet,
                { network: 'testnet' }), 'held', /another chain, network, or block/);
        }
    });

    it('requires a trusted stake-weighted checkpoint quorum', function () {
        const f = fixture();
        expectVerdict(verifyCapabilitySnapshotProof(f.row, f.response(), f.trustSet,
            { network: 'testnet' }), 'verified');
        expectVerdict(verifyCapabilitySnapshotProof(f.row,
            f.response({ signers: f.signers.slice(0, 2) }), f.trustSet,
            { network: 'testnet' }), 'held', /valid quorum/);
        expectVerdict(verifyCapabilitySnapshotProof(f.row,
            f.response({ signatures: [] }), f.trustSet,
            { network: 'testnet' }), 'held', /valid quorum/);
    });

    it('requires every listed first-use signature to be valid and at least one', function () {
        const f = fixture();
        expectVerdict(verifyCapabilitySnapshotProof(f.row,
            f.response({ signers: [f.signers[0]] }), null,
            { network: 'testnet', firstUse: true }), 'verified');

        const mixed = f.response({ signers: f.signers.slice(0, 2) });
        mixed.checkpoint.validator_signatures[1].sig = '0'.repeat(128);
        expectVerdict(verifyCapabilitySnapshotProof(f.row, mixed, null,
            { network: 'testnet', firstUse: true }), 'held', /valid quorum/);
        expectVerdict(verifyCapabilitySnapshotProof(f.row,
            f.response({ signatures: [] }), null,
            { network: 'testnet', firstUse: true }), 'held', /valid quorum/);
        expectVerdict(verifyCapabilitySnapshotProof(f.row,
            f.response({ signers: [f.signers[0]] }), null,
            { network: 'testnet' }), 'held', /valid quorum/);
    });

    it('holds proofs with a wrong block, root, or state-root version', function () {
        const f = fixture();
        expectVerdict(verifyCapabilitySnapshotProof(f.row,
            f.response({ proof: { block_index: CHECKPOINT_BLOCK + 1 } }), f.trustSet,
            { network: 'testnet' }), 'held', /proof block/);
        expectVerdict(verifyCapabilitySnapshotProof(f.row,
            f.response({ checkpoint: { state_root: 'f'.repeat(64) } }), f.trustSet,
            { network: 'testnet' }), 'held', /sub-roots do not match/);
        const wrongVersion = f.checkpoint.state_root_version === 1 ? 2 : 1;
        expectVerdict(verifyCapabilitySnapshotProof(f.row,
            f.response({ checkpoint: { state_root_version: wrongVersion } }), f.trustSet,
            { network: 'testnet' }), 'held', /version/);
    });

    it('holds missing and invalid stake member proofs', function () {
        const f = fixture();
        expectVerdict(verifyCapabilitySnapshotProof(f.row,
            f.response({ proof: { members: [] } }), f.trustSet,
            { network: 'testnet' }), 'held', /no matching member/);
        const invalid = f.member();
        invalid.siblings = invalid.siblings.slice(1);
        expectVerdict(verifyCapabilitySnapshotProof(f.row,
            f.response({ proof: { members: [invalid] } }), f.trustSet,
            { network: 'testnet' }), 'held', /member proof/);
    });

    it('refuses verified non-membership', function () {
        const f = fixture();
        const absent = keypair('source-z');
        const row = Object.assign({}, f.row, {
            signing_pubkey: absent.pubkey,
            source: absent.source,
            amount: absent.weight,
        });
        expectVerdict(verifyCapabilitySnapshotProof(row,
            f.response({ proof: { members: [f.member(absent.pubkey, null)] } }), f.trustSet,
            { network: 'testnet' }), 'refused', /not a capability stake member/);
    });

    it('holds commitments that do not hash to their member leaf', function () {
        const f = fixture();
        expectVerdict(verifyCapabilitySnapshotProof(f.row,
            f.response({ proof: { members: [f.member(undefined,
                { source: f.row.source, weight: '2' })] } }), f.trustSet,
            { network: 'testnet' }), 'held', /does not match leaf/);
    });

    it('judges matching, changed, and multi-source snapshot rows', function () {
        const f = fixture();
        expectVerdict(verifyCapabilitySnapshotProof(
            Object.assign({}, f.row, { amount: '1.000' }), f.response(), f.trustSet,
            { network: 'testnet' }), 'verified');
        expectVerdict(verifyCapabilitySnapshotProof(
            Object.assign({}, f.row, { amount: '2' }), f.response(), f.trustSet,
            { network: 'testnet' }), 'refused', /amount does not match/);
        expectVerdict(verifyCapabilitySnapshotProof(
            Object.assign({}, f.row, { source: 'source-z' }), f.response(), f.trustSet,
            { network: 'testnet' }), 'held', /multi-source key/);
    });

    it('accepts and rejects pinned sets with the sync parser rules', function () {
        const f = fixture();
        assert.deepStrictEqual(parsePinnedSet(JSON.stringify(f.trustSet)),
            { set: f.trustSet, error: null });
        const bad = [
            'x',
            '{}',
            '[]',
            JSON.stringify([{ pubkey: 'a'.repeat(63), weight: '1', source: 's' }]),
            JSON.stringify([{ pubkey: 'a'.repeat(64), weight: 1, source: 's' }]),
            JSON.stringify([{ pubkey: 'a'.repeat(64), weight: '1', source: 1 }]),
            JSON.stringify([{ pubkey: 'a'.repeat(64), weight: '0', source: 's' }]),
        ];
        for(const raw of bad){
            const parsed = parsePinnedSet(raw);
            assert.strictEqual(parsed.set, null);
            assert.strictEqual(typeof parsed.error, 'string');
            assert.ok(parsed.error.length > 0);
        }
    });
});

// The e2e regtest stack runs one hub with XDEX_SEED_LOCAL_VALIDATOR=1 and no BTC stake.
// Its capability_snapshots row is { signing_pubkey: <hub key>, source: 'seed:<hub key>',
// amount: '1' }, the BTC stake proof for that key is a valid non-membership proof, and
// before the regtest concession every LTC and DOGE indexer refused the row, so the
// bridged XCHAIN credit never landed (release matrix run 39171449867).
describe('capability snapshot proof verifier: regtest seeded validator @regression @tier1', function () {
    function seeded(network, options = {}){
        const f = fixture(network);
        const hub = options.hub || keypair('unused');
        const row = Object.assign({
            snapshot_block: SNAPSHOT_BLOCK,
            capability: CAPABILITY,
            signing_pubkey: hub.pubkey,
            source: 'seed:' + hub.pubkey,
            amount: '1',
        }, options.row);
        const signers = options.signers || [hub];
        const response = f.response({
            signers,
            proof: { members: [f.member(row.signing_pubkey, null)] },
        });
        return { f, hub, row, response };
    }

    it('accepts the seeded row on an unpinned regtest venue when the seeded key signed the checkpoint', function () {
        const s = seeded('regtest');
        expectVerdict(verifyCapabilitySnapshotProof(s.row, s.response, null,
            { network: 'regtest', firstUse: true }), 'verified', /regtest seeded validator/);
        const upper = Object.assign({}, s.row, { source: 'seed:' + s.hub.pubkey.toUpperCase(), amount: '1.00000000' });
        expectVerdict(verifyCapabilitySnapshotProof(upper, s.response, null,
            { network: 'regtest', firstUse: true }), 'verified', /regtest seeded validator/);
    });

    it('still refuses the same seeded shape on testnet and mainnet', function () {
        for(const network of ['testnet', 'mainnet']){
            const s = seeded(network);
            expectVerdict(verifyCapabilitySnapshotProof(s.row, s.response, null,
                { network, firstUse: true }), 'refused', /not a capability stake member/);
            const trustSet = [{ pubkey: s.hub.pubkey, source: 'seed:' + s.hub.pubkey, weight: '1' }];
            expectVerdict(verifyCapabilitySnapshotProof(s.row, s.response, trustSet,
                { network }), 'refused', /not a capability stake member/);
        }
    });

    it('still refuses on a pinned regtest venue', function () {
        const s = seeded('regtest');
        const trustSet = [{ pubkey: s.hub.pubkey, source: 'seed:' + s.hub.pubkey, weight: '1' }];
        expectVerdict(verifyCapabilitySnapshotProof(s.row, s.response, trustSet,
            { network: 'regtest' }), 'refused', /not a capability stake member/);
    });

    it('still refuses a seeded row whose key did not sign the checkpoint', function () {
        const other = keypair('other');
        const s = seeded('regtest', { signers: [other] });
        expectVerdict(verifyCapabilitySnapshotProof(s.row, s.response, null,
            { network: 'regtest', firstUse: true }), 'refused', /not a capability stake member/);
    });

    it('still refuses a non-member whose source or amount is not the seed shape', function () {
        const hub = keypair('unused');
        for(const row of [
            { source: 'src-real' },
            { source: 'seed:' + 'a'.repeat(64) },
            { source: 'seed:' },
            { amount: '2' },
            { amount: '5000' },
        ]){
            const s = seeded('regtest', { hub, row });
            expectVerdict(verifyCapabilitySnapshotProof(s.row, s.response, null,
                { network: 'regtest', firstUse: true }), 'refused', /not a capability stake member/);
        }
    });

    it('leaves real stake members on regtest judged by the binding as before', function () {
        const f = fixture('regtest');
        expectVerdict(verifyCapabilitySnapshotProof(f.row, f.response({ signers: [f.signers[0]] }), null,
            { network: 'regtest', firstUse: true }), 'verified', /matches snapshot row/);
        expectVerdict(verifyCapabilitySnapshotProof(
            Object.assign({}, f.row, { amount: '2' }), f.response({ signers: [f.signers[0]] }), null,
            { network: 'regtest', firstUse: true }), 'refused', /amount does not match/);
    });
});
