/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/cross_chain/pass_progress_retirement_pass.test.js
 *
 * PASS_PROGRESS_RETIREMENT_ACTIVATION, pass by pass, block by block.
 *
 * Thirty rows that can never apply sit ahead of ten valid rows in the order the
 * capped pass reads (snapshot_block), all selectable from block 1, and the real
 * per-block pass runs the real handler over them. Armed, every valid row lands
 * within the grace plus one block per 25 rows ahead and no unapplicable row moves value;
 * on an unarmed network the pass behaves as it always has, the valid rows held
 * out of the 25-row prefix for good.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../../fixtures/mocks');
const Cross_Settle   = require('../../../src/actions/cross_settle/index.js');
const quorum         = require('../../../src/actions/cross_settle/quorum.js');
const settleLeg      = require('../../../src/actions/cross_settle/settle_leg.js');
const Xexec          = require('../../../src/actions/xexec/index.js');
const dispatchQuorum = require('../../../src/actions/xexec/dispatch_quorum.js');
const runTarget      = require('../../../src/actions/xexec/run_target.js');

const GRACE  = 12;                                // BTC blocks
const BLOCKS = 40;
const T      = (h) => 1700000000 + h * 600;
const hex    = (p, i) => (p + String(i).padStart(4, '0')).padEnd(64, '0');

// The thirty unapplicable rows (keys 0..29) and ten valid rows (keys 30..39), selectable from block 1.
function layout(make) {
    const rows = [];
    for (let k = 0; k < 40; k++) rows.push(make(k, k >= 30));
    return rows;
}

// One node: a mock indexer whose mirror holds `rows`, whose idempotency table is `done`.
function node(network) {
    const indexer = createMockIndexer();
    const config  = Object.assign({}, indexer.config, { NETWORK: network });
    const db = indexer.indexerDb;
    indexer.decoderDb.protocolTimeForStoredBlock = sinon.stub().callsFake(async (h) => T(h));
    db.mirrorAdmissionActiveAt = sinon.stub().returns(false);
    db.admitColumn = sinon.stub().returns('admit_block_btc');
    let next = 1000;
    db.createActionIndex = sinon.stub().callsFake(async () => next++);
    db.recordCrossChainCallRejection = sinon.stub().resolves();
    const done = new Map();
    const ctx = { config, util: indexer.util, mapper: indexer.mapper, decoderDb: indexer.decoderDb, indexerDb: db };
    return { indexer, config, db, done, ctx };
}

// Drive BLOCKS blocks of `pass` and report when each valid row applied.
async function drive(n, rows, pass, cap) {
    const bindDb = { config: n.config };
    bindDb.getEffectiveUnsettledMatches = async (coin, time, limit) => rows.filter(r => r.effective_time <= time && !n.done.has(r.id)).slice(0, limit);
    bindDb.getEffectiveUndispatchedCalls = async (coin, network, time, limit) => rows.filter(r => r.effective_time <= time && !n.done.has(r.id)).slice(0, limit);
    bindDb.getEffectiveUnprocessedCallResults = async () => [];
    bindDb.getExpiredCrossChainCallRequests = async () => [];
    for (let h = 1; h <= BLOCKS; h++)
        await pass(bindDb, h);
    const valid = rows.filter(r => r.valid).map(r => n.done.get(r.id));
    const stuck = rows.filter(r => !r.valid).map(r => n.done.get(r.id));
    return { valid, stuck, cap };
}

async function settleRun(network) {
    const n = node(network);
    const rows = layout((k, valid) => ({ id: hex('m', k), match_id: hex('m', k), valid, snapshot_block: 100 + k, network,
        a_chain: 'BTC', a_action_index: 500 + k, a_kind: 'swap', b_chain: 'LTC', b_action_index: 900 + k, effective_time: T(1) }));
    sinon.stub(quorum, 'verifyMatchQuorum').callsFake(async (m) => m.valid);
    sinon.stub(settleLeg, 'settleSwapLeg').callsFake(async (data, m) => { n.done.set(m.match_id, { h: data['BLOCK_INDEX'], applied: true }); });
    n.db.getSwapInfo = sinon.stub().resolves({ SOURCE: 's', SWAP_STATUS: 'open' });
    n.db.recordCrossChainSettlementRetirement = sinon.stub().callsFake(async (ai, id, local, h) => { n.done.set(id, { h, applied: false }); });
    const handler = new Cross_Settle(n.ctx);
    const actions = { protocolChanges: { isEnabled: async () => true }, processAction: (name, p, data) => handler.parse(p, data, null) };
    return drive(n, rows, (db, h) => n.indexer.util.processCrossChainSettlements(actions, db, h, T(h)), 25);
}

async function xexecRun(network) {
    const n = node(network);
    const rows = layout((k, valid) => ({ id: hex('c', k), call_id: hex('c', k), valid, phase: 'dispatch', snapshot_block: 100 + k, network,
        source_chain: 'DOGE', target_chain: 'BTC', target_contract_index: 7, method: 'm', params_json: '[]', gas_limit: 1000,
        cross_hops: (valid || k % 2) ? 1 : 3, effective_time: T(1) }));
    sinon.stub(dispatchQuorum, 'verifyDispatchQuorum').callsFake(async (c) => ({ synced: true, quorumMet: c.valid, weighted: false, validSigners: [], N: 3 }));
    sinon.stub(runTarget, 'runTargetExecution').resolves({ resultStatus: 'ok', returnPayloadB64: '', gasUsed: 1 });
    n.db.recordCrossChainCallExecution = sinon.stub().callsFake(async (ai, id, e, status, p, g, h) => { n.done.set(id, { h, applied: status === 'ok' }); });
    n.db.recordCrossChainCallRetirement = sinon.stub().callsFake(async (ai, id, status, h) => { n.done.set(id, { h, applied: false, status }); });
    const handler = new Xexec(n.ctx);
    const actions = { actionXcall: {}, processAction: (name, p, data) => handler.parse(p, data, null) };
    return drive(n, rows, (db, h) => n.indexer.util.processCrossChainCalls(actions, db, h, T(h)), 25);
}

function assertArmed(r) {
    // Thirty unapplicable rows and ten valid rows from block 1: 25 retire at 1 + GRACE, the
    // last five with every valid row one block later.
    assert.ok(r.valid.every(v => v && v.applied), 'every valid row applies');
    assert.ok(r.valid.every(v => v.h <= 1 + GRACE + Math.ceil(40 / r.cap)), 'within the grace: ' + JSON.stringify(r.valid.map(v => v.h)));
    assert.ok(r.stuck.every(b => b && !b.applied), 'every unapplicable row is retired, none applies');
    assert.ok(r.stuck.every(b => b.h >= 1 + GRACE), 'no row retires inside its grace');
}

function assertUnarmed(r) {
    assert.ok(r.valid.every(v => v === undefined), 'unarmed, the valid rows stay out of the prefix as before');
    assert.ok(r.stuck.every(b => b === undefined), 'unarmed, nothing is retired');
}

// The regtest entry is UNPINNED; these suites arm it the way a venue does, through
// XC_PASS_PROGRESS_RETIREMENT_REGTEST_ACTIVATION (read at every registry read), and restore it after.
const ARM_ENV = 'XC_PASS_PROGRESS_RETIREMENT_REGTEST_ACTIVATION';
function useRegtestArming() {
    let saved;
    before(function () { saved = process.env[ARM_ENV]; process.env[ARM_ENV] = 'armed'; });
    after(function () { if (saved === undefined) delete process.env[ARM_ENV]; else process.env[ARM_ENV] = saved; });
}

describe('pass progress retirement: the CROSS_SETTLE pass @regression', function () {
    useRegtestArming();
    afterEach(() => sinon.restore());

    it('armed, settles every valid match behind 30 unapplicable ones within the grace', async function () {
        assertArmed(await settleRun('regtest'));
    });

    for (const network of ['mainnet', 'testnet']) {
        it('on ' + network + ', replays the pass unchanged', async function () {
            assertUnarmed(await settleRun(network));
        });
    }
});

describe('pass progress retirement: the XEXEC dispatch pass @regression', function () {
    useRegtestArming();
    afterEach(() => sinon.restore());

    it('armed, executes every valid dispatch behind 30 unapplicable ones within the grace', async function () {
        const r = await xexecRun('regtest');
        assertArmed(r);
    });

    for (const network of ['mainnet', 'testnet']) {
        it('on ' + network + ', replays the pass unchanged', async function () {
            assertUnarmed(await xexecRun(network));
        });
    }
});
