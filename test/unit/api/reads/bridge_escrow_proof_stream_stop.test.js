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
 * getbridgeescrowproof on a diverged origin node when the hub has stopped signing checkpoints.
 *
 * A later checkpoint this node reproduces is what normally ends the divergence answer, and it
 * can only arrive while the federation signs. Once the newest signed row the mirror holds is
 * about one day of blocks below this node's tip, the stream reads as stopped and the node
 * serves its envelope again, so the consumer refuses it and skips the leg instead of deferring
 * its block forever. The checkpoint stream is stopped here by holding no row above the
 * diverged one (or above a fixed newest row), and the consumer's path is the real one: its
 * fetchEscrowProof against the origin's real RPC handler, then the real settle step.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const CHK = require('../../../../src/consensus/bridge_checkpoint_check.js');
const transport = require('../../../../src/consensus/bridge_proof_client/transport.js');
const { buildBridgeRpc } = require('../../../../src/api/rpc/bridge.js');
const escrowDivergence = require('../../../../src/db/credits/escrow_divergence.js');
const { BS, makeKey, snapshotSet, makeTransfer, makeCtx } = require('../../bridge/bridge_settle.test/helpers/settle_fixtures.js');
const { NETWORK, CHAIN, TICK, HEIGHT, ESCROW_ADDR, DIVERGED_TEXT,
        originNode, laterCheckpoint, freshProofClient } = require('./helpers/escrow_proof_origin.js');

const STALL = 144;   // BTC: about one day of blocks
const keys = [makeKey(), makeKey(), makeKey()];
const validators = snapshotSet(keys);
const OLD_ROOT = 'ef'.repeat(32);

afterEach(function(){ sinon.restore(); });

// The consumer's whole path for one leg: its own selected checkpoint (the signed row at
// HEIGHT), the real fetchEscrowProof against the origin's real RPC handler, then the real
// settle step. Returns the fetched envelope (null is a stall) and the settle result.
async function consumerLeg(origin){
    sinon.stub(transport, 'resolveOriginEndpoint').returns({ url: 'http://origin.invalid/', apiKey: '' });
    const originRpc = buildBridgeRpc({ indexer: { indexerDb: { apiView: () => origin.db } } });
    sinon.stub(transport, 'rpc').callsFake(async (endpoint, method, params) => originRpc[method](params));
    const row = makeTransfer(keys, { snapshot_block: HEIGHT });
    const { ctx, state } = makeCtx({ coin: 'DOGE', validators,
                                     tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } } });
    const selected = Object.assign({ chain: CHAIN, network: NETWORK, block_index: HEIGHT }, origin.checkpointRow);
    const proof = await freshProofClient().fetchEscrowProof(row, ctx, selected, ESCROW_ADDR);
    if(!proof) return { proof, res: null, state };
    ctx.proof = proof;
    return { proof, res: await BS.applyBridgeTransfer(row, ctx), state };
}

// A diverged origin node (its state at HEIGHT commits 12.5 where the signed root commits 13).
function stoppedOrigin(extra){
    return originNode(Object.assign({ signedBalance: '13', later: [], validators, streamStopped: true }, extra));
}

describe('getbridgeescrowproof: a divergence is released once the checkpoint stream stops @regression @tier1', function(){
    it('names about one day of blocks per chain', function(){
        assert.deepStrictEqual(escrowDivergence.CHECKPOINT_STREAM_STALL_BLOCKS, { BTC: 144, LTC: 576, DOGE: 1440 });
    });

    it('keeps answering the error while the stopped stream is one block short of the bound', async function(){
        const origin = await stoppedOrigin({ tip: HEIGHT + STALL - 1 });
        assert.deepStrictEqual(await origin.db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT), { error: DIVERGED_TEXT });
        const { proof } = await consumerLeg(origin);
        assert.strictEqual(proof, null, 'the consumer still stalls');
    });

    it('with no checkpoint after the diverged one, serves the envelope at the bound and the consumer skips the leg', async function(){
        const origin = await stoppedOrigin({ tip: HEIGHT + STALL });
        const { proof, res, state } = await consumerLeg(origin);
        assert.ok(proof && proof.sub_roots, 'the consumer is handed an envelope, so it no longer stalls');
        // The consumer binds its own selected checkpoint, whose signed root the envelope misses.
        const verdict = CHK.verifyEscrowAgainstCheckpoint(makeTransfer(keys, { snapshot_block: HEIGHT }),
                                                          { coin: 'DOGE', network: NETWORK, proof });
        assert.strictEqual(verdict.ok, false);
        assert.strictEqual(verdict.reason, CHK.ESCROW_PROOF_REASON.ROOT_MISMATCH);
        // ESCROW_PROOF is a terminal refusal in the settle pass: the leg is skipped, mints nothing.
        assert.strictEqual(res.applied, false);
        assert.strictEqual(res.reason, BS.SETTLE_REASON.ESCROW_PROOF);
        assert.deepStrictEqual(state.credits, []);
        assert.deepStrictEqual(state.actions, []);
    });

    it('measures the bound from the newest signed row, so rows signed after the diverged one push it out', async function(){
        const later = [laterCheckpoint(HEIGHT + 12, OLD_ROOT, keys, 10), laterCheckpoint(HEIGHT + 50, OLD_ROOT, keys, 11)];
        const short = await stoppedOrigin({ later, tip: HEIGHT + 50 + STALL - 1 });
        assert.deepStrictEqual(await short.db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT), { error: DIVERGED_TEXT });
        sinon.restore();
        const at = await stoppedOrigin({ later, tip: HEIGHT + 50 + STALL });
        const envelope = await at.db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        assert.ok(envelope && !envelope.error && envelope.sub_roots, 'expected the envelope');
    });
});

describe('getbridgeescrowproof: what the stopped-stream release does not release @regression @tier1', function(){
    it('keeps answering the error on a minority fork while the stream is live, however far its tip runs', async function(){
        const later = [laterCheckpoint(HEIGHT + 12, OLD_ROOT, keys, 10)];
        const { db } = await originNode({ signedBalance: '13', later, validators, tip: HEIGHT + 100000 });
        assert.deepStrictEqual(await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT), { error: DIVERGED_TEXT });
    });

    it('is not sticky: a fresh signed row in the mirror puts the error back', async function(){
        const opts = { signedBalance: '13', later: [], validators, streamStopped: true, tip: HEIGHT + STALL };
        const { db } = await originNode(opts);
        const first = await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        assert.ok(first && !first.error, 'released while the stream is stopped');
        opts.streamStopped = false;
        assert.deepStrictEqual(await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT), { error: DIVERGED_TEXT });
    });

    it('never reads an empty table as a stopped stream', async function(){
        const { db } = await originNode({ signedBalance: '13' });
        db.doQueryStrict.restore();
        sinon.stub(db, 'doQueryStrict').resolves([{ newest_block: null }]);
        assert.strictEqual(await escrowDivergence.checkpointStreamStopped(db, CHAIN, NETWORK), false);
    });
});
