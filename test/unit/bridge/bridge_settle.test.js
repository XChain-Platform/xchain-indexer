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
 * The XBRIDGE settle pass: applying this chain's leg of a finalized transfer
 * (quorum, escrow cross-check, idempotency and per-block cap).
 *
 * WHAT THESE TESTS ARE FOR. Every quorum case is built from REAL Ed25519 keys and REAL
 * signatures over the module's OWN canonical, so a passing quorum means the same arithmetic
 * a hub does, not that a fixture agreed with itself. The ledger cases assert the CREDITS AND
 * DEBITS the apply produced, not that it returned a truthy object: "applied" is a claim about
 * the ledger, so the ledger is what is read back.
 *
 * THE FOUR GUARDS EACH HAVE THEIR OWN CASE, and each is written so that deleting the guard
 * turns the case red on the EFFECT rather than on a message:
 *   - the idempotency filter        (an already-settled id moves no units)
 *   - the escrow would-go-negative  (an out leg short of escrow moves no units)
 *   - the escrow check ok:false     (a refused proof moves no units and mints no action)
 *   - the per-block cap             (the 26th due transfer is not in the slice)
 * A fifth property has a case of its own because it is the one thing that must NOT be a
 * refusal: a checkpoint this node does not hold yet STALLS the pass.
 *
 *
 * THE SUITE IS SPLIT BY BEHAVIOUR. This file holds the signed canonical, quorum
 * verification and the in and out legs (guard 1). The refusal paths, the source-leg
 * rule, the due set and checkpoint selection, SLASH and the pass order, and refusal
 * logging live beside it in bridge_settle.test/, each opening the same describe so
 * every full test title is unchanged; bridge_settle.test/helpers/settle_fixtures.js
 * holds the keys, rows, proofs and the in-memory ledger ctx they share.
 *
 ********************************************************************/

'use strict';

const { BS, makeKey, sign, NETWORK, SNAPSHOT, DEST_ADDR, ESCROW_DOGE_ON_BTC, ESCROW_BTC_ON_DOGE, buildProof, makeTransfer, snapshotSet, makeCtx } = require('./bridge_settle.test/helpers/settle_fixtures.js');
const assert = require('assert');
const eq     = require('../../../src/consensus/equivocation_header.js');

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('the signed canonical', function(){

        it('is the spec field order, byte for byte, wrapped by the EQUIV header', function(){
            const row = makeTransfer([], {});
            const raw = ['XBRIDGE', row.transfer_id, '1200', 'XCHAIN', '8',
                         'BTC', '4242', row.src_address, 'DOGE', DEST_ADDR,
                         '10.00000000', '1000', 'regtest'].join('|');
            // regtest arms the EQUIV header at 0, so the wrap is unconditional on this venue;
            // asserting the wrapped form AND the inner content pins both halves.
            const expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.BRIDGE, row.transfer_id, 0, raw);
            assert.strictEqual(BS.transferCanonical(row), expected);
            assert.ok(BS.transferCanonical(row).endsWith(raw));
        });

        it('changes when any signed field changes, so a tampered row cannot reuse a signature', function(){
            const a = BS.transferCanonical(makeTransfer([], {}));
            const b = BS.transferCanonical(makeTransfer([], { amount: '10.00000001' }));
            const c = BS.transferCanonical(makeTransfer([], { dest_address: 'nAttacker' }));
            assert.notStrictEqual(a, b);
            assert.notStrictEqual(a, c);
        });

        it('is driven in the legacy arm, and ignores admission columns there', function(){
            // The disarm above is what this file rests on; a suite that silently inherited a
            // process-level arming would fail every quorum case for the wrong reason.
            assert.strictEqual(BS.transferCanonical(makeTransfer([], { admit_block_doge: SNAPSHOT + 4 })),
                               BS.transferCanonical(makeTransfer([], {})));
            assert.strictEqual(BS.transferCanonical(makeTransfer([], { admit_block_doge: null, admit_block_btc: null })),
                               BS.transferCanonical(makeTransfer([], {})), 'NULL columns are the legacy row');
        });
    });
});

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('quorum verification (the CROSS_SETTLE rule)', function(){

        it('accepts a fully signed set and reports the count', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, {});
            const { ctx } = makeCtx({ validators: snapshotSet(keys) });
            const q = await BS.verifyQuorum(BS.transferCanonical(row), row.validator_signatures,
                                            SNAPSHOT, NETWORK, ctx.indexerDb);
            assert.strictEqual(q.met, true);
            assert.strictEqual(q.valid, 3);
            assert.strictEqual(q.snapshotAbsent, false);
        });

        it('refuses a forged signature over a different message', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, {});
            const sigs = JSON.parse(row.validator_signatures);
            sigs.forEach(s => { s.sig = sign(keys[0].privateKey, 'a different message entirely'); });
            const { ctx } = makeCtx({ validators: snapshotSet(keys) });
            const q = await BS.verifyQuorum(BS.transferCanonical(row), JSON.stringify(sigs),
                                            SNAPSHOT, NETWORK, ctx.indexerDb);
            assert.strictEqual(q.met, false);
            assert.strictEqual(q.valid, 0);
        });

        it('counts a validator whose garbage entry precedes its real one (seen-set after verify)', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, {});
            const good = JSON.parse(row.validator_signatures);
            // The garbage-then-valid pair for ONE qualified validator. Marking `seen` on first
            // encounter would suppress the real signature and fail a quorate row CLOSED.
            const sigs = [{ pubkey: keys[0].pubkey, sig: 'ff'.repeat(64) }].concat(good);
            const { ctx } = makeCtx({ validators: snapshotSet(keys) });
            const q = await BS.verifyQuorum(BS.transferCanonical(row), JSON.stringify(sigs),
                                            SNAPSHOT, NETWORK, ctx.indexerDb);
            assert.strictEqual(q.valid, 3);
            assert.strictEqual(q.met, true);
        });

        it('reports an absent capability snapshot as a RETRY, never as a refusal', async function(){
            const keys = [makeKey()];
            const row  = makeTransfer(keys, {});
            const { ctx } = makeCtx({ validators: [] });
            const q = await BS.verifyQuorum(BS.transferCanonical(row), row.validator_signatures,
                                            SNAPSHOT, NETWORK, ctx.indexerDb);
            assert.strictEqual(q.snapshotAbsent, true);
            assert.strictEqual(q.met, false);
        });
    });
});

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('the IN leg (this chain mints)', function(){

        it('credits the destination at the signed decimals and records the settlement', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, {});
            const { ctx, state } = makeCtx({
                coin: 'DOGE',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } }
            });
            // A real proof of a real escrow balance above the transfer amount. The pass calls
            // the cross-check unconditionally, so without one this case would prove nothing.
            ctx.proof = buildProof('100.00000000');
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');
            assert.deepStrictEqual(state.credits, [['XCHAIN', '10.00000000', DEST_ADDR]]);
            assert.deepStrictEqual(state.debits, []);
            assert.strictEqual(state.settlements.length, 1);
            assert.strictEqual(state.settlements[0].kind, 'transfer');
            assert.strictEqual(state.settlements[0].transfer_id, row.transfer_id);
            // The gas tick is wire version 2; a general token would be 5.
            assert.strictEqual(state.actions[0].FORMAT, 2);
            assert.strictEqual(state.actions[0].ACTION, 'XBRIDGE');
        });

        it('mints wire version 5 for a general token, under the rooted child tick', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, { tick: 'PEPECASH', decimals: 2, amount: '5.00' });
            const { ctx, state } = makeCtx({
                coin: 'DOGE',
                validators: snapshotSet(keys),
                tokens: { 'BTC.PEPECASH': { TICK_ID: 9, DECIMALS: 2, SUPPLY: '0' },
                          'BTC':          { TICK_ID: 8, DECIMALS: 0, SUPPLY: '0', OWNER: ESCROW_BTC_ON_DOGE } }
            });
            ctx.proof = buildProof('9.00', 'PEPECASH');
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');
            assert.deepStrictEqual(state.credits, [['BTC.PEPECASH', '5.00', DEST_ADDR]]);
            assert.strictEqual(state.actions[0].FORMAT, 5);
        });
    });
});

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('the OUT leg (this chain releases escrow)', function(){

        it('debits the escrow role address and credits the destination', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            // Origin BTC releasing escrow from a DOGE burn: src_chain DOGE, dest_chain BTC.
            const row  = makeTransfer(keys, { src_chain: 'DOGE', dest_chain: 'BTC' });
            const { ctx, state } = makeCtx({
                coin: 'BTC',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '100' } },
                balances: { 7: '50.00000000' }
            });
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');
            assert.deepStrictEqual(state.debits,  [['XCHAIN', '10.00000000', ESCROW_DOGE_ON_BTC]]);
            assert.deepStrictEqual(state.credits, [['XCHAIN', '10.00000000', DEST_ADDR]]);
        });

        // GUARD 1 of 4: an escrow that would go negative is a protocol violation.
        it('applies NOTHING when the escrow would go negative', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const row  = makeTransfer(keys, { src_chain: 'DOGE', dest_chain: 'BTC' });
            const { ctx, state } = makeCtx({
                coin: 'BTC',
                validators: snapshotSet(keys),
                tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '100' } },
                balances: { 7: '9.99999999' }        // one satoshi short of the transfer
            });
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.reason, BS.SETTLE_REASON.ESCROW_SHORT);
            assert.deepStrictEqual(state.credits, []);
            assert.deepStrictEqual(state.debits, []);
            assert.deepStrictEqual(state.settlements, []);
            assert.deepStrictEqual(state.actions, [], 'a refused row must mint no action index');
        });
    });
});
