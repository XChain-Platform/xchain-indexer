/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * getbridgeescrowproof on an origin node whose own state at the checkpoint height is not the
 * signed state (a reorg below a signed checkpoint, or a minority fork).
 *
 * The producer reassembles its own committed sub_roots at the asked height and compares them
 * with the state_root of the signed checkpoint row it holds there. On a mismatch it answers
 * { error: ESCROW_STATE_DIVERGED } instead of an envelope, and the consumer reads that answer
 * as an unavailable proof: fetchEscrowProof returns null and buildEscrowProof raises
 * BridgeProofUnavailableError, which the block loop turns into a deferred block.
 *
 * The answer is bounded: once the node holds a quorum-verified checkpoint at least 12 BTC blocks
 * past the asked height whose signed root its own state reproduces, the federation has followed
 * this node's chain past the reorg, and the node serves its envelope for the old height again
 * (the consumer then refuses it, as it always has). A node on a minority fork never reproduces
 * a later signed root and keeps answering the error. The fixture uses a real persistent SMT, the
 * real merkle assembly and real ed25519 checkpoint signatures; only the SQL answers are stubbed.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';
const assert = require('assert');
const sinon  = require('sinon');

const M   = require('../../../../src/consensus/merkle.js');
const CHK = require('../../../../src/consensus/bridge_checkpoint_check.js');
const proofClient = require('../../../../src/consensus/bridge_proof_client.js');
const stall = require('../../../../src/consensus/bridge_proof_client/stall.js');
const transport = require('../../../../src/consensus/bridge_proof_client/transport.js');
const checkpointSource = require('../../../../src/consensus/bridge_proof_client/checkpoint_source.js');
const { buildBridgeRpc } = require('../../../../src/api/rpc/bridge.js');
const { makeKey, snapshotSet } = require('../../bridge/bridge_settle.test/helpers/settle_fixtures.js');
const { NETWORK, CHAIN, TICK, HEIGHT, ESCROW_ADDR, BALANCE, DIVERGED_TEXT,
        originNode, laterCheckpoint, freshProofClient } = require('./helpers/escrow_proof_origin.js');

afterEach(function(){ sinon.restore(); });

describe('getbridgeescrowproof refuses to serve state that diverges from the signed checkpoint @regression @tier1', function(){
    it('an honest origin node (own roots reassemble to the signed state_root) still serves a verifying envelope', async function(){
        const { db } = await originNode({ signedBalance: BALANCE });
        const envelope = await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        assert.ok(envelope && !envelope.error, 'expected an envelope');
        const verdict = CHK.verifyEscrowAgainstCheckpoint(
            { src_chain: CHAIN, dest_chain: 'DOGE', network: NETWORK, tick: TICK, snapshot_block: HEIGHT, amount: '5' },
            { coin: 'DOGE', network: NETWORK, proof: envelope });
        assert.strictEqual(verdict.ok, true, verdict.reason);
    });

    it('a node whose own roots at the height differ from the signed state_root answers { error } and no envelope', async function(){
        const { db } = await originNode({ signedBalance: '13' });
        const answer = await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        assert.deepStrictEqual(answer, { error: DIVERGED_TEXT });
        assert.strictEqual(stall.ESCROW_STATE_DIVERGED, DIVERGED_TEXT);
    });

    it('compares case-insensitively, so an upper-case signed root that matches is still served', async function(){
        const honest = await originNode({ signedBalance: BALANCE });
        sinon.restore();
        const { db } = await originNode({ signedBalance: BALANCE, stateRoot: honest.checkpointRow.state_root.toUpperCase() });
        const envelope = await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        assert.ok(envelope && !envelope.error && envelope.sub_roots, 'expected an envelope');
    });

    it('a checkpoint row with no signed root is left to the consumer, which binds its own selected checkpoint', async function(){
        const { db } = await originNode({ signedBalance: BALANCE, stateRoot: null });
        const envelope = await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        assert.ok(envelope && !envelope.error && envelope.sub_roots, 'expected an envelope');
    });

    it('the RPC relays the { error } answer unchanged', async function(){
        const { db } = await originNode({ signedBalance: '13' });
        const rpc = buildBridgeRpc({ indexer: { indexerDb: { apiView: () => db } } });
        const res = await rpc.getbridgeescrowproof({ address: ESCROW_ADDR, tick: TICK, block_index: HEIGHT });
        assert.deepStrictEqual(res, { error: DIVERGED_TEXT });
    });
});

describe('the consumer reads the divergence answer as an unavailable proof and defers the block @regression @tier1', function(){
    const ROW = { transfer_id: 'ab'.repeat(32), src_chain: CHAIN, dest_chain: 'DOGE', network: NETWORK,
                  tick: TICK, snapshot_block: HEIGHT, amount: '5' };
    const CP  = { chain: CHAIN, network: NETWORK, block_index: HEIGHT, checkpoint_seq: 3, snapshot_block: HEIGHT,
                  state_root: 'cd'.repeat(32), state_root_version: 1 };

    it('fetchEscrowProof returns null for the { error } answer, never an envelope', async function(){
        sinon.stub(transport, 'resolveOriginEndpoint').returns({ url: 'http://origin.invalid/', apiKey: '' });
        const rpc = sinon.stub(transport, 'rpc').resolves({ error: DIVERGED_TEXT });
        const ctx = { config: {}, coin: 'DOGE', network: NETWORK };
        const fresh = freshProofClient();
        const out = await fresh.fetchEscrowProof(ROW, ctx, CP, ESCROW_ADDR);
        assert.strictEqual(out, null);
        assert.strictEqual(rpc.callCount, 1);
    });

    it('buildEscrowProof raises BridgeProofUnavailableError (the block loop defers), never a refusal', async function(){
        sinon.stub(transport, 'resolveOriginEndpoint').returns({ url: 'http://origin.invalid/', apiKey: '' });
        sinon.stub(transport, 'rpc').resolves({ error: DIVERGED_TEXT });
        sinon.stub(checkpointSource, 'selectCheckpoint').resolves(CP);
        const fresh = freshProofClient();
        let err = null;
        try { await fresh.buildEscrowProof(ROW, { config: {}, coin: 'DOGE', network: NETWORK, indexerDb: {} }, ESCROW_ADDR); }
        catch(e){ err = e; }
        assert.ok(err, 'expected a stall');
        assert.strictEqual(err.name, 'BridgeProofUnavailableError');
        assert.strictEqual(err.stallReason, proofClient.BRIDGE_PROOF_BARRIER);
    });
});

describe('getbridgeescrowproof: the divergence answer is bounded by a later checkpoint this node reproduces @regression @tier1', function(){
    const SETTLE = 12;   // BTC
    const keys = [makeKey(), makeKey(), makeKey()];
    const validators = snapshotSet(keys);

    async function diverged(laterFn, extra){
        const probe = await originNode({ signedBalance: '13' });
        sinon.restore();
        const later = laterFn(probe.ownRoot);
        return originNode(Object.assign({ signedBalance: '13', later, validators }, extra || {}));
    }

    // A deep reorg: the federation signed many checkpoints over the OLD chain inside the window
    // before it followed the reorg, so the first rows past the settle height never reproduce.
    function deepWindow(own, oldCount){
        const rows = [];
        for(let i = 0; i < oldCount; i++) rows.push(laterCheckpoint(HEIGHT + SETTLE + i, 'ef'.repeat(32), keys, 10 + i));
        rows.push(laterCheckpoint(HEIGHT + SETTLE + oldCount, own, keys, 10 + oldCount));
        return rows;
    }

    it('settles past 8 pre-reorg checkpoints in the window (the first reproducing row is the 9th)', async function(){
        const { db } = await diverged((own) => deepWindow(own, 8));
        const envelope = await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        assert.ok(envelope && !envelope.error && envelope.sub_roots, 'expected the envelope');
    });

    it('settles across scan pages (70 pre-reorg rows before the reproducing one)', async function(){
        const { db } = await diverged((own) => deepWindow(own, 70));
        const envelope = await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        assert.ok(envelope && !envelope.error, 'expected the envelope');
    });

    it('reads no row above this node own tip', async function(){
        const { db } = await diverged((own) => deepWindow(own, 8), { tip: HEIGHT + SETTLE + 7 });
        assert.deepStrictEqual(await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT), { error: DIVERGED_TEXT });
    });

    it('drops the remembered row after a local reorg below it and answers the error again', async function(){
        const rootsAt = {};
        const { db } = await diverged((own) => deepWindow(own, 0), { rootsAt });
        const first = await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        assert.ok(first && !first.error, 'settles and serves before the reorg');
        assert.strictEqual(db._bridgeDivergenceWitness.size, 1, 'the settling row is remembered');
        // This node reorgs below the settling row: its roots there no longer reproduce it.
        rootsAt[HEIGHT + SETTLE] = { balances_root: '12'.repeat(32), stakes_root: M.toHex(M.EMPTY_SMT_ROOT), contract_state_root: null };
        assert.deepStrictEqual(await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT), { error: DIVERGED_TEXT });
        assert.strictEqual(db._bridgeDivergenceWitness.size, 0, 'the memo is dropped');
    });

    it('remembers the settling row: a second call reads no checkpoint page', async function(){
        const { db } = await diverged((own) => deepWindow(own, 8));
        await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        const pages = () => db.doQueryStrict.getCalls().filter(c => /checkpoint_seq < \?/.test(c.args[0])).length;
        const before = pages();
        const envelope = await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        assert.ok(envelope && !envelope.error);
        assert.strictEqual(pages(), before);
    });

    it('serves the envelope again once a quorum-signed checkpoint 12 blocks past reproduces this node state', async function(){
        const { db } = await diverged((own) => [laterCheckpoint(HEIGHT + SETTLE, own, keys)]);
        const envelope = await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        assert.ok(envelope && !envelope.error && envelope.sub_roots, 'expected the envelope');
        // The consumer refuses it exactly as it refuses any envelope that misses the signed
        // root, which is the verdict every node reaches.
        const signed = await originNode({ signedBalance: '13' });
        const verdict = CHK.verifyEscrowAgainstCheckpoint(
            { src_chain: CHAIN, dest_chain: 'DOGE', network: NETWORK, tick: TICK, snapshot_block: HEIGHT, amount: '5' },
            { coin: 'DOGE', network: NETWORK, proof: Object.assign({}, envelope, { checkpoint: Object.assign({}, envelope.checkpoint, { state_root: signed.checkpointRow.state_root }) }) });
        assert.strictEqual(verdict.ok, false);
        assert.strictEqual(verdict.reason, CHK.ESCROW_PROOF_REASON.ROOT_MISMATCH);
    });

    it('keeps answering the error for a later checkpoint only 11 blocks past', async function(){
        const { db } = await diverged((own) => [laterCheckpoint(HEIGHT + SETTLE - 1, own, keys)]);
        assert.deepStrictEqual(await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT), { error: DIVERGED_TEXT });
    });

    it('keeps answering the error on a minority fork: the later signed root is not this node state', async function(){
        const { db } = await diverged(() => [laterCheckpoint(HEIGHT + SETTLE, 'ef'.repeat(32), keys)]);
        assert.deepStrictEqual(await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT), { error: DIVERGED_TEXT });
    });

    it('keeps answering the error when the later checkpoint lacks a quorum', async function(){
        const { db } = await diverged((own) => [laterCheckpoint(HEIGHT + SETTLE, own, keys.slice(0, 1))]);
        assert.deepStrictEqual(await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT), { error: DIVERGED_TEXT });
    });

    it('skips an unverifiable lower candidate and settles on the next one up', async function(){
        const { db } = await diverged((own) => [laterCheckpoint(HEIGHT + SETTLE, own, []), laterCheckpoint(HEIGHT + SETTLE + 6, own, keys)]);
        const envelope = await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        assert.ok(envelope && !envelope.error, 'expected the envelope');
    });
});
