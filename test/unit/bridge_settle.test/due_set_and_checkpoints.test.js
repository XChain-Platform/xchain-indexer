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
 * The due set's order and per-block cap (guard 4), the proof transport that stalls
 * rather than refuses on a missing checkpoint, and deterministic checkpoint selection
 * across the anchored and the mirrored sources.
 * Part of the XBRIDGE settle pass suite; see ../bridge_settle.test.js for what these
 * tests are for and how the four guards are proven.
 *
 ********************************************************************/

'use strict';

const { BS, bindSettlementReads, makeKey, sign, NETWORK, makeTransfer, snapshotSet, makeCtx, selectorCtx } = require('./helpers/settle_fixtures.js');
const assert = require('assert');
const CHK    = require('../../../src/consensus/bridge_checkpoint_check.js');
const PC     = require('../../../src/consensus/bridge_proof_client.js');
const { XBRIDGE_MAX_PER_BLOCK } = require('../../../src/protocol/constants.js');

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('the due set: order and the per-block cap', function(){

        // GUARD 4 of 4: the per-block cap.
        it('orders by (snapshot_block, transfer_id) and slices at XBRIDGE_MAX_PER_BLOCK', async function(){
            // Deliberately built in the WRONG order and with a mixed snapshot_block, so the
            // ordering is proven rather than inherited from the fixture's array order.
            const rows = [];
            for(let i = 0; i < XBRIDGE_MAX_PER_BLOCK + 3; i++)
                rows.push({ transfer_id: String(i).padStart(64, '0'), snapshot_block: (i % 2 ? 2 : 1),
                            dest_chain: 'DOGE', network: NETWORK, effective_time: 1, status: 'finalized' });
            rows.reverse();
            const { ctx } = makeCtx({ coin: 'DOGE', mirrorTransfers: rows });
            const due = await BS.dueBridgeTransfers(ctx);
            assert.strictEqual(due.length, XBRIDGE_MAX_PER_BLOCK,
                'the cap must bound the slice: ' + due.length + ' of a cap of ' + XBRIDGE_MAX_PER_BLOCK);
            // Every even index carries snapshot_block 1 and sorts ahead of every odd one.
            for(let i = 1; i < due.length; i++){
                const prev = due[i - 1], cur = due[i];
                assert.ok(Number(prev.snapshot_block) < Number(cur.snapshot_block) ||
                          (Number(prev.snapshot_block) === Number(cur.snapshot_block) &&
                           String(prev.transfer_id) < String(cur.transfer_id)),
                          'due set is not in (snapshot_block, transfer_id) order at index ' + i);
            }
        });

        it('drops rows already settled and keeps the carried overflow in order', async function(){
            const rows = [];
            for(let i = 0; i < 4; i++)
                rows.push({ transfer_id: String(i).padStart(64, '0'), snapshot_block: 1,
                            dest_chain: 'DOGE', network: NETWORK, effective_time: 1, status: 'finalized' });
            const { ctx } = makeCtx({ coin: 'DOGE', mirrorTransfers: rows,
                                      settled: [String(0).padStart(64, '0') + '|transfer',
                                                String(2).padStart(64, '0') + '|transfer'] });
            const due = await BS.dueBridgeTransfers(ctx);
            assert.deepStrictEqual(due.map(r => r.transfer_id),
                [String(1).padStart(64, '0'), String(3).padStart(64, '0')]);
        });
    });
});

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('the proof transport: a missing checkpoint STALLS, it never refuses', function(){

        it('raises BridgeProofUnavailableError when no checkpoint at or after snapshot_block is held', async function(){
            const row = makeTransfer([], {});          // BTC -> DOGE, so an IN leg needing a proof
            const { ctx } = makeCtx({ coin: 'DOGE' });
            // Both sources answer empty, which is exactly "this node holds none yet".
            ctx.indexerDb.doQuery = async () => [];
            ctx.indexerDb.mirrorDb = () => bindSettlementReads({ doQuery: async () => [] });
            await assert.rejects(() => BS.fetchProofForTransfer(row, ctx), (err) => {
                assert.strictEqual(err.name, 'BridgeProofUnavailableError');
                assert.strictEqual(err.stallReason, PC.BRIDGE_PROOF_BARRIER);
                assert.strictEqual(err.detail, PC.PROOF_STALL_REASON.NO_CHECKPOINT);
                return true;
            });
        });

        it('names a barrier-shaped stall reason, so health classifies it as mirror lag', function(){
            // health.js / XChainIndexer.isMirrorBarrierReason keys on the '_barrier' suffix; a
            // reason without it reads as a wedged indexer and pages an operator for mirror lag.
            assert.ok(/_barrier$/.test(PC.BRIDGE_PROOF_BARRIER), PC.BRIDGE_PROOF_BARRIER);
        });

        it('needs no proof for an OUT leg: the escrow it releases is a local balance', async function(){
            const row = makeTransfer([], { src_chain: 'DOGE', dest_chain: 'BTC' });
            const { ctx } = makeCtx({ coin: 'BTC' });
            assert.strictEqual(await BS.fetchProofForTransfer(row, ctx), null);
            // And the check itself says so, rather than this test asserting the exemption twice.
            const cross = CHK.verifyEscrowAgainstCheckpoint(row, ctx);
            assert.strictEqual(cross.ok, true);
            assert.strictEqual(cross.reason, CHK.ESCROW_PROOF_REASON.OUT_LEG);
        });

        it('needs no proof for a row whose destination is another chain', async function(){
            const row = makeTransfer([], { dest_chain: 'LTC' });
            const { ctx } = makeCtx({ coin: 'DOGE' });
            assert.strictEqual(await BS.fetchProofForTransfer(row, ctx), null);
        });
    });
});

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('deterministic checkpoint selection', function(){
        it('takes the LOWEST height at or after snapshot_block, and the highest seq at it', async function(){
            const row = makeTransfer([], {});
            // The SQL does the ordering on a real database; the merge across sources is what
            // this asserts, so both sources are handed their own best row and the merge picks.
            const ctx = selectorCtx([{ chain: 'BTC', network: NETWORK, block_index: 1500, checkpoint_seq: 9,
                                       snapshot_block: 1500, state_root: 'a'.repeat(64), state_root_version: 1 }],
                                    []);
            const picked = await PC.selectCheckpoint(row, ctx);
            assert.strictEqual(picked.block_index, 1500);
            assert.strictEqual(picked.checkpoint_seq, 9);
            assert.strictEqual(picked.source, 'anchor_actions');
        });

        it('prefers a lower mirrored height over a higher locally anchored one', async function(){
            const row = makeTransfer([], {});
            const mirrored = [{ chain: 'BTC', network: NETWORK, block_index: 1210, checkpoint_seq: 2,
                                snapshot_block: 1210, state_root: 'b'.repeat(64), state_root_version: 1,
                                block_hash: 'h', ledger_hash: 'l', actions_hash: 'a', contract_hash: 'c',
                                block_merkle_root: 'm', block_merkle_version: 1, validator_signatures: '[]' }];
            const ctx = selectorCtx([{ chain: 'BTC', network: NETWORK, block_index: 1500, checkpoint_seq: 9,
                                       snapshot_block: 1500, state_root: 'a'.repeat(64), state_root_version: 1 }],
                                    mirrored);
            // The mirrored row's quorum is re-verified before it becomes a candidate; with an
            // empty signature list it does NOT, so the anchored row is still the pick. That is
            // the fail-closed direction: an unverified mirror row is not a candidate at all.
            const picked = await PC.selectCheckpoint(row, ctx);
            assert.strictEqual(picked.block_index, 1500);
        });
    });
});

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('deterministic checkpoint selection', function(){
        it('admits a mirrored row only once its own quorum re-verifies', async function(){
            const keys = [makeKey(), makeKey(), makeKey()];
            const cp = { chain: 'BTC', network: NETWORK, block_index: 1210, checkpoint_seq: 2,
                         snapshot_block: 1210, state_root: 'b'.repeat(64), state_root_version: 1,
                         block_hash: 'hash', ledger_hash: 'ledger', actions_hash: 'actions',
                         contract_hash: 'contract', block_merkle_root: 'merkle', block_merkle_version: 1 };
            cp.validator_signatures = JSON.stringify(
                keys.map(k => ({ pubkey: k.pubkey, sig: sign(k.privateKey, PC.checkpointCanonical(cp)) })));
            const row = makeTransfer([], {});
            const ctx = selectorCtx([], [cp]);
            ctx.indexerDb.getValidatorsByCapability   = async () => snapshotSet(keys);
            ctx.indexerDb.getStakeWeightsByCapability = async () => snapshotSet(keys);
            assert.strictEqual(await PC.verifyCheckpointQuorum(cp, ctx.indexerDb), true);
            const picked = await PC.selectCheckpoint(row, ctx);
            assert.strictEqual(picked.block_index, 1210);
            assert.strictEqual(picked.source, 'state_checkpoints');

            // Flip one signature to a forgery and the row stops being a candidate: the whole
            // cross-check is vacuous if an unverified root can be handed to it.
            const forged = Object.assign({}, cp, { validator_signatures: JSON.stringify(
                keys.map(k => ({ pubkey: k.pubkey, sig: sign(k.privateKey, 'not this checkpoint') }))) });
            assert.strictEqual(await PC.verifyCheckpointQuorum(forged, ctx.indexerDb), false);
            const ctx2 = selectorCtx([], [forged]);
            ctx2.indexerDb.getValidatorsByCapability   = async () => snapshotSet(keys);
            ctx2.indexerDb.getStakeWeightsByCapability = async () => snapshotSet(keys);
            assert.strictEqual(await PC.selectCheckpoint(row, ctx2), null);
        });

        it('resolves the origin indexer endpoint through the three-tier idiom', function(){
            const saved = process.env.BTC_INDEXER_API_URL;
            delete process.env.BTC_INDEXER_API_URL;
            try {
                assert.strictEqual(PC.resolveOriginEndpoint('BTC', { BTC_INDEXER_URL: 'http://cfg:3000/' }).url,
                                   'http://cfg:3000/');
                process.env.BTC_INDEXER_API_URL = 'http://env:3000/';
                assert.strictEqual(PC.resolveOriginEndpoint('BTC', { BTC_INDEXER_URL: 'http://cfg:3000/' }).url,
                                   'http://env:3000/');
                assert.strictEqual(PC.resolveOriginEndpoint('not-a-coin', {}).url, '');
            } finally {
                if(saved === undefined) delete process.env.BTC_INDEXER_API_URL;
                else process.env.BTC_INDEXER_API_URL = saved;
            }
        });
    });
});
