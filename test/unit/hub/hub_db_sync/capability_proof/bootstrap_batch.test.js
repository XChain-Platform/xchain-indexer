/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const sinon = require('sinon');
const M = require('../../../../../src/consensus/merkle.js');
const stateSubtree = require(
    '../../../../../src/consensus/gates/state_subtree_gate.js');
const checkpointCanonical = require(
    '../../../../../src/consensus/snapshot_checkpoint/canonical.js');
const capabilityProof = require(
    '../../../../../src/consensus/capability_snapshot_proof/verify.js');
const capabilityBarrier = require(
    '../../../../../src/hub/hub_db_sync/barriers/capability_proof.js');
const bootstrapFlush = require('../../../../../src/hub/hub_db_sync/bootstrap/flush.js');
const chainIdentity = require('../../../../../src/hub/hub_db_sync/chain_identity.js');
const { judgeMirroredCapabilityRow } = require(
    '../../../../../src/consensus/capability_snapshot_proof/mirror_judgement.js');

const BLOCK = 106;
const CAPABILITY = 'oracle_publish';

function pubkey(index){
    return index.toString(16).padStart(64, '0');
}

function row(index, overrides = {}){
    return Object.assign({
        snapshot_block: BLOCK,
        capability: CAPABILITY,
        signing_pubkey: pubkey(index),
        source: 'source-' + index,
        amount: '1',
    }, overrides);
}

function responseFor(pubkeys){
    return {
        snapshot_block: BLOCK,
        capability: CAPABILITY,
        checkpoint: {},
        proof: { members: pubkeys.map(key => ({ pubkey: key })) },
    };
}

function subject(){
    const target = {
        paceCapabilityProofRequest: sinon.stub().resolves(),
        deferCapabilityProofRequests: sinon.stub(),
    };
    for(const name of [
        'beginCapabilityProofBatch',
        'restoreCapabilityProofBatch',
        'sharedCapabilityProof',
    ]) target[name] = capabilityBarrier[name];
    target.fetchCapabilitySnapshotProof = chainIdentity.fetchCapabilitySnapshotProof;
    target.fetchCapabilitySnapshotProofDirect = chainIdentity.fetchCapabilitySnapshotProofDirect;
    target.httpGet = sinon.stub().callsFake(async path => {
        const params = new URL(path, 'http://example.invalid').searchParams;
        return responseFor(String(params.get('pubkeys')).split(','));
    });
    return target;
}

function signer(source, weight = '1'){
    const pair = crypto.generateKeyPairSync('ed25519');
    return {
        privateKey: pair.privateKey,
        pubkey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
        source,
        weight,
    };
}

function parityWorld(network){
    const signers = [signer('checkpoint-a'), signer('checkpoint-b'), signer('checkpoint-c')];
    const members = [signer('member-a', '2'), signer('member-b', '3'), signer('member-c', '4')];
    const stakes = new Map();
    const tree = new M.SparseMerkleTree();
    for(const member of members){
        stakes.set(member.pubkey, member);
        tree.set(M.stakeKey(member.pubkey, CAPABILITY),
            M.stakeMemberLeaf(member.source, member.weight));
    }
    const rows = [
        row(1, { signing_pubkey: members[0].pubkey, source: members[0].source, amount: members[0].weight }),
        row(2, { signing_pubkey: members[1].pubkey, source: members[1].source, amount: '30' }),
        row(3, { signing_pubkey: members[2].pubkey, source: 'other-source', amount: members[2].weight }),
        row(4, { signing_pubkey: signer('absent').pubkey, source: 'absent', amount: '1' }),
        row(5, { signing_pubkey: members[0].pubkey.toUpperCase(), source: members[0].source,
            amount: members[0].weight }),
        ...signers.map((item, index) => row(index + 6, {
            signing_pubkey: item.pubkey,
            source: 'seed:' + item.pubkey,
            amount: '1',
        })),
    ];
    const subRoots = { balances_root: 'd'.repeat(64), stakes_root: tree.rootHex() };
    const checkpoint = {
        chain: 'BTC',
        network,
        block_index: 100,
        block_hash: 'e'.repeat(64),
        state_root: M.toHex(M.stateRoot(subRoots)),
        state_root_version: stateSubtree.stateRootVersion(100, network, 'BTC'),
    };
    const canonical = checkpointCanonical.snapshotCheckpointCanonical(checkpoint);
    checkpoint.validator_signatures = signers.map(item => ({
        pubkey: item.pubkey,
        sig: crypto.sign(null, Buffer.from(canonical, 'utf8'), item.privateKey).toString('hex'),
    }));
    const proofFor = pubkeys => ({
        snapshot_block: BLOCK,
        capability: CAPABILITY,
        checkpoint: JSON.parse(JSON.stringify(checkpoint)),
        proof: {
            chain: 'BTC',
            network,
            block_index: 100,
            sub_roots: subRoots,
            members: pubkeys.map(requested => {
                const key = requested.toLowerCase();
                const proof = tree.prove(M.stakeKey(key, CAPABILITY));
                const member = stakes.get(key);
                return {
                    pubkey: key,
                    leaf_value: proof.leaf_value,
                    siblings: proof.siblings,
                    committed: member ? { source: member.source, weight: member.weight } : null,
                };
            }),
            total: null,
            total_proof: null,
        },
    });
    return {
        rows,
        proofFor,
        trustSet: signers.map(({ pubkey: key, source, weight }) => ({ pubkey: key, source, weight })),
    };
}

function paritySubject(proofFor){
    const target = subject();
    target.httpGet.callsFake(async path => {
        const keys = String(new URL(path, 'http://example.invalid').searchParams.get('pubkeys')).split(',');
        return proofFor(keys);
    });
    return target;
}

afterEach(function () {
    sinon.restore();
    capabilityProof._resetCheckpointValidationMemoForTest();
});

describe('capability proof bootstrap batch @regression @tier1', function () {
    it('shares proof requests across small and large row counts for one group', async function () {
        const directCounts = [];
        const sharedCounts = [];
        for(const rowCount of [2, 200]){
            const rows = Array.from({ length: rowCount }, (_, index) => row(index + 1));

            const direct = subject();
            for(const item of rows)
                await direct.fetchCapabilitySnapshotProofDirect(
                    item.snapshot_block, item.capability, [item.signing_pubkey]);
            directCounts.push(direct.httpGet.callCount);

            const shared = subject();
            const previous = shared.beginCapabilityProofBatch('capability_snapshots', rows);
            for(const item of rows)
                await shared.fetchCapabilitySnapshotProof(
                    item.snapshot_block, item.capability, [item.signing_pubkey]);
            shared.restoreCapabilityProofBatch(previous);
            sharedCounts.push(shared.httpGet.callCount);
        }

        assert.deepStrictEqual(directCounts, [2, 200]);
        assert.deepStrictEqual(sharedCounts, [1, 2]);
    });

    it('keeps distinct checkpoint keys separate', async function () {
        const shared = subject();
        const rows = [row(1), row(2, { snapshot_block: BLOCK + 1 }),
            row(3, { capability: 'cross_chain' })];
        shared.beginCapabilityProofBatch('capability_snapshots', rows);
        for(const item of rows)
            await shared.fetchCapabilitySnapshotProof(
                item.snapshot_block, item.capability, [item.signing_pubkey]);
        assert.strictEqual(shared.httpGet.callCount, 3);
    });

    it('keeps every shared proof request path within the 8 KB budget', async function () {
        const shared = subject();
        const rows = Array.from({ length: 256 }, (_, index) => row(index + 1));
        const token = shared.beginCapabilityProofBatch('capability_snapshots', rows);
        for(const item of rows)
            await shared.fetchCapabilitySnapshotProof(
                item.snapshot_block, item.capability, [item.signing_pubkey]);
        shared.restoreCapabilityProofBatch(token);

        const paths = shared.httpGet.getCalls().map(call => call.args[0]);
        assert.ok(paths.length > 1, 'a full 256-key group must be split by encoded path size');
        for(const path of paths){
            assert.ok(Buffer.byteLength(path) <= 8000, 'request path exceeds 8 KB budget');
            const keys = String(new URL(path, 'http://example.invalid').searchParams.get('pubkeys')).split(',');
            assert.ok(keys.length <= 256, 'request exceeds the endpoint key cap');
        }
    });

    it('does not let an overlapping price flush clear or restore a capability batch', async function () {
        const target = subject();
        target.flushPendingRows = bootstrapFlush.flushPendingRows;
        target.priceRowBoundOut = () => false;
        target.applyRowsBatched = sinon.stub().resolves(false);
        target.reportDrainProgress = sinon.stub();
        let releaseCapability;
        let releasePrice;
        target.applyPendingRow = sinon.stub().callsFake(drain => new Promise(resolve => {
            if(drain.table === 'capability_snapshots') releaseCapability = () => resolve(true);
            else releasePrice = () => resolve(true);
        }));
        const capabilityDrain = { table: 'capability_snapshots', pending: [{ row: row(1) }] };
        const priceDrain = { table: 'price_snapshots', pending: [{ row: {} }] };

        const capabilityFlush = target.flushPendingRows(capabilityDrain);
        await Promise.resolve();
        const activeBatch = target._capabilityProofBatch;
        const priceFlush = target.flushPendingRows(priceDrain);
        await Promise.resolve();
        assert.strictEqual(target._capabilityProofBatch, activeBatch,
            'the unrelated flush must leave the active capability batch installed');

        releaseCapability();
        await capabilityFlush;
        releasePrice();
        await priceFlush;
        assert.strictEqual(target._capabilityProofBatch, null,
            'the unrelated flush must not restore a capability batch that already ended');
    });

    it('falls back to the row request when a shared response omits its member', async function () {
        const shared = subject();
        const rows = [row(1), row(2)];
        shared.httpGet.onFirstCall().resolves(responseFor([rows[0].signing_pubkey]));
        shared.beginCapabilityProofBatch('capability_snapshots', rows);

        await shared.fetchCapabilitySnapshotProof(
            rows[0].snapshot_block, rows[0].capability, [rows[0].signing_pubkey]);
        const second = await shared.fetchCapabilitySnapshotProof(
            rows[1].snapshot_block, rows[1].capability, [rows[1].signing_pubkey]);

        assert.strictEqual(shared.httpGet.callCount, 2);
        assert.strictEqual(second.proof.members[0].pubkey, rows[1].signing_pubkey);
    });

    it('matches real-verifier verdict, reason, and firstUse for pinned and regtest first-use batches',
        async function () {
            for(const [network, mode] of [['testnet', 'pinned'], ['regtest', 'first-use']]){
                const world = parityWorld(network);
                const pin = JSON.stringify(world.trustSet);
                const readEnv = name => mode === 'pinned' &&
                    name === 'CHECKPOINT_VALIDATORS_BTC_' + network.toUpperCase() ? pin : undefined;
                const direct = paritySubject(world.proofFor);
                const expected = [];
                for(const item of world.rows){
                    capabilityProof._resetCheckpointValidationMemoForTest();
                    expected.push(await judgeMirroredCapabilityRow(item, {
                        network,
                        readEnv,
                        fetchProof: direct.fetchCapabilitySnapshotProofDirect.bind(direct),
                    }, capabilityProof.verifyCapabilitySnapshotProof));
                }

                capabilityProof._resetCheckpointValidationMemoForTest();
                const shared = paritySubject(world.proofFor);
                const token = shared.beginCapabilityProofBatch('capability_snapshots', world.rows);
                const actual = [];
                for(const item of world.rows){
                    actual.push(await judgeMirroredCapabilityRow(item, {
                        network,
                        readEnv,
                        fetchProof: shared.fetchCapabilitySnapshotProof.bind(shared),
                    }, capabilityProof.verifyCapabilitySnapshotProof));
                }
                shared.restoreCapabilityProofBatch(token);

                assert.deepStrictEqual(actual, expected, network + '/' + mode);
                assert.deepStrictEqual(new Set(actual.map(result => result.verdict)),
                    new Set(['verified', 'refused', 'held']));
                assert.strictEqual(shared.httpGet.callCount, 1);
            }
    });
});
