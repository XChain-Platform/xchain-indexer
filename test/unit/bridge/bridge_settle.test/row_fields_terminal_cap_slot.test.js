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
 * Malformed bridge rows stop occupying transfer cap slots only after the
 * row-fields terminal flag day.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const PC = require('../../../../src/consensus/bridge_proof_client.js');
const { stubGate } = require('../../../helpers/gate_modules.js');
const {
    BS, makeKey, buildProof, makeTransfer, snapshotSet, makeCtx, captureConsole
} = require('./helpers/settle_fixtures.js');

const ROW_FIELDS_TERMINAL_KEY =
    'bridge_row_fields_terminal_activation.BRIDGE_ROW_FIELDS_TERMINAL_ACTIVATION';

describe('bridge_settle: row-fields refusals and the per-block cap', function(){
    let realBuild;

    beforeEach(function(){
        realBuild = PC.buildEscrowProof;
        PC.buildEscrowProof = async () => buildProof('100.00000000');
    });

    afterEach(function(){
        PC.buildEscrowProof = realBuild;
        sinon.restore();
    });

    function runWithGate(active){
        stubGate(sinon, ROW_FIELDS_TERMINAL_KEY, active);
        const keys = [makeKey(), makeKey(), makeKey()];
        const rows = [];
        for(let i = 0; i < 25; i++){
            rows.push(makeTransfer(keys, {
                transfer_id: String(i).padStart(64, '0'),
                src_action_index: null
            }));
        }
        const good = makeTransfer(keys, {
            transfer_id: 'f'.repeat(64),
            src_action_index: 9000
        });
        const made = makeCtx({
            coin: 'DOGE', validators: snapshotSet(keys), mirrorTransfers: rows.concat([good]),
            tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } }
        });
        return { good, ctx: made.ctx, state: made.state };
    }

    it('settles the good row behind 25 malformed rows after activation', async function(){
        const { good, ctx, state } = runWithGate(true);
        let applied;
        await captureConsole(async () => { applied = await BS.processBridgeSettlePass(ctx); });

        assert.deepStrictEqual(applied.transfers, [good.transfer_id]);
        assert.strictEqual(state.credits.length, 1);
    });

    it('preserves the legacy cap behavior before activation', async function(){
        const { ctx, state } = runWithGate(false);
        let applied;
        await captureConsole(async () => { applied = await BS.processBridgeSettlePass(ctx); });

        assert.deepStrictEqual(applied.transfers, []);
        assert.strictEqual(state.credits.length, 0);
    });
});
