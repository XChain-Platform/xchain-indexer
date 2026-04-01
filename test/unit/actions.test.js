/**
 * test/unit/actions.test.js
 *
 * Unit tests for the Actions class (src/actions.js).
 *
 * All DB methods and action handler parse() methods are stubbed so that
 * no real database calls or action logic executes.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert  = require('assert');
const sinon   = require('sinon');

const { createMockIndexer } = require('../fixtures/mocks');
const Actions               = require('../../src/actions');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a mock protocolChanges object.
 * By default, every action is defined and enabled.
 */
function makeProtocolChanges({ defined = true, enabled = true } = {}) {
    return {
        isDefined:  sinon.stub().returns(defined),
        isEnabled:  sinon.stub().resolves(enabled),
    };
}

/**
 * Build a minimal transaction object as xchain-decoder would produce.
 */
function makeTx(overrides = {}) {
    return {
        source:      '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
        destination: '1DestAddressXXXXXXXXXXXXXXXXXaKc5Z',
        amount:      '0.00000000',
        tx_hash:     'a'.repeat(64),
        vout:        0,
        block_index: 100,
        block_time:  1700000000,
        data:        'SEND|0|TEST|100|1DestAddressXXXXXXXXXXXXXXXXXaKc5Z',
        ...overrides,
    };
}

/**
 * Instantiate Actions and stub all handler parse() methods.
 * Returns { actions, indexer, stubs } so tests can inspect calls.
 */
function buildActions(protocolChangesOverrides = {}) {
    const indexer = createMockIndexer();
    indexer.protocolChanges = makeProtocolChanges(protocolChangesOverrides);

    const actions = new Actions(indexer);

    // Stub every handler's parse() with a resolved stub
    const handlerKeys = [
        'actionAddress', 'actionAirdrop', 'actionBatch', 'actionBroadcast',
        'actionCallback', 'actionDestroy', 'actionDispenser', 'actionDispenserClose',
        'actionDispenserExpire', 'actionDispense', 'actionDividend', 'actionFile',
        'actionIssue', 'actionLink', 'actionList', 'actionMessage', 'actionMint',
        'actionOrder', 'actionOrderExpire', 'actionOrderMatch', 'actionSleep',
        'actionSend', 'actionSwap', 'actionSwapExpire', 'actionSwapMatch',
        'actionSweep', 'actionUnknown',
    ];

    const stubs = {};
    for (const key of handlerKeys) {
        stubs[key] = sinon.stub(actions[key], 'parse').resolves();
    }

    return { actions, indexer, stubs };
}

// ---------------------------------------------------------------------------
// describe: processTransaction — action routing
// ---------------------------------------------------------------------------
describe('Actions.processTransaction() @regression @tier3', function () {
    afterEach(function () {
        sinon.restore();
    });

    // ── Basic routing ─────────────────────────────────────────────────────

    it('routes SEND to actionSend.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'SEND|0|TEST|100|addr' }));
        assert.ok(stubs.actionSend.calledOnce, 'actionSend.parse should be called once');
    });

    it('routes ISSUE to actionIssue.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'ISSUE|0|TEST|1000|100|8' }));
        assert.ok(stubs.actionIssue.calledOnce);
    });

    it('routes MINT to actionMint.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'MINT|0|TEST|100' }));
        assert.ok(stubs.actionMint.calledOnce);
    });

    it('routes AIRDROP to actionAirdrop.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'AIRDROP|0|TEST|10' }));
        assert.ok(stubs.actionAirdrop.calledOnce);
    });

    it('routes BROADCAST to actionBroadcast.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'BROADCAST|0|hello world' }));
        assert.ok(stubs.actionBroadcast.calledOnce);
    });

    it('routes DESTROY to actionDestroy.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'DESTROY|0|TEST|50' }));
        assert.ok(stubs.actionDestroy.calledOnce);
    });

    it('routes ADDRESS to actionAddress.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'ADDRESS|0|option|value' }));
        assert.ok(stubs.actionAddress.calledOnce);
    });

    it('routes BATCH to actionBatch.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'BATCH|0|cmd1;cmd2' }));
        assert.ok(stubs.actionBatch.calledOnce);
    });

    it('routes CALLBACK to actionCallback.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'CALLBACK|0|1|TEST|50' }));
        assert.ok(stubs.actionCallback.calledOnce);
    });

    it('routes DISPENSER to actionDispenser.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'DISPENSER|0|TEST|100|1|100' }));
        assert.ok(stubs.actionDispenser.calledOnce);
    });

    it('routes DIVIDEND to actionDividend.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'DIVIDEND|0|TEST|GAS|100' }));
        assert.ok(stubs.actionDividend.calledOnce);
    });

    it('routes FILE to actionFile.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'FILE|0|myfile.txt' }));
        assert.ok(stubs.actionFile.calledOnce);
    });

    it('routes LINK to actionLink.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'LINK|0|1|2' }));
        assert.ok(stubs.actionLink.calledOnce);
    });

    it('routes LIST to actionList.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'LIST|0|ALLOW|addr1' }));
        assert.ok(stubs.actionList.calledOnce);
    });

    it('routes MESSAGE to actionMessage.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'MESSAGE|0|1|key|ciphertext' }));
        assert.ok(stubs.actionMessage.calledOnce);
    });

    it('routes ORDER to actionOrder.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'ORDER|0|TEST|100|GAS|50' }));
        assert.ok(stubs.actionOrder.calledOnce);
    });

    it('routes SLEEP to actionSleep.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'SLEEP|0|200' }));
        assert.ok(stubs.actionSleep.calledOnce);
    });

    it('routes SWAP to actionSwap.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'SWAP|0|TEST|100|GAS|50' }));
        assert.ok(stubs.actionSwap.calledOnce);
    });

    it('routes SWEEP to actionSweep.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'SWEEP|0|destaddr' }));
        assert.ok(stubs.actionSweep.calledOnce);
    });

    // ── Aliases ───────────────────────────────────────────────────────────

    it('resolves DEPLOY alias to ISSUE', async function () {
        const { actions, stubs, indexer } = buildActions();
        // protocolChanges.isDefined checks the resolved name — stub returns true always
        await actions.processTransaction(makeTx({ data: 'DEPLOY|0|TEST|1000|100|8' }));
        assert.ok(stubs.actionIssue.calledOnce, 'DEPLOY should route to actionIssue.parse');
        assert.ok(stubs.actionSend.notCalled);
    });

    it('resolves TRANSFER alias to SEND', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'TRANSFER|0|TEST|100|addr' }));
        assert.ok(stubs.actionSend.calledOnce, 'TRANSFER should route to actionSend.parse');
    });

    it('resolves ADDR alias to ADDRESS', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'ADDR|0|opt|val' }));
        assert.ok(stubs.actionAddress.calledOnce, 'ADDR should route to actionAddress.parse');
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
        // Legacy: no version, TICK comes first — e.g. "ISSUE|TEST|1000|100|8"
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

    it('does NOT insert extra version for non-legacy SEND with numeric version', async function () {
        const { actions, stubs } = buildActions();
        const tx = makeTx({ data: 'SEND|0|TEST|100|addr' });
        await actions.processTransaction(tx);
        const [params, data] = stubs.actionSend.firstCall.args;
        // FORMAT is extracted from params[0] but params is NOT shifted — version string stays
        assert.strictEqual(data.FORMAT, 0);
        // params still contains ['0', 'TEST', '100', 'addr'] — version is at index 0
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

// ---------------------------------------------------------------------------
// describe: processAction — handler dispatch + resetLists
// ---------------------------------------------------------------------------
describe('Actions.processAction() @regression @tier3', function () {
    let actions;
    let stubs;
    let util;

    beforeEach(function () {
        const built = buildActions();
        actions = built.actions;
        stubs   = built.stubs;
        util    = built.indexer.util;
        sinon.spy(util, 'resetLists');
    });

    afterEach(function () {
        sinon.restore();
    });

    async function call(action, params = [], data = {}, error = false) {
        return actions.processAction(action, params, data, error);
    }

    it('calls util.resetLists() before dispatching', async function () {
        await call('SEND');
        assert.ok(util.resetLists.calledOnce, 'resetLists should be called once');
    });

    it('calls resetLists even when action is UNKNOWN', async function () {
        await call('UNKNOWN');
        assert.ok(util.resetLists.calledOnce);
    });

    it('dispatches ADDRESS to actionAddress.parse', async function () {
        await call('ADDRESS');
        assert.ok(stubs.actionAddress.calledOnce);
    });

    it('dispatches AIRDROP to actionAirdrop.parse', async function () {
        await call('AIRDROP');
        assert.ok(stubs.actionAirdrop.calledOnce);
    });

    it('dispatches BATCH to actionBatch.parse', async function () {
        await call('BATCH');
        assert.ok(stubs.actionBatch.calledOnce);
    });

    it('dispatches BROADCAST to actionBroadcast.parse', async function () {
        await call('BROADCAST');
        assert.ok(stubs.actionBroadcast.calledOnce);
    });

    it('dispatches CALLBACK to actionCallback.parse', async function () {
        await call('CALLBACK');
        assert.ok(stubs.actionCallback.calledOnce);
    });

    it('dispatches DESTROY to actionDestroy.parse', async function () {
        await call('DESTROY');
        assert.ok(stubs.actionDestroy.calledOnce);
    });

    it('dispatches DISPENSER to actionDispenser.parse', async function () {
        await call('DISPENSER');
        assert.ok(stubs.actionDispenser.calledOnce);
    });

    it('dispatches DISPENSER_CLOSE to actionDispenserClose.parse', async function () {
        await call('DISPENSER_CLOSE');
        assert.ok(stubs.actionDispenserClose.calledOnce);
    });

    it('dispatches DISPENSER_EXPIRE to actionDispenserExpire.parse', async function () {
        await call('DISPENSER_EXPIRE');
        assert.ok(stubs.actionDispenserExpire.calledOnce);
    });

    it('dispatches DISPENSE to actionDispense.parse', async function () {
        await call('DISPENSE');
        assert.ok(stubs.actionDispense.calledOnce);
    });

    it('dispatches DIVIDEND to actionDividend.parse', async function () {
        await call('DIVIDEND');
        assert.ok(stubs.actionDividend.calledOnce);
    });

    it('dispatches FILE to actionFile.parse', async function () {
        await call('FILE');
        assert.ok(stubs.actionFile.calledOnce);
    });

    it('dispatches ISSUE to actionIssue.parse', async function () {
        await call('ISSUE');
        assert.ok(stubs.actionIssue.calledOnce);
    });

    it('dispatches LIST to actionList.parse', async function () {
        await call('LIST');
        assert.ok(stubs.actionList.calledOnce);
    });

    it('dispatches LINK to actionLink.parse', async function () {
        await call('LINK');
        assert.ok(stubs.actionLink.calledOnce);
    });

    it('dispatches MINT to actionMint.parse', async function () {
        await call('MINT');
        assert.ok(stubs.actionMint.calledOnce);
    });

    it('dispatches MESSAGE to actionMessage.parse', async function () {
        await call('MESSAGE');
        assert.ok(stubs.actionMessage.calledOnce);
    });

    it('dispatches ORDER to actionOrder.parse', async function () {
        await call('ORDER');
        assert.ok(stubs.actionOrder.calledOnce);
    });

    it('dispatches ORDER_EXPIRE to actionOrderExpire.parse', async function () {
        await call('ORDER_EXPIRE');
        assert.ok(stubs.actionOrderExpire.calledOnce);
    });

    it('dispatches ORDER_MATCH to actionOrderMatch.parse', async function () {
        await call('ORDER_MATCH');
        assert.ok(stubs.actionOrderMatch.calledOnce);
    });

    it('dispatches SLEEP to actionSleep.parse', async function () {
        await call('SLEEP');
        assert.ok(stubs.actionSleep.calledOnce);
    });

    it('dispatches SEND to actionSend.parse', async function () {
        await call('SEND');
        assert.ok(stubs.actionSend.calledOnce);
    });

    it('dispatches SWAP to actionSwap.parse', async function () {
        await call('SWAP');
        assert.ok(stubs.actionSwap.calledOnce);
    });

    it('dispatches SWAP_EXPIRE to actionSwapExpire.parse', async function () {
        await call('SWAP_EXPIRE');
        assert.ok(stubs.actionSwapExpire.calledOnce);
    });

    it('dispatches SWAP_MATCH to actionSwapMatch.parse', async function () {
        await call('SWAP_MATCH');
        assert.ok(stubs.actionSwapMatch.calledOnce);
    });

    it('dispatches SWEEP to actionSweep.parse', async function () {
        await call('SWEEP');
        assert.ok(stubs.actionSweep.calledOnce);
    });

    it('dispatches UNKNOWN to actionUnknown.parse', async function () {
        await call('UNKNOWN');
        assert.ok(stubs.actionUnknown.calledOnce);
    });

    it('does not call any other handler when dispatching SEND', async function () {
        await call('SEND');
        const others = Object.entries(stubs)
            .filter(([k]) => k !== 'actionSend')
            .filter(([, s]) => s.called);
        assert.strictEqual(others.length, 0, `unexpected handlers called: ${others.map(([k]) => k).join(', ')}`);
    });

    it('passes params, data, and error through to the handler', async function () {
        const params = ['TEST', '100', 'addr'];
        const data   = { ACTION: 'SEND', FORMAT: 0 };
        const error  = 'some error';
        await call('SEND', params, data, error);
        const call0 = stubs.actionSend.firstCall;
        assert.deepStrictEqual(call0.args[0], params);
        assert.strictEqual(call0.args[1], data);
        assert.strictEqual(call0.args[2], error);
    });
});
