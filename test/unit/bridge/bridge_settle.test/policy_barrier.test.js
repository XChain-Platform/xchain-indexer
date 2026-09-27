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
 * The in-leg policy barrier: after policy inheritance activates, a general-token
 * mint waits until this chain has materialized that tick's policy snapshot.
 *
 ********************************************************************/

'use strict';

const {
    BS, makeKey, DEST_ADDR, ESCROW_BTC_ON_DOGE, buildProof, makeTransfer,
    snapshotSet, makeCtx
} = require('./helpers/settle_fixtures.js');
const assert = require('assert');

describe('bridge_settle: the in-leg policy barrier', function(){
    it('refuses a general-token in-leg until its policy snapshot applies', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeTransfer(keys, { tick: 'PEPECASH', decimals: 2, amount: '5.00' });
        const { ctx, state } = makeCtx({
            coin: 'DOGE',
            validators: snapshotSet(keys),
            tokens: {
                'BTC.PEPECASH': { TICK_ID: 9, DECIMALS: 2, SUPPLY: '0' },
                'BTC': { TICK_ID: 8, DECIMALS: 0, SUPPLY: '0', OWNER: ESCROW_BTC_ON_DOGE }
            }
        });
        ctx.proof = buildProof('9.00', 'PEPECASH');

        let appliedPolicy = null;
        const policyReads = [];
        ctx.indexerDb.getAppliedPolicySnapshot = async (origin, tick) => {
            policyReads.push([origin, tick]);
            return appliedPolicy;
        };

        const refused = await BS.applyBridgeTransfer(row, ctx);
        assert.strictEqual(refused.applied, false);
        assert.strictEqual(refused.reason, BS.SETTLE_REASON.IN_LEG_NO_POLICY);
        assert.deepStrictEqual(policyReads, [['BTC', 'PEPECASH']]);
        assert.deepStrictEqual(state.injected, [], 'the barrier must run before bridged token effects');
        assert.deepStrictEqual(state.credits, []);
        assert.deepStrictEqual(state.actions, []);
        assert.deepStrictEqual(state.settlements, []);

        appliedPolicy = { policy_seq: 1, origin_block: 1100, policy_hash: 'b'.repeat(64) };
        const applied = await BS.applyBridgeTransfer(row, ctx);
        assert.strictEqual(applied.applied, true, applied.reason || '');
        assert.deepStrictEqual(policyReads, [['BTC', 'PEPECASH'], ['BTC', 'PEPECASH']]);
        assert.deepStrictEqual(state.credits, [['BTC.PEPECASH', '5.00', DEST_ADDR]]);
        assert.strictEqual(state.actions.length, 1);
        assert.strictEqual(state.actions[0].FORMAT, 5);
        assert.strictEqual(state.settlements.length, 1);
    });
});
