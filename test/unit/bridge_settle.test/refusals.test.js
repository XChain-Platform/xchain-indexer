/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The settle pass's refusal and deferral paths: the idempotency filter (guard 2) and its
 * (id, kind) key, the escrow cross-check (guard 3), and the not-due, network, chain-id,
 * destination and quorum refusals.
 * Part of the XBRIDGE settle pass suite; see ../bridge_settle.test.js for what these
 * tests are for and how the four guards are proven.
 *
 ********************************************************************/

'use strict';

const { BS, makeKey, NETWORK, SNAPSHOT, buildProof, makeTransfer, snapshotSet, makeCtx } = require('./helpers/settle_fixtures.js');
const assert = require('assert');
const swq    = require('../../../src/stake_weighted_quorum.js');
const CHK    = require('../../../src/consensus/bridge_checkpoint_check.js');

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('the refusal and deferral paths', function(){
        // GUARD 2 of 4: the idempotency filter.
        it('applies NOTHING for an id already recorded in bridge_settlements', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, {});
            const { ctx, state } = makeCtx({
                coin: 'DOGE',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } },
                settled: [row.transfer_id + '|transfer']
            });
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.ALREADY_APPLIED);
            assert.deepStrictEqual(state.credits, []);
            assert.deepStrictEqual(state.actions, []);
        });

        it('keys idempotency on (id, kind), so a policy record does not suppress a transfer', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, {});
            const { ctx, state } = makeCtx({
                coin: 'DOGE',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } },
                settled: [row.transfer_id + '|policy']       // same id, the OTHER kind
            });
            ctx.proof = buildProof('100.00000000');
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');
            assert.strictEqual(state.credits.length, 1);
        });

        // GUARD 3 of 4: the escrow cross-check.
        it('applies NOTHING when the escrow cross-check returns ok:false', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, {});
            const { ctx, state } = makeCtx({
                coin: 'DOGE',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } }
            });
            // No ctx.proof at all: the real check refuses an in leg with PROOF_MISSING. This is
            // the check's own verdict reached through the settle pass's one door, not a stub.
            ctx.proof = undefined;
            const cross = BS.verifyEscrowAgainstCheckpoint(row, ctx);
            assert.strictEqual(cross.ok, false);
            assert.strictEqual(cross.reason, CHK.ESCROW_PROOF_REASON.PROOF_MISSING);

            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.ESCROW_PROOF);
            assert.deepStrictEqual(state.credits, []);
            assert.deepStrictEqual(state.debits, []);
            assert.deepStrictEqual(state.actions, [], 'a refused row must mint no action index');
            assert.deepStrictEqual(state.settlements, []);
        });
    });
});

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('the refusal and deferral paths', function(){
        it('carries a row whose effective_time is ahead of this block protocol time', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, { effective_time: 999999 });
            const { ctx, state } = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys),
                                             tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8 } } });
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.NOT_DUE);
            assert.deepStrictEqual(state.credits, []);
        });

        it('refuses a row signed on another network', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, { network: 'mainnet' });
            const { ctx, state } = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys),
                                             tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8 } } });
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.NETWORK);
            assert.deepStrictEqual(state.credits, []);
        });

        it('refuses a row carrying a foreign btc_chain_id (a re-genesised rail)', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, { btc_chain_id: 'b'.repeat(64) });
            const { ctx, state } = makeCtx({ coin: 'DOGE', chainId: 'c'.repeat(64),
                                             validators: snapshotSet(keys),
                                             tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8 } } });
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.CHAIN_ID);
            assert.deepStrictEqual(state.credits, []);
        });

        it('refuses a row whose destination is another chain', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, { dest_chain: 'LTC' });
            const { ctx } = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys) });
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.NOT_OURS);
        });

        it('refuses a quorum that does not meet the bar, and moves no units', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer([keys[0]], {});           // 1 of 3 sources
            const { ctx, state } = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys),
                                             tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8 } } });
            assert.strictEqual(swq.isStakeWeightedQuorumActive(SNAPSHOT, NETWORK), true);
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.QUORUM);
            assert.deepStrictEqual(state.credits, []);
            assert.deepStrictEqual(state.actions, []);
        });
    });
});
