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
 * test/unit/cross_chain/pass_progress_retirement.test.js
 *
 * PASS_PROGRESS_RETIREMENT_ACTIVATION, handler by handler.
 *
 * The capped CROSS_SETTLE and XEXEC passes exclude only rows with an idempotency
 * record, and the exits that cannot apply a row wrote none, so such rows held
 * their slots on every block. From the activation each of those exits retires
 * the row once it has been selectable for the grace, recording a row that moves
 * no value; the XCALL result pass ages an orphan admitted by height by that
 * height. These cases pin which exits retire, when, what the record is, and
 * everything that must not change: a row inside its grace, a deferral on a
 * snapshot not yet mirrored, and every row on an unarmed network.
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
const Xcall          = require('../../../src/actions/xcall/index.js');
const gateRegistry   = require('../../../src/consensus/gate_registry');
const { buildCrossChainCallsRpc } = require('../../../src/api/rpc/cross_chain_calls.js');

const KEY   = 'pass_progress_retirement_activation.PASS_PROGRESS_RETIREMENT_ACTIVATION';
const GRACE = 12;                                 // BTC blocks
const T     = (h) => 1700000000 + h * 600;        // the decoder clock these cases stand on
const BLOCK = 300;

// A handler context on a copy of the test config, so a case may read another network
// without touching the config object every other suite shares.
function context(network) {
    const indexer = createMockIndexer();
    const config  = Object.assign({}, indexer.config, { NETWORK: network || 'regtest' });
    indexer.decoderDb.protocolTimeForStoredBlock = sinon.stub().callsFake(async (h) => T(h));
    indexer.indexerDb.mirrorAdmissionActiveAt = sinon.stub().returns(false);
    indexer.indexerDb.admitColumn = sinon.stub().returns('admit_block_btc');
    indexer.indexerDb.createActionIndex = sinon.stub().resolves(9001);
    indexer.indexerDb.recordCrossChainSettlementRetirement = sinon.stub().resolves();
    indexer.indexerDb.recordCrossChainSettlement = sinon.stub().resolves();
    indexer.indexerDb.recordCrossChainCallRetirement = sinon.stub().resolves();
    indexer.indexerDb.recordCrossChainCallRejection = sinon.stub().resolves();
    indexer.indexerDb.recordCrossChainCallExecution = sinon.stub().resolves();
    indexer.indexerDb.isActionIndexParsed = sinon.stub().resolves(false);
    indexer.indexerDb.getSwapInfo = sinon.stub().resolves({ SOURCE: 'src', SWAP_STATUS: 'open' });
    return { indexer, ctx: { config, util: indexer.util, mapper: indexer.mapper, decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb } };
}

function match(network, overrides) {
    return Object.assign({
        match_id: 'm'.repeat(64), snapshot_block: 150, network: network || 'regtest',
        a_chain: 'BTC', a_action_index: 42, a_kind: 'swap', a_tick: 'AAA', a_amount: '10', a_ownership: 0, a_payout_addr: 'pa',
        b_chain: 'LTC', b_action_index: 99, b_kind: 'swap', b_tick: 'BBB', b_amount: '5', b_ownership: 0, b_payout_addr: 'pb',
        effective_time: T(BLOCK - GRACE), admit_block_btc: null, validator_signatures: '[]'
    }, overrides || {});
}

function dispatch(network, overrides) {
    return Object.assign({
        call_id: 'c'.repeat(64), phase: 'dispatch', snapshot_block: 150, network: network || 'regtest',
        source_chain: 'DOGE', source_action_index: 41, source_contract_index: 5, target_chain: 'BTC',
        target_contract_index: 99, method: 'onArrival', params_json: '[]', gas_limit: 50000, cross_hops: 1,
        effective_time: T(BLOCK - GRACE), status: 'finalized', validator_signatures: '[]'
    }, overrides || {});
}

const blockData = (extra) => Object.assign({ BLOCK_INDEX: BLOCK, BLOCK_TIME: T(BLOCK) }, extra);

// A quorum verdict for the CROSS_SETTLE handler: short, or deferred on an absent snapshot.
function stubMatchQuorum(verdict) {
    return sinon.stub(quorum, 'verifyMatchQuorum').callsFake(async (m, out) => {
        if (verdict === 'absent' && out) out.snapshotAbsent = true;
        return verdict === 'met';
    });
}

// The regtest entry is UNPINNED; these suites arm it the way a venue does, through
// XC_PASS_PROGRESS_RETIREMENT_REGTEST_ACTIVATION (read at every registry read), and restore it after.
const ARM_ENV = 'XC_PASS_PROGRESS_RETIREMENT_REGTEST_ACTIVATION';
function useRegtestArming() {
    let saved;
    before(function () { saved = process.env[ARM_ENV]; process.env[ARM_ENV] = 'armed'; });
    after(function () { if (saved === undefined) delete process.env[ARM_ENV]; else process.env[ARM_ENV] = saved; });
}

describe('pass progress retirement: the activation row @regression', function () {
    useRegtestArming();
    it('is a height row, unarmed on mainnet and testnet, inert on regtest unless the venue arms it', function () {
        assert.strictEqual(gateRegistry.registry.unitOf(KEY), 'height');
        delete process.env[ARM_ENV];
        for (const coin of ['BTC', 'LTC', 'DOGE'])
            assert.strictEqual(gateRegistry.activeAt(KEY, 'regtest', coin, 10000000, null), false, coin + ' regtest unset');
        process.env[ARM_ENV] = 'armed';
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(gateRegistry.activeAt(KEY, 'mainnet', coin, 10000000, null), false, coin + ' mainnet');
            assert.strictEqual(gateRegistry.activeAt(KEY, 'testnet', coin, 10000000, null), false, coin + ' testnet');
            assert.strictEqual(gateRegistry.activeAt(KEY, 'regtest', coin, 0, null), true, coin + ' regtest');
        }
    });
});

describe('pass progress retirement: CROSS_SETTLE exits @regression', function () {
    useRegtestArming();
    afterEach(() => sinon.restore());

    it('retires a short-quorum match whose snapshot is present once it has been selectable for the grace', async function () {
        const { indexer, ctx } = context();
        stubMatchQuorum('short');
        const release = sinon.stub(settleLeg, 'settleSwapLeg').resolves();
        const data = blockData({ MATCH: match() });
        await new Cross_Settle(ctx).parse(null, data, null);

        const rec = indexer.indexerDb.recordCrossChainSettlementRetirement;
        assert.strictEqual(rec.callCount, 1, 'an aged short-quorum match records a retirement');
        assert.deepStrictEqual(rec.firstCall.args, [9001, 'm'.repeat(64), 42, BLOCK]);
        assert.strictEqual(data['STATUS'], 'retired:no_quorum');
        assert.strictEqual(release.callCount, 0, 'a retirement releases no escrow');
        assert.strictEqual(indexer.indexerDb.recordCrossChainSettlement.callCount, 0);
    });

    it('keeps a short-quorum match one block inside the grace', async function () {
        const { indexer, ctx } = context();
        stubMatchQuorum('short');
        await new Cross_Settle(ctx).parse(null, blockData({ MATCH: match(null, { effective_time: T(BLOCK - GRACE) + 1 }) }), null);
        assert.strictEqual(indexer.indexerDb.recordCrossChainSettlementRetirement.callCount, 0);
        assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0, 'no index is minted for a match that stays queued');
    });

    it('never retires a match deferred on a capability snapshot that is not mirrored yet', async function () {
        const { indexer, ctx } = context();
        stubMatchQuorum('absent');
        await new Cross_Settle(ctx).parse(null, blockData({ MATCH: match(null, { effective_time: T(1) }) }), null);
        assert.strictEqual(indexer.indexerDb.recordCrossChainSettlementRetirement.callCount, 0);
    });

    it('retires a dismissed leg (indexed, not an offer) without reading a signature', async function () {
        const { indexer, ctx } = context();
        const q = stubMatchQuorum('met');
        indexer.indexerDb.getSwapInfo.resolves(null);
        indexer.indexerDb.isActionIndexParsed.resolves(true);
        const data = blockData({ MATCH: match() });
        await new Cross_Settle(ctx).parse(null, data, null);
        assert.strictEqual(indexer.indexerDb.recordCrossChainSettlementRetirement.callCount, 1);
        assert.strictEqual(data['STATUS'], 'retired:dismissed');
        assert.strictEqual(q.callCount, 0);
    });

    it('retires a quorate match whose local leg is not there', async function () {
        const { indexer, ctx } = context();
        stubMatchQuorum('met');
        indexer.indexerDb.getSwapInfo.resolves(null);
        const release = sinon.stub(settleLeg, 'settleSwapLeg').resolves();
        const data = blockData({ MATCH: match() });
        await new Cross_Settle(ctx).parse(null, data, null);
        assert.strictEqual(data['STATUS'], 'retired:no_leg');
        assert.strictEqual(release.callCount, 0);
    });

});

describe('pass progress retirement: CROSS_SETTLE clocks and networks @regression', function () {
    useRegtestArming();
    afterEach(() => sinon.restore());

    it('still settles a quorate match with an open leg, however old', async function () {
        const { indexer, ctx } = context();
        stubMatchQuorum('met');
        const release = sinon.stub(settleLeg, 'settleSwapLeg').resolves();
        await new Cross_Settle(ctx).parse(null, blockData({ MATCH: match(null, { effective_time: T(1) }) }), null);
        assert.strictEqual(release.callCount, 1);
        assert.strictEqual(indexer.indexerDb.recordCrossChainSettlementRetirement.callCount, 0);
    });

    it('ages a match the admission era admits by its admit_block, not by its effective_time', async function () {
        const { indexer, ctx } = context();
        stubMatchQuorum('short');
        indexer.indexerDb.mirrorAdmissionActiveAt.returns(true);
        const far = { effective_time: 4102444800 };
        await new Cross_Settle(ctx).parse(null, blockData({ MATCH: match(null, Object.assign({ admit_block_btc: BLOCK - GRACE + 1 }, far)) }), null);
        assert.strictEqual(indexer.indexerDb.recordCrossChainSettlementRetirement.callCount, 0, 'one block inside the grace');
        await new Cross_Settle(ctx).parse(null, blockData({ MATCH: match(null, Object.assign({ admit_block_btc: BLOCK - GRACE }, far)) }), null);
        assert.strictEqual(indexer.indexerDb.recordCrossChainSettlementRetirement.callCount, 1, 'at the grace');
    });

    for (const network of ['mainnet', 'testnet']) {
        it('retires nothing on ' + network + ', however old the match', async function () {
            const { indexer, ctx } = context(network);
            stubMatchQuorum('short');
            await new Cross_Settle(ctx).parse(null, blockData({ MATCH: match(network, { effective_time: T(1) }) }), null);
            assert.strictEqual(indexer.indexerDb.recordCrossChainSettlementRetirement.callCount, 0);
            assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0);
        });
    }
});

function stubDispatchQuorum(met, synced) {
    return sinon.stub(dispatchQuorum, 'verifyDispatchQuorum').resolves({
    synced: synced !== false, quorumMet: met, weighted: false, validSigners: [], N: 3 });
}

describe('pass progress retirement: XEXEC dispatch exits @regression', function () {
    useRegtestArming();
    afterEach(() => sinon.restore());

    it('retires a short-quorum dispatch past the grace instead of recording another refusal', async function () {
        const { indexer, ctx } = context();
        stubDispatchQuorum(false);
        const data = blockData({ CALL: dispatch() });
        await new Xexec(ctx).parse(null, data, null);
        const rec = indexer.indexerDb.recordCrossChainCallRetirement;
        assert.strictEqual(rec.callCount, 1);
        assert.deepStrictEqual(rec.firstCall.args, [9001, 'c'.repeat(64), 'retired:no_quorum', BLOCK]);
        assert.strictEqual(indexer.indexerDb.recordCrossChainCallExecution.callCount, 0, 'nothing runs');
        assert.strictEqual(indexer.indexerDb.recordCrossChainCallRejection.callCount, 0);
    });

    it('keeps refusing a short-quorum dispatch inside the grace', async function () {
        const { indexer, ctx } = context();
        stubDispatchQuorum(false);
        await new Xexec(ctx).parse(null, blockData({ CALL: dispatch(null, { effective_time: T(BLOCK - GRACE) + 1 }) }), null);
        assert.strictEqual(indexer.indexerDb.recordCrossChainCallRetirement.callCount, 0);
        assert.strictEqual(indexer.indexerDb.recordCrossChainCallRejection.callCount, 1);
    });

    it('never retires a dispatch deferred on a snapshot not yet mirrored', async function () {
        const { indexer, ctx } = context();
        stubDispatchQuorum(false, false);
        await new Xexec(ctx).parse(null, blockData({ CALL: dispatch(null, { effective_time: T(1) }) }), null);
        assert.strictEqual(indexer.indexerDb.recordCrossChainCallRetirement.callCount, 0);
    });

    it('retires a dispatch over the hop ceiling past the grace, before any signature is read', async function () {
        const { indexer, ctx } = context();
        const q = stubDispatchQuorum(true);
        const data = blockData({ CALL: dispatch(null, { cross_hops: 3 }) });
        await new Xexec(ctx).parse(null, data, null);
        assert.strictEqual(indexer.indexerDb.recordCrossChainCallRetirement.firstCall.args[2], 'retired:cross_hops');
        assert.strictEqual(q.callCount, 0);
    });

    it('retires nothing for another network or another target chain', async function () {
        const { indexer, ctx } = context();
        stubDispatchQuorum(false);
        await new Xexec(ctx).parse(null, blockData({ CALL: dispatch(null, { network: 'mainnet', cross_hops: 3 }) }), null);
        await new Xexec(ctx).parse(null, blockData({ CALL: dispatch(null, { target_chain: 'LTC', cross_hops: 3 }) }), null);
        assert.strictEqual(indexer.indexerDb.recordCrossChainCallRetirement.callCount, 0);
    });

});

describe('pass progress retirement: XEXEC dispatch on unarmed networks @regression', function () {
    useRegtestArming();
    afterEach(() => sinon.restore());

    for (const network of ['mainnet', 'testnet']) {
        it('retires nothing on ' + network + ', however old the dispatch', async function () {
            const { indexer, ctx } = context(network);
            stubDispatchQuorum(false);
            await new Xexec(ctx).parse(null, blockData({ CALL: dispatch(network, { effective_time: T(1) }) }), null);
            await new Xexec(ctx).parse(null, blockData({ CALL: dispatch(network, { effective_time: T(1), cross_hops: 3 }) }), null);
            assert.strictEqual(indexer.indexerDb.recordCrossChainCallRetirement.callCount, 0);
            assert.strictEqual(indexer.indexerDb.recordCrossChainCallRejection.callCount, 1);
        });
    }
});

describe('pass progress retirement: XCALL result orphan in the admission era @regression', function () {
    useRegtestArming();
    afterEach(() => sinon.restore());

    function orphan(admit) {
        return { call_id: 'a'.repeat(64), phase: 'result', status: 'finalized', network: 'regtest', source_chain: 'BTC',
            target_chain: 'DOGE', snapshot_block: 150, effective_time: 4102444800, admit_block_btc: admit,
            result_status: 'ok', return_payload_b64: '', validator_signatures: '[]' };
    }
    function xcall() {
        const { indexer, ctx } = context();
        indexer.indexerDb.mirrorAdmissionActiveAt.returns(true);
        indexer.indexerDb.getCrossChainCallRequestById = sinon.stub().resolves(null);
        indexer.indexerDb.recordCrossChainCallCallback = sinon.stub().resolves();
        indexer.actionExecute = null;
        return { indexer, handler: new Xcall(Object.assign({}, indexer, ctx)) };
    }

    it('retires an orphan with a far-future effective_time once its admit_block is a grace behind', async function () {
        const { indexer, handler } = xcall();
        await handler.processResult(orphan(BLOCK - GRACE), blockData());
        const rec = indexer.indexerDb.recordCrossChainCallCallback;
        assert.strictEqual(rec.callCount, 1, 'the admitted orphan ages by height');
        assert.strictEqual(rec.firstCall.args[2], 'retired:no_request');
    });

    it('keeps it one block inside the grace', async function () {
        const { indexer, handler } = xcall();
        await handler.processResult(orphan(BLOCK - GRACE + 1), blockData());
        assert.strictEqual(indexer.indexerDb.recordCrossChainCallCallback.callCount, 0);
    });
});

describe('pass progress retirement: getcrosschaincallresult @regression', function () {
    useRegtestArming();
    function rpc(row) {
        const db = { getLatestBlockIndex: async () => 400, getCrossChainCallExecutionById: async () => row,
            getCrossChainCallRejectionById: async () => null };
        db.apiView = () => db;
        return buildCrossChainCallsRpc({ indexer: { indexerDb: db, config: { NETWORK: 'regtest' } } });
    }

    it('reports a retired dispatch as not executed, so no result is relayed for it', async function () {
        const res = await rpc({ call_id: 'c'.repeat(64), result_status: 'retired:no_quorum', block_index: 300 })
            .getcrosschaincallresult({ call_id: 'c'.repeat(64) });
        assert.strictEqual(res.exists, false);
        assert.deepStrictEqual(res.retired, { reason: 'no_quorum', block_index: 300 });
    });

    it('reports an executed call exactly as before', async function () {
        const res = await rpc({ call_id: 'c'.repeat(64), result_status: 'ok', block_index: 300, return_payload_b64: 'eA==', gas_used: 7 })
            .getcrosschaincallresult({ call_id: 'c'.repeat(64) });
        assert.deepStrictEqual(res, { exists: true, network: 'regtest', latest_block_index: 400, executed_block_index: 300,
            status: 'ok', return_payload_b64: 'eA==', gas_used: 7 });
    });
});
