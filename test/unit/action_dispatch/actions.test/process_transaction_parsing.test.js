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
 * Actions.processTransaction() past routing: legacy-format version insertion,
 * unknown and not-yet-enabled actions, the data object handed to the handler, and
 * the address, transaction and index rows written before it runs. Part of the suite
 * whose entry is test/unit/actions.test.js; handler parse() methods and every DB
 * call are stubbed, so no real action logic or database runs.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert  = require('assert');
const sinon   = require('sinon');

// The stubbed-Actions builder and the transaction fixture shared with the suite entry.
const { makeTx, shutdownPendingVms, buildActions } = require('./helpers/build_actions.js');

describe('Actions.processTransaction() @regression @tier3', function () {
    afterEach(async function () {
        sinon.restore();
        await shutdownPendingVms();
    });

    it('resolves DROP alias to AIRDROP', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'DROP|0|TEST|10' }));
        assert.ok(stubs.actionAirdrop.calledOnce, 'DROP should route to actionAirdrop.parse');
    });

    it('resolves CAST alias to BROADCAST', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'CAST|0|hello' }));
        assert.ok(stubs.actionBroadcast.calledOnce, 'CAST should route to actionBroadcast.parse');
    });

    it('resolves MSG alias to MESSAGE', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'MSG|0|1|key|cipher' }));
        assert.ok(stubs.actionMessage.calledOnce, 'MSG should route to actionMessage.parse');
    });

    // ── Legacy format detection ───────────────────────────────────────────

    it('inserts version 0 for legacy ISSUE format where TICK is first param', async function () {
        const { actions, stubs } = buildActions();
        // Legacy: no version, TICK comes first : e.g. "ISSUE|TEST|1000|100|8"
        const tx = makeTx({ data: 'ISSUE|TEST|1000|100|8' });
        await actions.processTransaction(tx);
        const [params, data] = stubs.actionIssue.firstCall.args;
        // After legacy insertion, params[0] should be version 0 and params[1] should be TICK
        assert.strictEqual(data.FORMAT, 0, 'FORMAT should be 0 after legacy version insertion');
        assert.strictEqual(params[1], 'TEST', 'TICK should be at params[1] after version 0 inserted');
    });

    it('inserts version 0 for legacy MINT format where TICK is first param', async function () {
        const { actions, stubs } = buildActions();
        const tx = makeTx({ data: 'MINT|TEST|100' });
        await actions.processTransaction(tx);
        const [params, data] = stubs.actionMint.firstCall.args;
        assert.strictEqual(data.FORMAT, 0);
        assert.strictEqual(params[1], 'TEST');
    });

    it('inserts version 0 for legacy SEND format where TICK is first param', async function () {
        const { actions, stubs } = buildActions();
        const tx = makeTx({ data: 'SEND|TEST|100|addr' });
        await actions.processTransaction(tx);
        const [params, data] = stubs.actionSend.firstCall.args;
        assert.strictEqual(data.FORMAT, 0);
        assert.strictEqual(params[1], 'TEST');
    });
});

describe('Actions.processTransaction() @regression @tier3', function () {
    afterEach(async function () {
        sinon.restore();
        await shutdownPendingVms();
    });

    it('does NOT insert extra version for non-legacy SEND with numeric version', async function () {
        const { actions, stubs } = buildActions();
        const tx = makeTx({ data: 'SEND|0|TEST|100|addr' });
        await actions.processTransaction(tx);
        const [params, data] = stubs.actionSend.firstCall.args;
        // FORMAT is extracted from params[0] but params is NOT shifted : version string stays
        assert.strictEqual(data.FORMAT, 0);
        // params still contains ['0', 'TEST', '100', 'addr'] : version is at index 0
        assert.strictEqual(params[0], '0');
        assert.strictEqual(params[1], 'TEST');
    });

    // ── Unknown action ────────────────────────────────────────────────────

    it('routes UNKNOWN action to actionUnknown.parse when not defined', async function () {
        const { actions, stubs } = buildActions({ defined: false });
        await actions.processTransaction(makeTx({ data: 'FAKEACTION|0|stuff' }));
        assert.ok(stubs.actionUnknown.calledOnce, 'actionUnknown.parse should be called');
    });

    it('sets data.ACTION to UNKNOWN when action is not defined', async function () {
        const { actions, stubs } = buildActions({ defined: false });
        await actions.processTransaction(makeTx({ data: 'FAKEACTION|0|stuff' }));
        const [, data] = stubs.actionUnknown.firstCall.args;
        assert.strictEqual(data.ACTION, 'UNKNOWN');
    });

    it('passes error string to handler when action is not defined', async function () {
        const { actions, stubs } = buildActions({ defined: false });
        await actions.processTransaction(makeTx({ data: 'FAKEACTION|0|stuff' }));
        const [, , error] = stubs.actionUnknown.firstCall.args;
        assert.ok(typeof error === 'string' && error.length > 0, 'error should be a non-empty string');
    });

    // ── Action not yet enabled ────────────────────────────────────────────

    it('passes error to handler when action is not yet activated', async function () {
        const { actions, stubs } = buildActions({ defined: true, enabled: false });
        await actions.processTransaction(makeTx({ data: 'SEND|0|TEST|100|addr' }));
        const [, , error] = stubs.actionSend.firstCall.args;
        assert.ok(typeof error === 'string' && error.length > 0, 'error should indicate not activated');
    });

    it('still calls the correct handler even when action is not enabled', async function () {
        const { actions, stubs } = buildActions({ defined: true, enabled: false });
        await actions.processTransaction(makeTx({ data: 'SEND|0|TEST|100|addr' }));
        assert.ok(stubs.actionSend.calledOnce);
    });
});

describe('Actions.processTransaction() @regression @tier3', function () {
    afterEach(async function () {
        sinon.restore();
        await shutdownPendingVms();
    });

    // ── data object construction ──────────────────────────────────────────

    it('populates data object with correct base fields', async function () {
        const { actions, stubs } = buildActions();
        const tx = makeTx({
            data:        'SEND|0|TEST|100|addr',
            source:      'src123',
            destination: 'dest456',
            amount:      '0.001',
            tx_hash:     'b'.repeat(64),
            vout:        2,
            block_index: 200,
            block_time:  1800000000,
        });
        await actions.processTransaction(tx);
        const [, data] = stubs.actionSend.firstCall.args;
        assert.strictEqual(data.ACTION,           'SEND');
        assert.strictEqual(data.FORMAT,            0);
        assert.strictEqual(data.BLOCK_INDEX,       200);
        assert.strictEqual(data.BLOCK_TIME,        1800000000);
        assert.strictEqual(data.SOURCE,            'src123');
        assert.strictEqual(data.COIN,              'BTC');
        assert.strictEqual(data.COIN_DESTINATION,  'dest456');
        assert.strictEqual(data.COIN_AMOUNT,       '0.001');
        assert.strictEqual(data.TX_HASH,           'b'.repeat(64));
        assert.strictEqual(data.TX_VOUT,           2);
        assert.strictEqual(data.TX_DATA,           'SEND|0|TEST|100|addr');
    });

    it('action string is uppercased regardless of input case', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'send|0|TEST|100|addr' }));
        const [, data] = stubs.actionSend.firstCall.args;
        assert.strictEqual(data.ACTION, 'SEND');
    });

    it('trims whitespace from pipe-delimited params', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'SEND | 0 | TEST | 100 | addr' }));
        const [params] = stubs.actionSend.firstCall.args;
        // After trimming and shift of action, first element should be 'TEST' (index 1 after version)
        for (const p of params) {
            assert.strictEqual(p, p.trim(), `param "${p}" should have no surrounding whitespace`);
        }
    });
});

describe('Actions.processTransaction() @regression @tier3', function () {
    afterEach(async function () {
        sinon.restore();
        await shutdownPendingVms();
    });

    // ── DB method calls ───────────────────────────────────────────────────

    it('calls createAddress for source and destination before processing', async function () {
        const { actions, indexer } = buildActions();
        const tx = makeTx();
        await actions.processTransaction(tx);
        assert.ok(indexer.indexerDb.createAddress.called);
    });

    it('calls createTransaction with tx_hash before processing', async function () {
        const { actions, indexer } = buildActions();
        const tx = makeTx();
        await actions.processTransaction(tx);
        assert.ok(indexer.indexerDb.createTransaction.calledWith(tx.tx_hash));
    });

    it('calls createTxIndex and stores result in data.TX_INDEX', async function () {
        const { actions, indexer, stubs } = buildActions();
        indexer.indexerDb.createTxIndex.resolves(42);
        await actions.processTransaction(makeTx());
        const [, data] = stubs.actionSend.firstCall.args;
        assert.strictEqual(data.TX_INDEX, 42);
    });

    it('calls createActionIndex and stores result in data.ACTION_INDEX', async function () {
        const { actions, indexer, stubs } = buildActions();
        indexer.indexerDb.createActionIndex.resolves(99);
        await actions.processTransaction(makeTx());
        const [, data] = stubs.actionSend.firstCall.args;
        assert.strictEqual(data.ACTION_INDEX, 99);
    });
});
