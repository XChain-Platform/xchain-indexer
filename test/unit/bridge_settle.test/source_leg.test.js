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
 * One settlement per source leg: a second row naming a lock or burn this chain already
 * settled is refused, a different leg still applies, the decision survives a replay in
 * either mirror order, and a settled leg leaves the due set.
 * Part of the XBRIDGE settle pass suite; see ../bridge_settle.test.js for what these
 * tests are for and how the four guards are proven.
 *
 ********************************************************************/

'use strict';

const { BS, makeKey, NETWORK, DEST_ADDR, ESCROW_DOGE_ON_BTC, buildProof, makeTransfer, snapshotSet, makeCtx, duplicatePair } = require('./helpers/settle_fixtures.js');
const assert = require('assert');

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('one settlement per SOURCE LEG (the ledger of record refusal)', function(){
        it('refuses a second IN-leg row naming a lock this chain already minted for', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const pair = duplicatePair(keys);
            assert.notStrictEqual(pair[0].transfer_id, pair[1].transfer_id,
                'the two ids must differ, or the id-keyed filter would be what refuses the second');
            const { ctx, state } = makeCtx({
                coin: 'DOGE',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } }
            });
            ctx.proof = buildProof('100.00000000');
            assert.strictEqual((await BS.applyBridgeTransfer(pair[0], ctx)).applied, true);
            const res = await BS.applyBridgeTransfer(pair[1], ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.SRC_LEG_APPLIED);
            // The LEDGER is the assertion, not the verdict string: one mint of the amount, one
            // settlement row, one minted action index. A leaked duplicate would double the supply.
            assert.deepStrictEqual(state.credits, [['XCHAIN', '10.00000000', DEST_ADDR]]);
            assert.strictEqual(state.settlements.length, 1);
            assert.strictEqual(state.actions.length, 1);
        });

        it('refuses a second OUT-leg row naming a burn this chain already released for', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const pair = duplicatePair(keys, { src_chain: 'DOGE', dest_chain: 'BTC', src_action_index: 7731 });
            const { ctx, state } = makeCtx({
                coin: 'BTC',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '100' } },
                // Deliberately enough escrow for BOTH releases, so the would-go-negative guard
                // cannot be what stops the second one: this is the duplicate-release shape, a burn of 2
                // releasing 4 out of an escrow that could afford it.
                balances: { 7: '50.00000000' },
                mirrorTransfers: pair
            });
            const applied = await BS.processBridgeSettlePass(ctx);
            assert.deepStrictEqual(applied.transfers, [pair[0].transfer_id]);
            assert.deepStrictEqual(state.debits,  [['XCHAIN', '10.00000000', ESCROW_DOGE_ON_BTC]]);
            assert.deepStrictEqual(state.credits, [['XCHAIN', '10.00000000', DEST_ADDR]]);
            assert.strictEqual(state.settlements.length, 1);
        });
    });
});

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('one settlement per SOURCE LEG (the ledger of record refusal)', function(){
        it('still applies a second row naming a DIFFERENT lock on the same chain', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const first  = makeTransfer(keys, { transfer_id: '3'.repeat(64), src_action_index: 4242 });
            const second = makeTransfer(keys, { transfer_id: '4'.repeat(64), src_action_index: 4243 });
            const { ctx, state } = makeCtx({
                coin: 'DOGE',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } }
            });
            ctx.proof = buildProof('100.00000000');
            assert.strictEqual((await BS.applyBridgeTransfer(first, ctx)).applied, true);
            const res = await BS.applyBridgeTransfer(second, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');
            assert.strictEqual(state.credits.length, 2, 'the refusal must key on the leg, never on the chain');
            assert.strictEqual(state.settlements.length, 2);
        });

        it('reaches the same decision on a replay from the same state, in either mirror order', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const pair = duplicatePair(keys, { src_chain: 'DOGE', dest_chain: 'BTC', src_action_index: 8800 });
            const run = async (order) => {
                const { ctx, state } = makeCtx({
                    coin: 'BTC', validators: snapshotSet(keys),
                    tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '100' } },
                    balances: { 7: '50.00000000' }, mirrorTransfers: order
                });
                const applied = await BS.processBridgeSettlePass(ctx);
                return { transfers: applied.transfers, debits: state.debits, legs: [...state.settledLegs] };
            };
            // The SECOND run is handed the mirror in the opposite physical order, which is what a
            // node that received the rows in a different sequence sees. The decision may not turn
            // on that: the winner is fixed by (snapshot_block, transfer_id).
            const a = await run(pair.slice());
            const b = await run(pair.slice().reverse());
            assert.deepStrictEqual(a, b);
            assert.deepStrictEqual(a.transfers, [pair[0].transfer_id]);
            assert.deepStrictEqual(a.legs, ['DOGE:8800']);
        });

        it('applies nothing more when a later block re-evaluates a mirror it already settled', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const pair = duplicatePair(keys, { src_chain: 'DOGE', dest_chain: 'BTC', src_action_index: 8800 });
            const { ctx, state } = makeCtx({
                coin: 'BTC', validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '100' } },
                balances: { 7: '50.00000000' }, mirrorTransfers: pair,
                settled: [pair[0].transfer_id + '|transfer'],
                settledLegs: ['DOGE:8800']
            });
            const applied = await BS.processBridgeSettlePass(ctx);
            assert.deepStrictEqual(applied.transfers, []);
            assert.deepStrictEqual(state.debits, []);
            assert.deepStrictEqual(state.credits, []);
            assert.deepStrictEqual(state.actions, [], 'a refused row must mint no action index');
        });
    });
});

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('one settlement per SOURCE LEG (the ledger of record refusal)', function(){
        it('drops a settled leg from the due set, so a duplicate cannot hold a cap slot forever', async function(){
            const rows = [
                { transfer_id: '1'.repeat(64), snapshot_block: 1, dest_chain: 'DOGE', network: NETWORK,
                  effective_time: 1, status: 'finalized', src_chain: 'BTC', src_action_index: 11 },
                { transfer_id: '2'.repeat(64), snapshot_block: 2, dest_chain: 'DOGE', network: NETWORK,
                  effective_time: 1, status: 'finalized', src_chain: 'BTC', src_action_index: 12 }
            ];
            const { ctx } = makeCtx({ coin: 'DOGE', mirrorTransfers: rows, settledLegs: ['BTC:11'] });
            const due = await BS.dueBridgeTransfers(ctx);
            assert.deepStrictEqual(due.map(r => r.transfer_id), ['2'.repeat(64)]);
        });

        it('never lets an applied leg on one chain suppress the same action index on another', async function(){
            const rows = [
                { transfer_id: '1'.repeat(64), snapshot_block: 1, dest_chain: 'DOGE', network: NETWORK,
                  effective_time: 1, status: 'finalized', src_chain: 'BTC', src_action_index: 11 },
                { transfer_id: '2'.repeat(64), snapshot_block: 1, dest_chain: 'DOGE', network: NETWORK,
                  effective_time: 1, status: 'finalized', src_chain: 'LTC', src_action_index: 11 }
            ];
            // LTC's leg 11 is settled; BTC's leg 11 is a different leg and must survive. The
            // query selects the cross product of chains and indexes, so this is what proves the
            // PAIR is matched rather than the two lists separately.
            const { ctx } = makeCtx({ coin: 'DOGE', mirrorTransfers: rows, settledLegs: ['LTC:11'] });
            const due = await BS.dueBridgeTransfers(ctx);
            assert.deepStrictEqual(due.map(r => r.transfer_id), ['1'.repeat(64)]);
        });

        it('refuses a row that names no source action index, which has no leg to test', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, { src_action_index: null });
            const { ctx, state } = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys),
                                             tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } } });
            ctx.proof = buildProof('100.00000000');
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.ROW_FIELDS);
            assert.deepStrictEqual(state.credits, []);
            assert.deepStrictEqual(state.actions, []);
            // And the helper answers "no" rather than inventing a key for an absent leg.
            assert.strictEqual(await BS.isSourceLegSettled(ctx.indexerDb, 'BTC', null), false);
        });
    });
});
