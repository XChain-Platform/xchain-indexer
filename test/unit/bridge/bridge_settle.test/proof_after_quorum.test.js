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
 * Proof transport begins only after terminal transfer refusals have passed.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const PC = require('../../../../src/consensus/bridge_proof_client.js');
const {
    BS, makeKey, makeTransfer, snapshotSet, makeCtx, captureConsole
} = require('./helpers/settle_fixtures.js');

function countCheckpointReads(ctx){
    let count = 0;
    ctx.indexerDb.getEarliestValidAnchorCheckpoint = async () => { count++; return []; };
    ctx.indexerDb.getMirroredStateCheckpointCandidates = async () => { count++; return []; };
    return () => count;
}

describe('bridge_settle: proof acquisition after terminal guards', function(){
    it('refuses a non-quorate due in leg without fetching a proof', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeTransfer([keys[0]], {});
        const { ctx, state } = makeCtx({
            coin: 'DOGE', validators: snapshotSet(keys), mirrorTransfers: [row]
        });
        const checkpointReads = countCheckpointReads(ctx);

        let applied;
        await captureConsole(async () => { applied = await BS.processBridgeSettlePass(ctx); });

        assert.deepStrictEqual(applied.transfers, []);
        assert.strictEqual(checkpointReads(), 0, 'a quorum refusal must not start proof transport');
        assert.deepStrictEqual(state.actions, []);
        assert.deepStrictEqual(state.credits, []);
        assert.strictEqual('proof' in ctx, false);
        assert.strictEqual('fetchProof' in ctx, false);
    });

    it('still defers a quorate due in leg when no checkpoint is held', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeTransfer(keys, {});
        const { ctx, state } = makeCtx({
            coin: 'DOGE', validators: snapshotSet(keys), mirrorTransfers: [row]
        });
        const checkpointReads = countCheckpointReads(ctx);

        await assert.rejects(() => BS.processBridgeSettlePass(ctx), (err) => {
            assert.strictEqual(err.name, 'BridgeProofUnavailableError');
            assert.strictEqual(err.detail, PC.PROOF_STALL_REASON.NO_CHECKPOINT);
            return true;
        });
        assert.strictEqual(checkpointReads(), 2, 'both local checkpoint sources must be checked');
        assert.deepStrictEqual(state.actions, []);
        assert.strictEqual('proof' in ctx, false);
        assert.strictEqual('fetchProof' in ctx, false);
    });

    it('refuses an already settled row without calling its proof fetcher', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeTransfer(keys, {});
        const { ctx, state } = makeCtx({
            coin: 'DOGE', validators: snapshotSet(keys),
            settled: [row.transfer_id + '|transfer']
        });
        let fetches = 0;
        ctx.fetchProof = async () => { fetches++; return null; };

        const result = await BS.applyBridgeTransfer(row, ctx);

        assert.strictEqual(result.applied, false);
        assert.strictEqual(result.reason, BS.SETTLE_REASON.ALREADY_APPLIED);
        assert.strictEqual(fetches, 0);
        assert.deepStrictEqual(state.actions, []);
    });
});
