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
 * A due transfer refused for a terminal reason writes no settlement record, so it must not
 * hold one of the per-block cap slots: a full cap of them would otherwise stop every settle
 * to the chain.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const PC = require('../../../../src/consensus/bridge_proof_client.js');
const { XBRIDGE_MAX_PER_BLOCK } = require('../../../../src/protocol/constants.js');
const {
    BS, makeKey, buildProof, makeTransfer, snapshotSet, makeCtx, captureConsole
} = require('./helpers/settle_fixtures.js');

describe('bridge_settle: refused transfers and the per-block cap', function(){
    let realBuild;
    beforeEach(function(){
        realBuild = PC.buildEscrowProof;
        PC.buildEscrowProof = async () => buildProof('100.00000000');
    });
    afterEach(function(){ PC.buildEscrowProof = realBuild; });

    function refusedRows(keys, count){
        const rows = [];
        for(let i = 0; i < count; i++)
            rows.push(makeTransfer([keys[0]], { transfer_id: String(i).padStart(64, '0'), src_action_index: 100 + i }));
        return rows;
    }

    it('settles a good row that sorts behind a full cap of quorum refusals', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const good = makeTransfer(keys, { transfer_id: 'f'.repeat(64), src_action_index: 9000 });
        const rows = refusedRows(keys, XBRIDGE_MAX_PER_BLOCK).concat([good]);
        const { ctx, state } = makeCtx({
            coin: 'DOGE', validators: snapshotSet(keys), mirrorTransfers: rows,
            tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } }
        });

        let applied;
        await captureConsole(async () => { applied = await BS.processBridgeSettlePass(ctx); });

        assert.deepStrictEqual(applied.transfers, [good.transfer_id]);
        assert.strictEqual(state.credits.length, 1);
    });

    it('still caps the rows that apply at XBRIDGE_MAX_PER_BLOCK', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const rows = [];
        for(let i = 0; i < XBRIDGE_MAX_PER_BLOCK + 3; i++)
            rows.push(makeTransfer(keys, { transfer_id: String(i).padStart(64, '0'), src_action_index: 100 + i }));
        const { ctx } = makeCtx({
            coin: 'DOGE', validators: snapshotSet(keys), mirrorTransfers: rows,
            tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } }
        });

        let applied;
        await captureConsole(async () => { applied = await BS.processBridgeSettlePass(ctx); });

        assert.strictEqual(applied.transfers.length, XBRIDGE_MAX_PER_BLOCK);
    });
});
