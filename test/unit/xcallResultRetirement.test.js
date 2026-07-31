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
 * test/unit/xcallResultRetirement.test.js
 *
 * : undeliverable XCALL result rows must age out.
 *
 * getEffectiveUnprocessedCallResults selects effective, finalized result rows in
 * (snapshot_block, call_id) order and the delivery pass takes only
 * XCALL_MAX_CALLS_PER_BLOCK of them, excluding whatever already has a
 * cross_chain_call_callbacks row. Before this change, three processResult exits
 * recorded nothing at all (no local request, routing mismatch, quorum not met), so
 * those rows were re-selected on every block forever: 25 of them at a low
 * snapshot_block hold the head of the queue permanently and starve every real
 * result behind them (measured on the  test-host venue at 229 rows).
 *
 * These tests pin the retirement rule and, just as importantly, everything it must
 * NOT retire: a row still inside its age-out window, a deferral waiting on the
 * capability snapshot, and any row at all while the flag-day is closed.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../fixtures/mocks');
const Xcall = require('../../src/actions/xcall.js');
const PROTO = require('../../src/protocol/constants.js');

const GRACE  = PROTO.XCALL_RESULT_ORPHAN_GRACE_SECONDS;
const CALLID = 'a'.repeat(64);

// A mirrored, finalized, already-effective result row for a BTC-originated call.
function resultRow(overrides) {
    return Object.assign({
        call_id:              CALLID,
        phase:                'result',
        status:               'finalized',
        network:              'regtest',
        source_chain:         'BTC',
        target_chain:         'DOGE',
        snapshot_block:       331,
        effective_time:       1000000,
        result_status:        'ok',
        return_payload_b64:   '',
        validator_signatures: '[]'
    }, overrides || {});
}

function requestRow(overrides) {
    return Object.assign({
        call_id:        CALLID,
        target_chain:   'DOGE',
        request_status: 'pending',
        deadline_block: 500,
        contract_index: 42,
        callback_method: 'onResult',
        callback_params_json: '[]',
        cross_hops:     1
    }, overrides || {});
}

// block data as utility.processCrossChainCalls builds it for the delivery pass
function blockData(blockIndex, blockTime) {
    return { BLOCK_INDEX: blockIndex, BLOCK_TIME: blockTime };
}

function makeXcall(opts) {
    opts = opts || {};
    const indexer = createMockIndexer();
    indexer.actionExecute = null;                       // no callback injection in these tests
    if (opts.gateOpen === false)
        indexer.protocolChanges.isEnabled = sinon.stub().resolves(false);

    indexer.indexerDb.getCrossChainCallRequestById = sinon.stub().resolves(opts.request || null);
    indexer.indexerDb.recordCrossChainCallCallback = sinon.stub().resolves();
    indexer.indexerDb.setCrossChainCallCallbackIndex = sinon.stub().resolves();
    indexer.indexerDb.updateCrossChainCallRequestStatus = sinon.stub().resolves();
    indexer.indexerDb.createActionIndex = sinon.stub().resolves(9001);

    const xcall = new Xcall(indexer);
    if (opts.quorum)
        sinon.stub(xcall, '_verifyResultQuorum').resolves(opts.quorum);
    return { xcall, indexer };
}

// the (action_index, call_id, result_status) a retirement/skip recorded, or null
function recorded(indexer) {
    const stub = indexer.indexerDb.recordCrossChainCallCallback;
    if (!stub.called) return null;
    const a = stub.firstCall.args;
    return { action_index: a[0], call_id: a[1], result_status: a[2], block_index: a[3] };
}

describe('XCALL undeliverable result retirement  @regression', function () {

    afterEach(() => sinon.restore());

    describe('no matching local request', function () {

        it('retires the row once the grace window past effective_time has elapsed', async function () {
            const { xcall, indexer } = makeXcall({ request: null });
            const r = resultRow();
            await xcall.processResult(r, blockData(900, r.effective_time + GRACE));

            const rec = recorded(indexer);
            assert.ok(rec, 'an aged-out orphan result must record a retirement row');
            assert.strictEqual(rec.result_status, 'retired:no_request');
            assert.strictEqual(rec.call_id, CALLID);
            assert.strictEqual(rec.block_index, 900);
            assert.strictEqual(rec.action_index, 9001, 'retirement must be anchored to a minted action_index');
            assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 1);
        });

        it('does NOT retire one second before the grace window closes', async function () {
            const { xcall, indexer } = makeXcall({ request: null });
            const r = resultRow();
            await xcall.processResult(r, blockData(900, r.effective_time + GRACE - 1));

            assert.strictEqual(recorded(indexer), null, 'still inside the window: nothing may be recorded');
            assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0,
                'no action_index may be minted for a row that stays in the queue');
        });

        it('never retires while the flag-day is closed, however old the row is', async function () {
            const { xcall, indexer } = makeXcall({ request: null, gateOpen: false });
            const r = resultRow();
            await xcall.processResult(r, blockData(900, r.effective_time + GRACE * 1000));

            assert.strictEqual(recorded(indexer), null,
                'pre-activation behaviour must be byte-identical to the old reject-every-block path');
            assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0);
        });

        it('retires each orphan independently, so a starved head-of-queue slice drains', async function () {
            const { xcall, indexer } = makeXcall({ request: null });
            const ids = ['b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)];
            for (const id of ids) {
                const r = resultRow({ call_id: id });
                await xcall.processResult(r, blockData(900, r.effective_time + GRACE));
            }
            const retired = indexer.indexerDb.recordCrossChainCallCallback.getCalls().map(c => c.args[1]);
            assert.deepStrictEqual(retired, ids,
                'every aged-out orphan in the slice retires, so the next block selects fresh rows');
        });

        it('a malformed effective_time never ages out (fail-safe: keep, do not retire)', async function () {
            const { xcall, indexer } = makeXcall({ request: null });
            await xcall.processResult(resultRow({ effective_time: null }), blockData(900, 9999999999));
            assert.strictEqual(recorded(indexer), null);
        });
    });

    describe('routing mismatch (request exists, target_chain differs)', function () {

        it('retires only past the request\'s own deadline_block', async function () {
            const req = requestRow({ target_chain: 'LTC', deadline_block: 500 });
            const { xcall, indexer } = makeXcall({ request: req });

            await xcall.processResult(resultRow(), blockData(500, 1000000));
            assert.strictEqual(recorded(indexer), null, 'at the deadline block the request is not yet past it');

            await xcall.processResult(resultRow(), blockData(501, 1000000));
            const rec = recorded(indexer);
            assert.ok(rec, 'past deadline_block the row can never deliver');
            assert.strictEqual(rec.result_status, 'retired:routing');
        });

        it('uses the deadline, NOT the effective_time grace, when a request exists', async function () {
            const req = requestRow({ target_chain: 'LTC', deadline_block: 500 });
            const { xcall, indexer } = makeXcall({ request: req });
            const r = resultRow();
            // far past the orphan grace window, but still inside the request's deadline
            await xcall.processResult(r, blockData(100, r.effective_time + GRACE * 10));
            assert.strictEqual(recorded(indexer), null,
                'a live request keeps its own exact clock; the orphan grace must not shorten it');
        });
    });

    describe('quorum verdicts', function () {

        it('retires a definitively unquorate row past the deadline', async function () {
            const { xcall, indexer } = makeXcall({
                request: requestRow({ deadline_block: 500 }),
                quorum:  { synced: true, quorumMet: false, N: 3, validSigners: [], weighted: false }
            });
            await xcall.processResult(resultRow(), blockData(501, 1000000));
            const rec = recorded(indexer);
            assert.ok(rec, 'a finalized-but-unverifiable row past the deadline must retire');
            assert.strictEqual(rec.result_status, 'retired:no_quorum');
        });

        it('does NOT retire an unquorate row before the deadline (the hub may still correct it)', async function () {
            const { xcall, indexer } = makeXcall({
                request: requestRow({ deadline_block: 500 }),
                quorum:  { synced: true, quorumMet: false, N: 3, validSigners: [], weighted: false }
            });
            await xcall.processResult(resultRow(), blockData(499, 1000000));
            assert.strictEqual(recorded(indexer), null);
        });

        it('NEVER retires a deferral waiting on the capability snapshot', async function () {
            const { xcall, indexer } = makeXcall({
                request: requestRow({ deadline_block: 500 }),
                quorum:  { synced: false, quorumMet: false, N: 0, validSigners: [] }
            });
            // far past both clocks: the row is still expected to deliver once the
            // snapshot is mirrored, and resultSuppressesExpiry keeps the request alive
            // for it, so retiring here would drop a deliverable result.
            await xcall.processResult(resultRow(), blockData(99999, 9999999999));
            assert.strictEqual(recorded(indexer), null);
            assert.strictEqual(indexer.indexerDb.createActionIndex.callCount, 0);
        });

        it('a network mismatch is still a plain no-op (never retired: not this chain\'s row)', async function () {
            const { xcall, indexer } = makeXcall({ request: null });
            await xcall.processResult(resultRow({ network: 'mainnet' }), blockData(900, 9999999999));
            assert.strictEqual(recorded(indexer), null);
            assert.strictEqual(indexer.indexerDb.getCrossChainCallRequestById.callCount, 0);
        });
    });

    describe('delivery is unaffected', function () {

        it('a quorate result for a pending request still completes and records its status', async function () {
            const { xcall, indexer } = makeXcall({
                request: requestRow({ request_status: 'pending', deadline_block: 500 }),
                quorum:  { synced: true, quorumMet: true, N: 3, validSigners: ['x', 'y'], weighted: false }
            });
            await xcall.processResult(resultRow({ result_status: 'ok' }), blockData(501, 1000000));

            const rec = recorded(indexer);
            assert.ok(rec, 'delivery records its own callback row');
            assert.strictEqual(rec.result_status, 'ok', 'a deliverable result must never be retired instead');
            assert.strictEqual(indexer.indexerDb.updateCrossChainCallRequestStatus.callCount, 1);
        });

        it('the already-terminal interlock still records skipped:<status>, not a retirement', async function () {
            const { xcall, indexer } = makeXcall({
                request: requestRow({ request_status: 'expired', deadline_block: 500 }),
                quorum:  { synced: true, quorumMet: true, N: 3, validSigners: ['x', 'y'], weighted: false }
            });
            await xcall.processResult(resultRow(), blockData(9999, 1000000));
            assert.strictEqual(recorded(indexer).result_status, 'skipped:expired');
        });
    });

    describe('the retirement status fits the schema', function () {
        it('every retired:<reason> value is within cross_chain_call_callbacks.result_status VARCHAR(20)', function () {
            for (const reason of ['no_request', 'routing', 'no_quorum'])
                assert.ok(('retired:' + reason).length <= 20, reason + ' overflows result_status');
        });
    });

    describe('flag-day registration', function () {
        it('XCALL_RESULT_ORPHAN_RETIREMENT is registered on the ratified anchor, genesis-active off mainnet', function () {
            const ProtocolChanges = require('../../src/protocol_changes.js');
            const pc = new ProtocolChanges(createMockIndexer(), '2.0.0');
            const change = pc.changes['XCALL_RESULT_ORPHAN_RETIREMENT'];
            assert.ok(change, 'the retirement gate must be registered');
            assert.strictEqual(change.mainnet_time, 1786924800, 'mainnet must ride the ratified 2026-08-17 anchor');
            assert.strictEqual(change.testnet_time, 0);
            assert.strictEqual(change.regtest_time, 0);
            assert.strictEqual(change.mainnet_block, 0);
        });
    });
});
