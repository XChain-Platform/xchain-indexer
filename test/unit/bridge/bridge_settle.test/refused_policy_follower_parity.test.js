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
 * A terminal-refused XPOLICY snapshot mints the same XPOLICY action index and
 * the same refused record on every follower, whatever node-local state differs.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const createPass = require('../../../../src/consensus/bridge_settle/pass.js');
const createPolicy = require('../../../../src/consensus/bridge_settle/policy.js');

const ROW_ID = 'c'.repeat(64);

function row(){
    return { snapshot_id: ROW_ID, snapshot_block: 1, origin_chain: 'LTC', tick: 'T', policy_seq: 1,
             network: 'mainnet-other', status: 'finalized', effective_time: 0 };
}

// One follower: same chain facts, different node-local inputs (config extras, wall clock,
// mirror row order, warn-once state, starting action counter).
function follower(local){
    const records = [];
    const actions = [];
    let next = 100;
    const db = {
        mirrorDb: () => ({
            getFinalizedPolicySnapshots: async () => local.rows(),
            getFinalizedBridgeTransfersForChain: async () => []
        }),
        getRecordedPolicySettlementIds: async () => [],
        getRecordedPolicyRefusalIds: async () => [],
        getRecordedTransferSettlementIds: async () => [],
        createActionIndex: async (data) => { actions.push(data); return next++; },
        recordBridgeSettlement: async (...args) => records.push(args)
    };
    const deps = {
        canonicals: { mirrorBindClause: () => ({ sql: '', args: [] }) },
        transfer: { applyBridgeTransfer: async () => ({ applied: false }) },
        policy: createPolicy({
            canonicals: {}, quorum: {},
            refusalLog: { warnOnce: () => { local.warned = true; } }
        })
    };
    const ctx = { network: 'regtest', coin: 'BTC', blockIndex: 10, blockTime: local.blockTime,
                  indexerDb: db, config: local.config };
    return { pass: createPass(deps), ctx, records, actions };
}

describe('bridge_settle: terminal policy refusal follower parity', function(){
    it('mints identical action index and refused record on every follower', async function(){
        const a = follower({ rows: () => [row()], blockTime: 1000, config: {} });
        const b = follower({ rows: () => [Object.assign({}, row())], blockTime: 99999999,
                             config: { SOME_LOCAL_ONLY: 'x', ADDRESS: {} } });
        await a.pass.processBridgeSettlePass(a.ctx);
        await b.pass.processBridgeSettlePass(b.ctx);

        assert.strictEqual(a.records.length, 1);
        assert.deepStrictEqual(a.actions, [{ ACTION: 'XPOLICY', BLOCK_INDEX: 10, FORMAT: 0 }]);
        assert.deepStrictEqual(b.actions, a.actions);
        assert.deepStrictEqual(b.records, a.records);
        assert.deepStrictEqual(a.records[0].slice(0, 5), [100, ROW_ID, 'refused', 10, 'LTC']);
    });
});
