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
 * The settle seam decides "is this the gas tick" one way: case-folded, as the origin
 * resolver and the in-leg effects already do. Ticker lookups are LOWER(tick), so a signed
 * row can carry any casing of GAS, and it must route as the gas leg (v2) everywhere.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');
const { stubGate } = require('../../../helpers/gate_modules.js');
const {
    BS, makeKey, makeTransfer, snapshotSet, makeCtx, buildProof, DEST_ADDR
} = require('./helpers/settle_fixtures.js');

const TOKEN_POLICY_KEY = 'token_policy_activation.TOKEN_POLICY_INHERITANCE_ACTIVATION';

function gasInLeg(tick){
    const keys = [makeKey(), makeKey(), makeKey()];
    const row  = makeTransfer(keys, { tick: tick });
    const { ctx, state } = makeCtx({
        coin: 'DOGE',
        validators: snapshotSet(keys),
        tokens: { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } }
    });
    ctx.proof = buildProof('100.00000000', tick);
    const reads = [];
    ctx.indexerDb.getAppliedPolicySnapshot = async (origin, t) => { reads.push([origin, t]); return null; };
    return { row, ctx, state, reads };
}

describe('bridge_settle: the gas tick is recognised case-folded', function(){

    afterEach(function(){ sinon.restore(); });

    for(const tick of ['XCHAIN', 'xchain', 'XChain']){
        it('routes a ' + tick + ' in-leg as the gas leg (FORMAT 2) past the policy barrier', async function(){
            stubGate(sinon, TOKEN_POLICY_KEY, true);
            const { row, ctx, state, reads } = gasInLeg(tick);
            const res = await BS.applyBridgeTransfer(row, ctx);
            assert.strictEqual(res.applied, true, res.reason || '');
            assert.deepStrictEqual(reads, [], 'the gas leg never consults a token policy snapshot');
            assert.strictEqual(state.actions[0].FORMAT, 2);
            assert.deepStrictEqual(state.credits, [['XCHAIN', '10.00000000', DEST_ADDR]]);
        });
    }
});
