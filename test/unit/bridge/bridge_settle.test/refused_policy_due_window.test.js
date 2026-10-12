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
 * Terminal policy refusals become rollback-aware local records after the
 * refusal-record activation and leave the policy due window.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const createPass = require('../../../../src/consensus/bridge_settle/pass.js');

const TERMINAL_ID = 'a'.repeat(64);
const PENDING_ID  = 'b'.repeat(64);

function policyRows(){
    return [
        { snapshot_id: TERMINAL_ID, snapshot_block: 1, origin_chain: 'LTC', tick: 'T', policy_seq: 1 },
        { snapshot_id: PENDING_ID, snapshot_block: 1, origin_chain: 'LTC', tick: 'U', policy_seq: 1 }
    ];
}

function makeRun(network, refusedIds, results){
    const records = [];
    const actions = [];
    const db = {
        mirrorDb: () => ({
            getFinalizedPolicySnapshots: async () => policyRows(),
            getFinalizedBridgeTransfersForChain: async () => []
        }),
        getRecordedPolicySettlementIds: async () => [],
        getRecordedPolicyRefusalIds: async () => refusedIds.map(id => ({ transfer_id: id })),
        getRecordedTransferSettlementIds: async () => [],
        createActionIndex: async (data) => { actions.push(data); return 77; },
        recordBridgeSettlement: async (...args) => records.push(args)
    };
    const deps = {
        canonicals: { mirrorBindClause: () => ({ sql: '', args: [] }) },
        transfer: { applyBridgeTransfer: async () => ({ applied: false }) },
        policy: { applyPolicySnapshot: async row => results[row.snapshot_id] }
    };
    const ctx = { network, coin: 'BTC', blockIndex: 10, indexerDb: db, config: {} };
    return { pass: createPass(deps), ctx, records, actions };
}

describe('bridge_settle: terminal policy refusal records', function(){
    const results = {
        [TERMINAL_ID]: { applied: false, reason: 'quorum not met', terminal: true, actionIndexes: [] },
        [PENDING_ID]:  { applied: false, reason: 'seq pending', terminal: false, actionIndexes: [] }
    };

    it('records one terminal refusal and does not record a carried policy on regtest', async function(){
        const run = makeRun('regtest', [], results);
        await run.pass.processBridgeSettlePass(run.ctx);

        assert.strictEqual(run.records.length, 1);
        assert.deepStrictEqual(run.records[0].slice(0, 5), [77, TERMINAL_ID, 'refused', 10, 'LTC']);
        assert.deepStrictEqual(run.actions, [{ ACTION: 'XPOLICY', BLOCK_INDEX: 10, FORMAT: 0 }]);
    });

    it('reuses the last policy leg as the rollback anchor', async function(){
        const withLeg = Object.assign({}, results, {
            [TERMINAL_ID]: { applied: false, reason: 'leg refused', terminal: true, actionIndexes: [31, 32] }
        });
        const run = makeRun('regtest', [], withLeg);
        await run.pass.processBridgeSettlePass(run.ctx);

        assert.strictEqual(run.records[0][0], 32);
        assert.deepStrictEqual(run.actions, []);
    });

    it('removes a recorded refusal from the armed due window', async function(){
        const run = makeRun('regtest', [TERMINAL_ID], results);
        const due = await run.pass.duePolicySnapshots(run.ctx);
        assert.deepStrictEqual(due.map(row => row.snapshot_id), [PENDING_ID]);
    });

    it('keeps refusal records inert before activation', async function(){
        const run = makeRun('testnet', [TERMINAL_ID], results);
        const due = await run.pass.duePolicySnapshots(run.ctx);
        await run.pass.processBridgeSettlePass(run.ctx);

        assert.deepStrictEqual(due.map(row => row.snapshot_id), [TERMINAL_ID, PENDING_ID]);
        assert.deepStrictEqual(run.records, []);
        assert.deepStrictEqual(run.actions, []);
    });
});
