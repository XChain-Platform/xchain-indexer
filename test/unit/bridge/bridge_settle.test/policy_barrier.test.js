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
    BS, makeKey, sign, NETWORK, SNAPSHOT, DEST_ADDR, ESCROW_BTC_ON_DOGE,
    buildProof, makeTransfer, snapshotSet, makeCtx, captureConsole
} = require('./helpers/settle_fixtures.js');
const assert = require('assert');

function makePolicySnapshot(keys, tick){
    const row = {
        snapshot_id:     'd'.repeat(64),
        snapshot_block:  SNAPSHOT,
        origin_chain:    'BTC',
        tick:            tick,
        policy_seq:      1,
        origin_block:    1100,
        policy_hash:     BS.policyHash(null, null, false),
        allow_list:      null,
        block_list:      null,
        sleeping:        0,
        effective_time:  1000,
        network:         NETWORK,
        finalizing_view: 0,
        status:          'finalized',
        push_generation: 0,
        btc_chain_id:    null
    };
    row.validator_signatures = JSON.stringify(
        keys.map(k => ({ pubkey: k.pubkey, sig: sign(k.privateKey, BS.policyCanonical(row)) })));
    return row;
}

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

    it('applies policy then transfer with no seeded copy', async function(){
        const keys = [makeKey(), makeKey(), makeKey()];
        const tokens = {};
        const row = makeTransfer(keys, {
            tick: 'PEPECASH', decimals: 4, amount: '5.0000', transfer_id: 'c'.repeat(64)
        });
        const policy = makePolicySnapshot(keys, row.tick);
        const { ctx, state } = makeCtx({
            coin: 'DOGE', validators: snapshotSet(keys), tokens: tokens, mirrorTransfers: [row]
        });
        ctx.proof = buildProof('9.0000', row.tick);

        const processTransaction = ctx.actions.processTransaction;
        ctx.actions.processTransaction = async (tx, isGenesis) => {
            const result = await processTransaction(tx, isGenesis);
            const fields = String(tx.data || '').split('|');
            if(fields[0] === 'ISSUE' && fields[1] === '0'){
                tokens[fields[2]] = {
                    TICK_ID: Object.keys(tokens).length + 1,
                    DECIMALS: Number(fields[5]),
                    SUPPLY: '0',
                    OWNER: tx.source,
                    ALLOW_LIST: null,
                    BLOCK_LIST: null
                };
            }
            return result;
        };
        ctx.indexerDb.getAppliedPolicySnapshot = async () =>
            state.settled.has(policy.snapshot_id + '|policy')
                ? { policy_seq: 1, origin_block: policy.origin_block, policy_hash: policy.policy_hash }
                : null;

        assert.strictEqual(await ctx.indexerDb.getTokenInfo('BTC.PEPECASH'), null);
        const appliedPolicy = await BS.applyPolicySnapshot(policy, ctx);
        assert.strictEqual(appliedPolicy.applied, true, appliedPolicy.reason || '');
        assert.strictEqual((await ctx.indexerDb.getTokenInfo('BTC.PEPECASH')).DECIMALS, row.decimals);

        const appliedTransfer = await BS.applyBridgeTransfer(row, ctx);
        assert.strictEqual(appliedTransfer.applied, true, appliedTransfer.reason || '');
        assert.deepStrictEqual(state.credits, [['BTC.PEPECASH', '5.0000', DEST_ADDR]]);
        assert.strictEqual(state.settlements.length, 2);
    });

    it('logs each policy barrier once per transfer or tick', async function(){
        BS.resetRefusalMemo();
        const keys = [makeKey(), makeKey(), makeKey()];
        const row = makeTransfer(keys, {
            tick: 'BARRIER', decimals: 2, amount: '5.00', transfer_id: 'e'.repeat(64)
        });
        const transferCtx = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys) }).ctx;
        transferCtx.proof = buildProof('9.00', row.tick);
        transferCtx.indexerDb.getAppliedPolicySnapshot = async () => null;

        const policy = makePolicySnapshot(keys, row.tick);
        const policyCtx = makeCtx({ coin: 'DOGE', validators: snapshotSet(keys), tokens: {} }).ctx;
        const lines = await captureConsole(async () => {
            for(let i = 0; i < 2; i++){
                assert.strictEqual((await BS.applyBridgeTransfer(row, transferCtx)).reason,
                    BS.SETTLE_REASON.IN_LEG_NO_POLICY);
                assert.strictEqual((await BS.applyPolicySnapshot(policy, policyCtx)).reason,
                    BS.SETTLE_REASON.POLICY_NO_COPY);
            }
        });

        assert.strictEqual(lines.filter(line => line.includes(BS.SETTLE_REASON.IN_LEG_NO_POLICY)).length, 1);
        assert.strictEqual(lines.filter(line => line.includes(BS.SETTLE_REASON.POLICY_NO_COPY)).length, 1);
    });
});
