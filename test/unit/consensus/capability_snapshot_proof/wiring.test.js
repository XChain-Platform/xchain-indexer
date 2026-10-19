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
const sinon = require('sinon');
const gates = require('../../../../src/consensus/gate_registry.js');
const proofVerifier = require('../../../../src/consensus/capability_snapshot_proof/verify.js');
const { getLogger } = require('../../../../src/observability/index.js');
const { verifyCapabilitySnapshotRow } = require('../../../../src/db/database/stake_weights.js');

const KEY = 'capability_snapshot_proof_activation.CAPABILITY_SNAPSHOT_PROOF_ACTIVATION';
const PIN = 'CHECKPOINT_VALIDATORS_BTC_TESTNET';
const STATIC_KEY = 'a'.repeat(64);
const NEXT_KEY = 'b'.repeat(64);

function row(overrides = {}){
    return Object.assign({
        snapshot_block: 100,
        capability: 'oracle_publish',
        signing_pubkey: 'c'.repeat(64),
        source: 'source-1',
        amount: '10',
    }, overrides);
}

function pin(pubkey){
    return JSON.stringify([{ pubkey, weight: '1', source: 'checkpoint-source' }]);
}

function mirrorSubject(network = 'testnet'){
    return { config: { COIN: 'DOGE', NETWORK: network } };
}

function readValues(values){
    return name => values[name];
}

afterEach(function () { sinon.restore(); });

describe('capability snapshot proof database wiring @regression @tier1', function () {
    it('keeps a mirror-resolved row below the gate on the legacy path', async function () {
        sinon.stub(gates, 'activeAt').withArgs(KEY).returns(false);
        const fetchProof = sinon.stub().rejects(new Error('must not fetch'));

        const actual = await verifyCapabilitySnapshotRow.call(
            mirrorSubject(), row(), { fetchProof });

        assert.strictEqual(actual.verdict, 'unknown');
        assert.match(actual.reason, /from the mirror/);
        assert.strictEqual(fetchProof.callCount, 0);
    });

    it('passes verified, refused, and held proof verdicts through at the gate', async function () {
        sinon.stub(gates, 'activeAt').withArgs(KEY).returns(true);
        const outcomes = [
            { verdict: 'verified', reason: null },
            { verdict: 'refused', reason: 'stake mismatch' },
            { verdict: 'held', reason: 'proof mismatch' },
        ];
        sinon.stub(proofVerifier, 'verifyCapabilitySnapshotProof').callsFake(
            () => outcomes.shift());
        const opts = {
            fetchProof: sinon.stub().resolves({ proof: true }),
            readEnv: readValues({ [PIN]: pin(STATIC_KEY) }),
        };

        assert.strictEqual((await verifyCapabilitySnapshotRow.call(
            mirrorSubject(), row(), opts)).verdict, 'verified');
        assert.strictEqual((await verifyCapabilitySnapshotRow.call(
            mirrorSubject(), row(), opts)).verdict, 'refused');
        assert.strictEqual((await verifyCapabilitySnapshotRow.call(
            mirrorSubject(), row(), opts)).verdict, 'held');
        assert.deepStrictEqual(opts.fetchProof.firstCall.args,
            [100, 'oracle_publish', ['c'.repeat(64)]]);
    });

    it('holds at the gate when no proof fetcher is available', async function () {
        sinon.stub(gates, 'activeAt').withArgs(KEY).returns(true);

        const actual = await verifyCapabilitySnapshotRow.call(mirrorSubject(), row(), {});

        assert.strictEqual(actual.verdict, 'held');
        assert.match(actual.reason, /fetchProof/);
    });
});

describe('capability snapshot proof database wiring @regression @tier1', function () {
    it('uses the static pin below rotation and the next pin from its block onward', async function () {
        sinon.stub(gates, 'activeAt').withArgs(KEY).returns(true);
        const seen = [];
        sinon.stub(proofVerifier, 'verifyCapabilitySnapshotProof').callsFake(
            (_row, _response, trustSet) => {
                seen.push(trustSet);
                return { verdict: 'verified', reason: null };
            });
        const opts = {
            fetchProof: sinon.stub().resolves({ proof: true }),
            readEnv: readValues({
                [PIN]: pin(STATIC_KEY),
                [PIN + '_NEXT']: pin(NEXT_KEY),
                [PIN + '_FROM']: '100',
            }),
        };

        await verifyCapabilitySnapshotRow.call(mirrorSubject(), row({ snapshot_block: 99 }), opts);
        await verifyCapabilitySnapshotRow.call(mirrorSubject(), row({ snapshot_block: 100 }), opts);

        assert.deepStrictEqual(seen.map(set => set[0].pubkey), [STATIC_KEY, NEXT_KEY]);
    });

    it('never derives the checkpoint trust set from mirrored capability rows', async function () {
        sinon.stub(gates, 'activeAt').withArgs(KEY).returns(true);
        const verifier = sinon.stub(proofVerifier, 'verifyCapabilitySnapshotProof').returns(
            { verdict: 'verified', reason: null });
        const subject = mirrorSubject();
        subject.getCapabilitySnapshotWeights = sinon.stub().rejects(new Error('mirror read forbidden'));

        await verifyCapabilitySnapshotRow.call(subject, row(), {
            fetchProof: sinon.stub().resolves({ proof: true }),
            readEnv: readValues({ [PIN]: pin(STATIC_KEY) }),
        });

        assert.strictEqual(subject.getCapabilitySnapshotWeights.callCount, 0);
        assert.deepStrictEqual(verifier.firstCall.args[2], [
            { pubkey: STATIC_KEY, weight: '1', source: 'checkpoint-source' },
        ]);
    });
});

describe('capability snapshot proof database wiring @regression @tier1', function () {
    it('allows regtest first use and emits one warning line', async function () {
        sinon.stub(gates, 'activeAt').withArgs(KEY).returns(true);
        sinon.stub(proofVerifier, 'verifyCapabilitySnapshotProof').returns(
            { verdict: 'verified', reason: null });
        const warning = sinon.stub(getLogger(), 'warn');

        const actual = await verifyCapabilitySnapshotRow.call(mirrorSubject('regtest'), row(), {
            fetchProof: sinon.stub().resolves({ proof: true }),
            readEnv: () => undefined,
        });

        assert.strictEqual(actual.verdict, 'verified');
        assert.strictEqual(actual.firstUse, true);
        assert.strictEqual(warning.callCount, 1);
    });

    it('keeps the BTC re-derivation path unchanged when the proof gate is active', async function () {
        sinon.stub(gates, 'activeAt').withArgs(KEY).returns(true);
        const fetchProof = sinon.stub().rejects(new Error('BTC must not fetch'));
        const local = [{ pubkey: 'cc', source: 'source-1', weight: '10.0' }];
        const subject = {
            config: { COIN: 'BTC', NETWORK: 'regtest' },
            isCapabilityConfigured: () => true,
            getLatestBlockIndex: async () => 1000,
            stakeSetMemo: sinon.stub().resolves(local),
        };

        const actual = await verifyCapabilitySnapshotRow.call(subject,
            row({ signing_pubkey: 'CC' }), { fetchProof });

        assert.deepStrictEqual(actual, { verdict: 'verified' });
        assert.strictEqual(fetchProof.callCount, 0);
    });
});

// The e2e regtest stack (one hub, XDEX_SEED_LOCAL_VALIDATOR=1, no BTC stake) end to end
// through the real verifier: an LTC indexer mirroring the hub's seeded cross_chain row must
// apply it, or no bridged credit ever lands on LTC. The gate is deferred on every network
// for the v0.25.0 train, regtest included, so this suite arms it through the activeAt seam
// and every other gate read still resolves through the real registry.
describe('capability snapshot proof database wiring: regtest seeded hub row @regression @tier1', function () {
    beforeEach(function () {
        sinon.stub(gates, 'activeAt').callThrough().withArgs(KEY).returns(true);
    });

    const crypto = require('crypto');
    const M = require('../../../../src/consensus/merkle.js');
    const stateSubtree = require('../../../../src/consensus/gates/state_subtree_gate.js');
    const checkpointCanonical = require('../../../../src/consensus/snapshot_checkpoint/canonical.js');

    function seededHubResponse(network, signerKey){
        const pair = crypto.generateKeyPairSync('ed25519');
        const pubkey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
        const seedRow = { snapshot_block: 102, capability: 'cross_chain', signing_pubkey: pubkey,
            source: 'seed:' + pubkey, amount: '1' };
        const block = checkpointCanonical.snapshotCheckpointBlock(102, network);
        // A BTC stakes tree holding one real staker and not the hub's key.
        const tree = new M.SparseMerkleTree();
        tree.set(M.stakeKey('d'.repeat(64), 'cross_chain'), M.stakeMemberLeaf('src-real', '5000'));
        const subRoots = { balances_root: 'd'.repeat(64), stakes_root: tree.rootHex() };
        const checkpoint = {
            chain: 'BTC', network, block_index: block, block_hash: 'e'.repeat(64),
            state_root: M.toHex(M.stateRoot(subRoots)),
            state_root_version: stateSubtree.stateRootVersion(block, network, 'BTC'),
        };
        const signer = signerKey || pair;
        const signerPub = signer.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
        const canonical = checkpointCanonical.snapshotCheckpointCanonical(checkpoint);
        checkpoint.validator_signatures = JSON.stringify([{ pubkey: signerPub,
            sig: crypto.sign(null, Buffer.from(canonical, 'utf8'), signer.privateKey).toString('hex') }]);
        const smt = tree.prove(M.stakeKey(pubkey, 'cross_chain'));
        const response = { snapshot_block: 102, capability: 'cross_chain', checkpoint,
            proof: { block_index: block, sub_roots: subRoots,
                members: [{ pubkey, leaf_value: smt.leaf_value, siblings: smt.siblings, committed: null }] } };
        return { seedRow, response };
    }

    it('applies the seeded row on an unpinned LTC regtest indexer', async function () {
        sinon.stub(getLogger(), 'warn');
        const s = seededHubResponse('regtest');
        const actual = await verifyCapabilitySnapshotRow.call(
            { config: { COIN: 'LTC', NETWORK: 'regtest' } }, s.seedRow, {
                fetchProof: sinon.stub().resolves(s.response),
                readEnv: () => undefined,
            });
        assert.strictEqual(actual.verdict, 'verified');
        assert.strictEqual(actual.firstUse, true);
    });

    it('still refuses the seeded row when another key signed the checkpoint', async function () {
        sinon.stub(getLogger(), 'warn');
        const s = seededHubResponse('regtest', crypto.generateKeyPairSync('ed25519'));
        const actual = await verifyCapabilitySnapshotRow.call(
            { config: { COIN: 'LTC', NETWORK: 'regtest' } }, s.seedRow, {
                fetchProof: sinon.stub().resolves(s.response),
                readEnv: () => undefined,
            });
        assert.strictEqual(actual.verdict, 'refused');
        assert.match(actual.reason, /not a capability stake member/);
    });
});
