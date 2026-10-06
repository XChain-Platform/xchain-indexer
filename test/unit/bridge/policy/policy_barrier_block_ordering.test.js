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
 * Policy snapshot visibility at the block where a bridge in-leg applies.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const bridgesMixin = require('../../../../src/db/bridges');
const {
    BS, makeKey, buildProof, makeTransfer, snapshotSet, makeCtx, ESCROW_BTC_ON_DOGE
} = require('../bridge_settle.test/helpers/settle_fixtures.js');

describe('bridge policy barrier block ordering @regression @tier1', function(){
    it('does not expose a policy settlement from a later block to an earlier in-leg', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeTransfer(keys, { tick: 'PEPECASH', decimals: 2, amount: '5.00' });
        const policyId = 'b'.repeat(64);
        const policyBlock = 18203;
        const { ctx, state } = makeCtx({
            coin: 'DOGE',
            validators: snapshotSet(keys),
            tokens: {
                'BTC.PEPECASH': { TICK_ID: 9, DECIMALS: 2, SUPPLY: '0' },
                'BTC': { TICK_ID: 8, DECIMALS: 0, SUPPLY: '0', OWNER: ESCROW_BTC_ON_DOGE }
            },
            mirrorPolicies: [{ policy_seq: 1, origin_block: 18000, policy_hash: 'c'.repeat(64) }]
        });
        ctx.blockIndex = 18197;
        ctx.proof = buildProof('9.00', 'PEPECASH');

        const policyQueries = [];
        const ledgerQuery = ctx.indexerDb.doQuery;
        ctx.indexerDb.doQuery = async (sql, args) => {
            if(/FROM bridge_settlements bs/.test(sql) && /bs\.kind='policy'/.test(sql)){
                policyQueries.push({ sql, args });
                const bounded = /bs\.block_index <= \?/.test(sql);
                return (!bounded || policyBlock <= Number(args[args.length - 1]))
                    ? [{ transfer_id: policyId }] : [];
            }
            return await ledgerQuery(sql, args);
        };
        ctx.indexerDb.getAppliedPolicySnapshot =
            bridgesMixin.getAppliedPolicySnapshot.bind(ctx.indexerDb);

        const result = await BS.applyBridgeTransfer(row, ctx);
        assert.strictEqual(result.applied, false);
        assert.strictEqual(result.reason, BS.SETTLE_REASON.IN_LEG_NO_POLICY);
        assert.strictEqual(policyQueries.length, 1);
        assert.match(policyQueries[0].sql, /AND bs\.block_index <= \?/);
        assert.deepStrictEqual(policyQueries[0].args, ['PEPECASH', 18197]);
        assert.deepStrictEqual(state.credits, []);
        assert.deepStrictEqual(state.actions, []);
        assert.deepStrictEqual(state.settlements, []);
    });

    it('keeps the two-argument lookup unbounded', async function(){
        const localQueries = [];
        const db = {
            config: { NETWORK: 'regtest' },
            doQuery: async (sql, args) => {
                localQueries.push({ sql, args });
                return [{ transfer_id: 'd'.repeat(64) }];
            },
            mirrorDb: () => ({
                doQueryStrict: async () => [{ policy_seq: 2, origin_block: 18203, policy_hash: 'e'.repeat(64) }]
            })
        };

        const result = await bridgesMixin.getAppliedPolicySnapshot.call(db, 'BTC', 'PEPECASH');
        assert.strictEqual(result.policy_seq, 2);
        assert.doesNotMatch(localQueries[0].sql, /bs\.block_index <= \?/);
        assert.deepStrictEqual(localQueries[0].args, ['PEPECASH']);
    });

    it('includes a policy settlement from the block being checked', async function(){
        const localQueries = [];
        const db = {
            config: { NETWORK: 'regtest' },
            doQuery: async (sql, args) => {
                localQueries.push({ sql, args });
                return [{ transfer_id: 'f'.repeat(64) }];
            },
            mirrorDb: () => ({
                doQueryStrict: async () => [{ policy_seq: 3, origin_block: 18203, policy_hash: '1'.repeat(64) }]
            })
        };

        const result = await bridgesMixin.getAppliedPolicySnapshot.call(db, 'BTC', 'PEPECASH', 18203);
        assert.strictEqual(result.policy_seq, 3);
        assert.match(localQueries[0].sql, /AND bs\.block_index <= \?/);
        assert.deepStrictEqual(localQueries[0].args, ['PEPECASH', 18203]);
    });
});
