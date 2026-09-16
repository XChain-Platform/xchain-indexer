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
 * Refusal logging: a terminal refusal logs once per row and reason across passes, a
 * deferral logs on every pass, and the memo stays bounded.
 * Part of the XBRIDGE settle pass suite; see ../bridge_settle.test.js for what these
 * tests are for and how the four guards are proven.
 *
 ********************************************************************/

'use strict';

const { BS, makeKey, makeTransfer, snapshotSet, makeCtx, captureConsole } = require('./helpers/settle_fixtures.js');
const assert = require('assert');

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('refusal logging: once per row, not once per pass', function(){
        // The memo is per-process (module-level), so a prior test's refusals under a reused
        // transfer_id would otherwise leak into these counts. Each test below also picks its own
        // id, but resetting first keeps this suite independent of run order.
        beforeEach(function(){ BS.resetRefusalMemo(); });

        it('logs a terminal refusal exactly once across three settle passes over one row that never clears', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            // An OUT leg one satoshi short of the escrow it would release. ESCROW_SHORT is never
            // recorded in bridge_settlements (it is a refusal, not an applied settlement), so the
            // row stays in the due set and a real indexer re-examines it on every later block.
            const row = makeTransfer(keys, { transfer_id: 'f'.repeat(64), src_chain: 'DOGE', dest_chain: 'BTC' });
            const { ctx, state } = makeCtx({
                coin: 'BTC',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '100' } },
                balances: { 7: '9.99999999' },
                mirrorTransfers: [row]
            });

            const lines = await captureConsole(async () => {
                for(let pass = 0; pass < 3; pass++){
                    const applied = await BS.processBridgeSettlePass(ctx);
                    assert.deepStrictEqual(applied.transfers, [], 'the row must never apply');
                }
            });
            assert.deepStrictEqual(state.credits, [], 'a permanently refused row moves no units');

            const named = lines.filter(l => l.includes(row.transfer_id.substring(0, 16)) &&
                                             l.includes(BS.SETTLE_REASON.ESCROW_SHORT));
            assert.strictEqual(named.length, 1,
                'three passes over one terminally refused row must log the refusal exactly once, got:\n' +
                lines.join('\n'));
        });
    });
});

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('refusal logging: once per row, not once per pass', function(){
        // The memo is per-process (module-level), so a prior test's refusals under a reused
        // transfer_id would otherwise leak into these counts. Each test below also picks its own
        // id, but resetting first keeps this suite independent of run order.
        beforeEach(function(){ BS.resetRefusalMemo(); });

        it('logs again exactly once when the refusal reason for the same id changes', async function(){
            const id = 'e'.repeat(64);
            const keys = [makeKey(), makeKey(), makeKey()];

            // First sighting of this id: a 1-of-3 signed row fails QUORUM.
            const quorumRow = makeTransfer([keys[0]], { transfer_id: id });
            const quorumCtx = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys),
                                        tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8 } } }).ctx;

            // Second sighting of the SAME id: fully signed (quorum met) but shaped as an OUT leg
            // one satoshi short of the escrow it would release, so it refuses on ESCROW_SHORT
            // instead. A genuinely different terminal reason for the id, which must log again.
            const escrowRow = makeTransfer(keys, { transfer_id: id, src_chain: 'DOGE', dest_chain: 'BTC' });
            const escrowCtx = makeCtx({ coin: 'BTC', validators: snapshotSet(keys),
                                       tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '100' } },
                                       balances: { 7: '9.99999999' } }).ctx;

            const lines = await captureConsole(async () => {
                const res1 = await BS.applyBridgeTransfer(quorumRow, quorumCtx);
                assert.strictEqual(res1.reason, BS.SETTLE_REASON.QUORUM);
                const res1b = await BS.applyBridgeTransfer(quorumRow, quorumCtx);
                assert.strictEqual(res1b.reason, BS.SETTLE_REASON.QUORUM);

                const res2 = await BS.applyBridgeTransfer(escrowRow, escrowCtx);
                assert.strictEqual(res2.reason, BS.SETTLE_REASON.ESCROW_SHORT);
                const res2b = await BS.applyBridgeTransfer(escrowRow, escrowCtx);
                assert.strictEqual(res2b.reason, BS.SETTLE_REASON.ESCROW_SHORT);
            });

            const quorumLines = lines.filter(l => l.includes(id.substring(0, 16)) && l.includes(BS.SETTLE_REASON.QUORUM));
            const escrowLines = lines.filter(l => l.includes(id.substring(0, 16)) && l.includes(BS.SETTLE_REASON.ESCROW_SHORT));
            assert.strictEqual(quorumLines.length, 1, 'two QUORUM refusals for the same id must log once');
            assert.strictEqual(escrowLines.length, 1,
                'the reason changed for this id (QUORUM -> ESCROW_SHORT), so it must log again exactly once');
        });

        it('leaves a DEFERRAL (snapshot not yet mirrored) logging every pass, unlike a terminal refusal', async function(){
            const row = makeTransfer([], { transfer_id: 'd'.repeat(64) });   // no validators mirrored yet
            const { ctx } = makeCtx({ coin: 'DOGE',
                                      tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8 } } });   // validators: [] -> N=0
            const lines = await captureConsole(async () => {
                for(let i = 0; i < 3; i++){
                    const res = await BS.applyBridgeTransfer(row, ctx);
                    assert.strictEqual(res.reason, BS.SETTLE_REASON.SNAPSHOT_ABSENT);
                }
            });
            const deferring = lines.filter(l => l.includes(row.transfer_id.substring(0, 16)) && l.includes('deferring'));
            assert.strictEqual(deferring.length, 3,
                'a deferral is retried every pass on purpose (the snapshot may arrive by the next one), ' +
                'so it is a different class from a terminal refusal and stays per-pass');
        });
    });
});

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('refusal logging: once per row, not once per pass', function(){
        // The memo is per-process (module-level), so a prior test's refusals under a reused
        // transfer_id would otherwise leak into these counts. Each test below also picks its own
        // id, but resetting first keeps this suite independent of run order.
        beforeEach(function(){ BS.resetRefusalMemo(); });

        it('bounds the memo so a long-running process cannot grow it without limit', function(){
            BS.resetRefusalMemo();
            for(let i = 0; i < 6000; i++)
                BS._shouldLogRefusalForTest('XBRIDGE', 'id' + i, 'REASON');
            assert.ok(BS._refusalMemoSizeForTest() <= 5000, 'the memo must stay bounded past its cap');
        });
    });
});
