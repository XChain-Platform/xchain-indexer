/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The federation-read JSON-RPC families for stake, capability and attestation
 * reads (src/api/rpc/stakes.js, capabilities.js, attestation.js), driven against
 * the indexer double: every read resolves through apiView(), refuses a height
 * past the committed tip, echoes the truncation flag the query layer rides on
 * its array, and answers a throw with its generic error.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const observability = require('../../../../src/observability/index.js');
const srb = require('../../../../src/consensus/snapshot_reorg_buffer.js');
const gatesFilter = require('../../../../src/actions/attest/rollcall_gates_filter.js');
const { buildStakesRpc } = require('../../../../src/api/rpc/stakes.js');
const { buildCapabilitiesRpc } = require('../../../../src/api/rpc/capabilities.js');
const { buildAttestationRpc } = require('../../../../src/api/rpc/attestation.js');
const { recordingView, fakeIndexer } = require('./helpers/fake_indexer.js');

const PK = 'ab'.repeat(32);
const NOT_READY = { error: 'indexer database not ready' };

// A validator list the way the query layer returns it: an array carrying its
// own truncation flag out of band.
function validators(rows, truncated) {
    const list = rows.slice();
    if (truncated) list.truncated = true;
    return list;
}

describe('JSON-RPC stake family @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('getownstake resolves the effective stake at the committed tip, lower-casing the key', async function () {
        const view = recordingView({ getLatestBlockIndex: 300, getEffectiveStakeByPubkey: { amount: '5000' } });
        const rpc = buildStakesRpc({ indexer: fakeIndexer({ view }) });
        assert.deepStrictEqual(await rpc.getownstake({ pubkey: PK.toUpperCase() }),
            { pubkey: PK, block_index: 300, amount: '5000', has_stake: true });
        assert.deepStrictEqual(view.calls[1], ['getEffectiveStakeByPubkey', PK, 300]);
        view.getEffectiveStakeByPubkey = async () => null;
        assert.deepStrictEqual(await rpc.getownstake({ pubkey: PK }), { pubkey: PK, block_index: 300, amount: '0', has_stake: false });
    });

    it('getownstake validates the key, refuses without a database and reports a throw', async function () {
        sinon.stub(observability.getLogger(), 'error');
        const rpc = buildStakesRpc({ indexer: fakeIndexer({ indexerDb: null }) });
        assert.deepStrictEqual(await rpc.getownstake({ pubkey: 'zz' }), { error: 'pubkey must be a 64-char hex string' });
        assert.deepStrictEqual(await rpc.getownstake({ pubkey: PK }), NOT_READY);
        const throwing = buildStakesRpc({ indexer: fakeIndexer({ view: recordingView({ getLatestBlockIndex: () => { throw new Error('x'); } }) }) });
        assert.deepStrictEqual(await throwing.getownstake({ pubkey: PK }), { error: 'failed to look up stake' });
    });

    for (const [name, accessor, extra] of [
        ['getactivevalidators', 'getActiveValidators', {}],
        ['getactivestakeweights', 'getActiveStakeWeights', { source_count: 2 }]
    ]) {
        describe(name, function () {
            const rows = [{ pubkey: 'a', source: 's1' }, { pubkey: 'b', source: 's2' }];

            it('answers the set at the block with the truncation flag echoed', async function () {
                const view = recordingView({ getLatestBlockIndex: 50, [accessor]: validators(rows, true) });
                const rpc = buildStakesRpc({ indexer: fakeIndexer({ view }) });
                const res = await rpc[name]({ block_index: 40 });
                assert.deepStrictEqual(res, Object.assign({ block_index: 40, count: 2, truncated: true, validators: validators(rows, true) }, extra));
                assert.deepStrictEqual(view.calls[1], [accessor, 40]);
                view[accessor] = async () => validators(rows, false);
                assert.strictEqual((await rpc[name]({ block_index: 40 })).truncated, false);
            });

            it('validates block_index, refuses a future block and reports a throw', async function () {
                sinon.stub(observability.getLogger(), 'error');
                const view = recordingView({ getLatestBlockIndex: 50, [accessor]: () => { throw new Error('x'); } });
                const rpc = buildStakesRpc({ indexer: fakeIndexer({ view }) });
                assert.deepStrictEqual(await rpc[name]({}), { error: 'block_index is required' });
                assert.deepStrictEqual(await rpc[name]({ block_index: 1.5 }), { error: 'block_index must be a non-negative integer' });
                assert.deepStrictEqual(await rpc[name]({ block_index: 51 }), { error: 'block_index 51 not yet indexed (latest: 50)' });
                assert.ok((await rpc[name]({ block_index: 50 })).error.startsWith('failed to look up'));
                assert.deepStrictEqual(await buildStakesRpc({ indexer: fakeIndexer({ indexerDb: null }) })[name]({ block_index: 1 }), NOT_READY);
            });
        });
    }

    it('getstakesourcebypubkey delegates to stake_source.js against the same indexer', async function () {
        const view = recordingView({ getPubkeyId: null });
        const rpc = buildStakesRpc({ indexer: fakeIndexer({ view }) });
        assert.deepStrictEqual(await rpc.getstakesourcebypubkey({ pubkey: PK, block_index: 5 }), { source: null });
        assert.deepStrictEqual(view.calls, [['getPubkeyId', PK]]);
    });
});

// A capability-family view: the configured-capability probe answers synchronously,
// the way the real isCapabilityConfigured does.
function capView(overrides = {}) {
    return recordingView(Object.assign({
        getLatestBlockIndex: 100,
        isCapabilityConfigured: (cap) => cap !== 'unknown',
        getValidatorsByCapability: validators([{ pubkey: 'a' }, { pubkey: 'b' }], false),
        getStakeWeightsByCapability: validators([{ pubkey: 'a', source: 's', weight: '1' }], false)
    }, overrides), { sync: ['isCapabilityConfigured'] });
}

describe('JSON-RPC capability family: getcapabilityvalidators @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('getcapabilityvalidators answers a non-attestation set untouched by the rules rail', async function () {
        sinon.stub(observability.getLogger(), 'info');
        const filter = sinon.stub(gatesFilter, 'filterByRolledGates');
        const view = capView();
        const rpc = buildCapabilitiesRpc({ indexer: fakeIndexer({ view }) });
        const res = await rpc.getcapabilityvalidators({ capability: 'price', block_index: 90, min_stake: '7' });
        assert.deepStrictEqual(res, { capability: 'price', block_index: 90, count: 2, truncated: false, validators: [{ pubkey: 'a' }, { pubkey: 'b' }] });
        assert.deepStrictEqual(view.calls.map(c => c[0]), ['isCapabilityConfigured', 'getLatestBlockIndex', 'getValidatorsByCapability']);
        assert.deepStrictEqual(view.calls[2], ['getValidatorsByCapability', 'price', 90, '7']);
        assert.ok(filter.notCalled, 'only the attestation capability is filtered');
    });

    it('getcapabilityvalidators filters attestation at the raw request height and keeps the pre-filter truncation flag', async function () {
        sinon.stub(observability.getLogger(), 'info');
        const filter = sinon.stub(gatesFilter, 'filterByRolledGates').resolves([{ pubkey: 'a' }]);
        const view = capView({ getValidatorsByCapability: validators([{ pubkey: 'a' }, { pubkey: 'b' }], true) });
        const rpc = buildCapabilitiesRpc({ indexer: fakeIndexer({ view }) });
        const res = await rpc.getcapabilityvalidators({ capability: 'attestation', block_index: 90 });
        assert.strictEqual(res.count, 1);
        assert.strictEqual(res.truncated, true, 'the flag rides the pre-filter array');
        const args = filter.firstCall.args[0];
        assert.strictEqual(args.requestBlock, 90 + srb.CANONICAL_REORG_BUFFER);
        assert.strictEqual(args.network, 'regtest');
        assert.strictEqual(args.db, view);
    });

    it('getcapabilityvalidators reports config drift, a future block, a missing db and a throw', async function () {
        sinon.stub(observability.getLogger(), 'error');
        const rpc = buildCapabilitiesRpc({ indexer: fakeIndexer({ view: capView({ getValidatorsByCapability: () => { throw new Error('x'); } }) }) });
        assert.deepStrictEqual(await rpc.getcapabilityvalidators({ capability: 'unknown', block_index: 1 }), { error: 'capability not configured: unknown' });
        assert.deepStrictEqual(await rpc.getcapabilityvalidators({ capability: 'price', block_index: 101 }), { error: 'block_index 101 not yet indexed (latest: 100)' });
        assert.deepStrictEqual(await rpc.getcapabilityvalidators({ capability: 'price', block_index: 1 }), { error: 'failed to look up capability validators' });
        assert.deepStrictEqual(await rpc.getcapabilityvalidators({ block_index: 1 }), { error: 'capability is required' });
        assert.deepStrictEqual(await buildCapabilitiesRpc({ indexer: fakeIndexer({ indexerDb: null }) }).getcapabilityvalidators({ capability: 'price', block_index: 1 }), NOT_READY);
    });
});

describe('JSON-RPC capability family: getfullnodeverifiers @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('getfullnodeverifiers intersects the proof-window set with one batched full_node read', async function () {
        const hasCapability = sinon.stub().resolves(true);
        const view = capView({
            getVerifiedFullNodeSet: validators([{ pubkey: 'AA' }, { pubkey: 'bb' }, { pubkey: 'cc' }], false),
            getValidatorsByCapability: validators([{ pubkey: 'aa' }, { pubkey: 'cc' }], false),
            hasCapability
        });
        const rpc = buildCapabilitiesRpc({ indexer: fakeIndexer({ view }) });
        const res = await rpc.getfullnodeverifiers({ block_index: 10 });
        assert.deepStrictEqual(res.validators.map(v => v.pubkey), ['AA', 'cc']);
        assert.strictEqual(res.count, 2);
        assert.strictEqual(res.truncated, false);
        assert.ok(hasCapability.notCalled, 'no per-pubkey probe while the batched read is complete');
        assert.deepStrictEqual(view.calls.map(c => c[0]), ['getVerifiedFullNodeSet', 'getValidatorsByCapability']);
        assert.deepStrictEqual(view.calls[1], ['getValidatorsByCapability', 'full_node', 10]);
    });

    it('getfullnodeverifiers falls back to per-pubkey probes when the capability read truncated', async function () {
        const view = capView({
            getVerifiedFullNodeSet: validators([{ pubkey: 'aa' }, { pubkey: 'bb' }], true),
            getValidatorsByCapability: validators([{ pubkey: 'aa' }], true),
            hasCapability: (pk) => pk === 'bb'
        });
        const rpc = buildCapabilitiesRpc({ indexer: fakeIndexer({ view }) });
        const res = await rpc.getfullnodeverifiers({ block_index: 10 });
        assert.deepStrictEqual(res.validators.map(v => v.pubkey), ['bb']);
        assert.strictEqual(res.truncated, true, 'the proof-window read\'s own flag is echoed');
        assert.deepStrictEqual(view.calls.filter(c => c[0] === 'hasCapability').map(c => c[1]), ['aa', 'bb']);
    });

    it('getfullnodeverifiers validates its block and reports a throw', async function () {
        sinon.stub(observability.getLogger(), 'error');
        const rpc = buildCapabilitiesRpc({ indexer: fakeIndexer({ view: capView({ getVerifiedFullNodeSet: () => { throw new Error('x'); } }) }) });
        assert.deepStrictEqual(await rpc.getfullnodeverifiers({}), { error: 'block_index is required' });
        assert.deepStrictEqual(await rpc.getfullnodeverifiers({ block_index: -2 }), { error: 'block_index must be a non-negative integer' });
        assert.deepStrictEqual(await rpc.getfullnodeverifiers({ block_index: 2 }), { error: 'failed to look up full-node verifiers' });
        assert.deepStrictEqual(await buildCapabilitiesRpc({ indexer: fakeIndexer({ indexerDb: null }) }).getfullnodeverifiers({ block_index: 1 }), NOT_READY);
    });
});

describe('JSON-RPC capability family: getstakeweightsbycapability @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('getstakeweightsbycapability answers keys, sources and the threshold provenance in its log line', async function () {
        const info = sinon.stub(observability.getLogger(), 'info');
        const view = capView({ getStakeWeightsByCapability: validators([{ pubkey: 'a', source: 's1' }, { pubkey: 'b', source: 's1' }], true) });
        const rpc = buildCapabilitiesRpc({ indexer: fakeIndexer({ view }) });
        const res = await rpc.getstakeweightsbycapability({ capability: 'price', block_index: 20, min_stake: 9 });
        assert.deepStrictEqual({ ...res, validators: undefined }, { capability: 'price', block_index: 20, count: 2, source_count: 1, truncated: true, validators: undefined });
        assert.match(info.firstCall.args[0], /min_stake=9 \(caller-supplied\) keys=2 sources=1/);
        await rpc.getstakeweightsbycapability({ capability: 'price', block_index: 20 });
        assert.match(info.secondCall.args[0], /min_stake=local-config/);
    });

    it('getstakeweightsbycapability validates in API order and reports a throw', async function () {
        sinon.stub(observability.getLogger(), 'error');
        const rpc = buildCapabilitiesRpc({ indexer: fakeIndexer({ view: capView({ getStakeWeightsByCapability: () => { throw new Error('x'); } }) }) });
        assert.deepStrictEqual(await rpc.getstakeweightsbycapability({ block_index: 1 }), { error: 'capability is required' });
        assert.deepStrictEqual(await rpc.getstakeweightsbycapability({ capability: 'price' }), { error: 'block_index is required' });
        assert.deepStrictEqual(await rpc.getstakeweightsbycapability({ capability: 'price', block_index: 'x' }), { error: 'block_index must be a non-negative integer' });
        assert.deepStrictEqual(await rpc.getstakeweightsbycapability({ capability: 'unknown', block_index: 1 }), { error: 'capability not configured: unknown' });
        assert.deepStrictEqual(await rpc.getstakeweightsbycapability({ capability: 'price', block_index: 500 }), { error: 'block_index 500 not yet indexed (latest: 100)' });
        assert.deepStrictEqual(await rpc.getstakeweightsbycapability({ capability: 'price', block_index: 1 }), { error: 'failed to look up stake weights' });
        assert.deepStrictEqual(await buildCapabilitiesRpc({ indexer: fakeIndexer({ indexerDb: null }) }).getstakeweightsbycapability({ capability: 'price', block_index: 1 }), NOT_READY);
    });
});

describe('JSON-RPC attestation family @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('getpendingattestation_requests clamps the limit and honours a complete keyset cursor', async function () {
        const view = recordingView({ getLatestBlockIndex: 70, getPendingAttestationRequests: [{ id: 1 }] });
        const rpc = buildAttestationRpc({ indexer: fakeIndexer({ view }) });
        assert.deepStrictEqual(await rpc.getpendingattestation_requests({ provider_id: 'p', limit: 9999, after_block_index: 5, after_action_index: 6 }),
            { latest_block_index: 70, count: 1, requests: [{ id: 1 }] });
        assert.deepStrictEqual(view.calls[1], ['getPendingAttestationRequests', 'p', 500, { after_block_index: 5, after_action_index: 6 }]);
        await rpc.getpendingattestation_requests({ limit: 'x', after_block_index: 5 });
        assert.deepStrictEqual(view.calls[3], ['getPendingAttestationRequests', undefined, 100, null]);
    });

    it('getrelayedattestation_requests scopes to this coin, clamps and pages the same way', async function () {
        const view = recordingView({ getLatestBlockIndex: 70, getRelayedAttestationRequests: [] });
        const rpc = buildAttestationRpc({ indexer: fakeIndexer({ view }) });
        assert.deepStrictEqual(await rpc.getrelayedattestation_requests({ request_id: 'r', limit: 0 }), { latest_block_index: 70, count: 0, requests: [] });
        assert.deepStrictEqual(view.calls[1], ['getRelayedAttestationRequests', 'BTC', 'r', 100, null]);
        await rpc.getrelayedattestation_requests({ limit: 3, after_block_index: '1', after_action_index: '2' });
        assert.deepStrictEqual(view.calls[3], ['getRelayedAttestationRequests', 'BTC', undefined, 3, { after_block_index: '1', after_action_index: '2' }]);
    });

    it('getactionconfirmations reports depth from one tip snapshot, or exists:false', async function () {
        const view = recordingView({ getLatestBlockIndex: 110, getActionInfo: (idx) => (idx === 7 ? { action: 'SEND', block_index: 101 } : null) });
        const rpc = buildAttestationRpc({ indexer: fakeIndexer({ view }) });
        assert.deepStrictEqual(await rpc.getactionconfirmations({ action_index: 7 }),
            { coin: 'BTC', network: 'regtest', action_index: 7, exists: true, action: 'SEND', block_index: 101, latest_block_index: 110, confirmations: 10 });
        assert.deepStrictEqual(await rpc.getactionconfirmations({ action_index: 8 }),
            { coin: 'BTC', network: 'regtest', action_index: 8, exists: false, latest_block_index: 110, confirmations: 0 });
        assert.deepStrictEqual(await rpc.getactionconfirmations({ action_index: 0 }), { error: 'action_index must be a positive integer' });
    });

    it('every attestation read refuses without a database and reports a throw', async function () {
        sinon.stub(observability.getLogger(), 'error');
        const notReady = buildAttestationRpc({ indexer: fakeIndexer({ indexerDb: null }) });
        const throwing = buildAttestationRpc({ indexer: fakeIndexer({ view: recordingView({ getLatestBlockIndex: () => { throw new Error('x'); } }) }) });
        for (const [name, body, message] of [
            ['getpendingattestation_requests', {}, 'failed to look up pending attestation requests'],
            ['getrelayedattestation_requests', {}, 'failed to look up relayed attestation requests'],
            ['getactionconfirmations', { action_index: 1 }, 'failed to look up action confirmations']
        ]) {
            assert.deepStrictEqual(await notReady[name](body), NOT_READY, name);
            assert.deepStrictEqual(await throwing[name](body), { error: message }, name);
        }
    });
});
