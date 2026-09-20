/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const CHK = require('../../../src/consensus/bridge_checkpoint_check.js');
const M = require('../../../src/consensus/merkle.js');
const SUB = require('../../../src/consensus/gates/state_subtree_gate.js');
const proofClient = require('../../../src/consensus/bridge_proof_client.js');
const { resolveTransferOrigin } = require('../../../src/consensus/bridge_checkpoint_check/origin.js');
const {
    BS, makeKey, NETWORK, SNAPSHOT, DEST_ADDR, ESCROW_DOGE_ON_BTC, ESCROW_BTC_ON_DOGE,
    makeTransfer, snapshotSet, makeCtx
} = require('./bridge_settle.test/helpers/settle_fixtures.js');

const CP_HEIGHT = SNAPSHOT + 5;

function proofFor(origin, dest, tick, balance){
    const escrow = CHK.resolveEscrowAddress(origin, dest, NETWORK);
    const smt = new M.SparseMerkleTree();
    const key = M.balanceKey(origin, NETWORK, escrow, tick);
    smt.set(key, M.amountLeaf(balance));
    const subRoots = { balances_root: smt.rootHex(), stakes_root: M.toHex(M.EMPTY_SMT_ROOT) };
    return {
        chain: origin,
        network: NETWORK,
        block_index: CP_HEIGHT,
        sub_roots: subRoots,
        address: escrow,
        tick: tick,
        balance: balance,
        balance_proof: { siblings: smt.prove(key).siblings },
        checkpoint: {
            chain: origin,
            network: NETWORK,
            block_index: CP_HEIGHT,
            checkpoint_seq: 1,
            snapshot_block: CP_HEIGHT,
            state_root: M.toHex(M.stateRoot(subRoots)),
            state_root_version: SUB.stateRootVersion(CP_HEIGHT, NETWORK, origin)
        }
    };
}

describe('bridge escrow origin generalization @regression @tier1', function(){
    afterEach(function(){ sinon.restore(); });

    it('derives XCHAIN from BTC, bare tokens from src_chain, and burns only from a dest-rooted tick', function(){
        assert.deepStrictEqual(resolveTransferOrigin({ src_chain: 'BTC', dest_chain: 'DOGE', tick: 'XCHAIN' }),
            { originChain: 'BTC', nativeTick: 'XCHAIN', kind: 'lock' });
        assert.deepStrictEqual(resolveTransferOrigin({ src_chain: 'DOGE', dest_chain: 'BTC', tick: 'XCHAIN' }),
            { originChain: 'BTC', nativeTick: 'XCHAIN', kind: 'burn' });
        assert.deepStrictEqual(resolveTransferOrigin({ src_chain: 'DOGE', dest_chain: 'BTC', tick: 'FUFU' }),
            { originChain: 'DOGE', nativeTick: 'FUFU', kind: 'lock' });
        assert.deepStrictEqual(resolveTransferOrigin({ src_chain: 'BTC', dest_chain: 'DOGE', tick: 'DOGE.FUFU' }),
            { originChain: 'DOGE', nativeTick: 'FUFU', kind: 'burn' });
        assert.strictEqual(resolveTransferOrigin({ src_chain: 'BTC', dest_chain: 'DOGE', tick: 'BTC.FUFU' }), null);
        assert.strictEqual(resolveTransferOrigin({ src_chain: 'BTC', dest_chain: 'DOGE', tick: 'LTC.FUFU' }), null);
    });

    it('binds colliding FUFU proofs to their own origin chain', function(){
        const btcRow = makeTransfer([], { src_chain: 'BTC', dest_chain: 'LTC', tick: 'FUFU', decimals: 2, amount: '5.00' });
        const dogeRow = makeTransfer([], { src_chain: 'DOGE', dest_chain: 'LTC', tick: 'FUFU', decimals: 2, amount: '5.00' });
        const btcCtx = { coin: 'LTC', network: NETWORK, proof: proofFor('BTC', 'LTC', 'FUFU', '9.00') };
        const dogeCtx = { coin: 'LTC', network: NETWORK, proof: proofFor('DOGE', 'LTC', 'FUFU', '9.00') };

        assert.strictEqual(CHK.verifyEscrowAgainstCheckpoint(btcRow, btcCtx).ok, true);
        assert.strictEqual(CHK.verifyEscrowAgainstCheckpoint(dogeRow, dogeCtx).ok, true);
        assert.strictEqual(CHK.verifyEscrowAgainstCheckpoint(dogeRow, btcCtx).ok, false,
            'a BTC FUFU proof must not authorize a DOGE FUFU mint');
        assert.strictEqual(CHK.verifyEscrowAgainstCheckpoint(btcRow, dogeCtx).ok, false,
            'a DOGE FUFU proof must not authorize a BTC FUFU mint');
    });

    it('fetches a proof from a bare token origin and skips rooted burns or foreign roots', async function(){
        const marker = { proof: true };
        const stub = sinon.stub(proofClient, 'buildEscrowProof').resolves(marker);
        const lock = makeTransfer([], { src_chain: 'DOGE', dest_chain: 'BTC', tick: 'FUFU' });
        const burn = makeTransfer([], { src_chain: 'BTC', dest_chain: 'DOGE', tick: 'DOGE.FUFU' });
        const wrong = makeTransfer([], { src_chain: 'BTC', dest_chain: 'DOGE', tick: 'BTC.FUFU' });
        const btcCtx = makeCtx({ coin: 'BTC' }).ctx;
        const dogeCtx = makeCtx({ coin: 'DOGE' }).ctx;

        assert.strictEqual(await BS.fetchProofForTransfer(lock, btcCtx), marker);
        assert.strictEqual(stub.firstCall.args[0], lock);
        assert.strictEqual(stub.firstCall.args[2], CHK.resolveEscrowAddress('DOGE', 'BTC', NETWORK));
        assert.strictEqual(await BS.fetchProofForTransfer(burn, dogeCtx), null);
        assert.strictEqual(await BS.fetchProofForTransfer(wrong, dogeCtx), null);
        assert.strictEqual(stub.callCount, 1);
    });

    it('mints colliding FUFU assets under distinct origin roots', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const btcRow = makeTransfer(keys, { transfer_id: 'b'.repeat(64), src_chain: 'BTC', dest_chain: 'DOGE',
            tick: 'FUFU', decimals: 2, amount: '5.00' });
        const dogeRow = makeTransfer(keys, { transfer_id: 'd'.repeat(64), src_chain: 'DOGE', dest_chain: 'BTC',
            tick: 'FUFU', decimals: 2, amount: '6.00' });
        const btcMint = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys), tokens: {
            'BTC.FUFU': { TICK_ID: 10, DECIMALS: 2, SUPPLY: '0' },
            BTC: { TICK_ID: 11, DECIMALS: 0, SUPPLY: '0', OWNER: ESCROW_BTC_ON_DOGE }
        } });
        const dogeMint = makeCtx({ coin: 'BTC', validators: snapshotSet(keys), tokens: {
            'DOGE.FUFU': { TICK_ID: 20, DECIMALS: 2, SUPPLY: '0' },
            DOGE: { TICK_ID: 21, DECIMALS: 0, SUPPLY: '0', OWNER: ESCROW_DOGE_ON_BTC }
        } });
        const crossedProof = makeCtx({ coin: 'BTC', validators: snapshotSet(keys), tokens: {
            'DOGE.FUFU': { TICK_ID: 20, DECIMALS: 2, SUPPLY: '0' },
            DOGE: { TICK_ID: 21, DECIMALS: 0, SUPPLY: '0', OWNER: ESCROW_DOGE_ON_BTC }
        } });
        btcMint.ctx.proof = proofFor('BTC', 'DOGE', 'FUFU', '9.00');
        dogeMint.ctx.proof = proofFor('DOGE', 'BTC', 'FUFU', '9.00');
        crossedProof.ctx.proof = proofFor('BTC', 'DOGE', 'FUFU', '9.00');

        assert.strictEqual((await BS.applyBridgeTransfer(btcRow, btcMint.ctx)).applied, true);
        assert.strictEqual((await BS.applyBridgeTransfer(dogeRow, dogeMint.ctx)).applied, true);
        assert.strictEqual((await BS.applyBridgeTransfer(dogeRow, crossedProof.ctx)).applied, false);
        assert.deepStrictEqual(btcMint.state.credits, [['BTC.FUFU', '5.00', DEST_ADDR]]);
        assert.deepStrictEqual(dogeMint.state.credits, [['DOGE.FUFU', '6.00', DEST_ADDR]]);
        assert.deepStrictEqual(crossedProof.state.credits, [], 'a BTC FUFU proof must mint no DOGE FUFU');
    });

    it('releases rooted burns only from the matching native escrow asset', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const btcBurn = makeTransfer(keys, { transfer_id: 'c'.repeat(64), src_chain: 'DOGE', dest_chain: 'BTC',
            tick: 'BTC.FUFU', decimals: 2, amount: '5.00' });
        const dogeBurn = makeTransfer(keys, { transfer_id: 'e'.repeat(64), src_chain: 'BTC', dest_chain: 'DOGE',
            tick: 'DOGE.FUFU', decimals: 2, amount: '6.00' });
        const btcRelease = makeCtx({ coin: 'BTC', validators: snapshotSet(keys),
            tokens: { FUFU: { TICK_ID: 30, DECIMALS: 2, SUPPLY: '100' } }, balances: { 30: '9.00' } });
        const dogeRelease = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys),
            tokens: { FUFU: { TICK_ID: 40, DECIMALS: 2, SUPPLY: '100' } }, balances: { 40: '9.00' } });

        assert.strictEqual((await BS.applyBridgeTransfer(btcBurn, btcRelease.ctx)).applied, true);
        assert.strictEqual((await BS.applyBridgeTransfer(dogeBurn, dogeRelease.ctx)).applied, true);
        assert.deepStrictEqual(btcRelease.state.debits, [['FUFU', '5.00', ESCROW_DOGE_ON_BTC]]);
        assert.deepStrictEqual(dogeRelease.state.debits, [['FUFU', '6.00', ESCROW_BTC_ON_DOGE]]);

        const crossed = makeTransfer(keys, { transfer_id: 'f'.repeat(64), src_chain: 'BTC', dest_chain: 'DOGE',
            tick: 'BTC.FUFU', decimals: 2, amount: '1.00' });
        const crossedCtx = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys),
            tokens: { FUFU: { TICK_ID: 40, DECIMALS: 2, SUPPLY: '100' } }, balances: { 40: '9.00' } });
        const refused = await BS.applyBridgeTransfer(crossed, crossedCtx.ctx);
        assert.strictEqual(refused.applied, false);
        assert.deepStrictEqual(crossedCtx.state.credits, []);
        assert.deepStrictEqual(crossedCtx.state.debits, []);
    });
});
