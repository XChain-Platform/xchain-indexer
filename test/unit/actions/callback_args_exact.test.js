// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// CALLBACK_ARGS_EXACT: an ATTEST, XCALL or binding VOTE callback is built by the framework
// as an argument array. Below the gate, EXECUTE joins it on '|' into METHOD_PARAMS and
// splits it again before the VM, so a '|' inside a provider response, a callee's return
// value or a callback param becomes an argument boundary: a response "x|user-B" puts user-B
// in the slot the contract's own callback param should hold. From the gate on, a callback
// reaches the VM with the array its injector built. Below the gate, and for every
// user-broadcast EXECUTE, the join and split are unchanged.
//
// Each case runs the real injector, then a real EXECUTE handler over the injector's own
// (params, context) pair with a stub VM that records what it was asked to run.

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { setUpAttestHandler, makeRequestRow: attestRow, REQ_ID } = require('../../helpers/attest_fixture.js');
const xf = require('./xcall.test/helpers/xcall_fixtures.js');
const { buildExecute, executeData } = require('./execute.test/helpers/fixture.js');
const Execute = require('../../../src/actions/execute/index.js');
const ed25519 = require('../../../src/consensus/ed25519.js');
const bindingCallback = require('../../../src/actions/vote/binding_callback.js');
const { FRAMEWORK_CALLBACK, CALLBACK_ARGS_EXACT } = require('../../../src/consensus/exec_context.js');
const CHANGES = require('../../../src/protocol_changes/changes_5.js');
const { UNARMED } = require('../../../src/protocol_changes/core.js');

const CALL_ID = 'c'.repeat(64);

// Run one EXECUTE through a real handler with CALLBACK_ARGS_EXACT on or off (every other
// gate open, as the shared mock models regtest) and return what the VM was asked to run.
async function runExecute(actionParams, context, gateOn) {
    const ex = buildExecute();
    ex.actionsCtx.protocolChanges = {
        isDefined: () => true,
        isEnabled: async (name) => (name === CALLBACK_ARGS_EXACT ? gateOn : true),
    };
    const calls = [];
    ex.actionsCtx.vm = {
        execute: sinon.stub().callsFake(async (opts) => {
            calls.push({ method: opts.method, params: opts.params.slice() });
            return { success: true, gasUsed: 100, stateChanges: [], stateDeletes: [], emittedActions: [] };
        }),
    };
    const data = Object.assign(executeData(), context);
    await new Execute(ex.actionsCtx).parse(actionParams, data, null);
    assert.strictEqual(calls.length, 1, 'the VM ran the callback once');
    const ce = ex.indexer.indexerDb.createContractExecution;
    return {
        method: calls[0].method,
        params: calls[0].params,
        methodParams: data['METHOD_PARAMS'],
        stored: ce.called ? ce.firstCall.args[0].INPUT_PARAMS : undefined,
        status: data['STATUS'],
    };
}

// The ATTEST injector's (params, context) pair for a v1 response, or for an expiry.
async function attestCallback(row, status, payload, expired) {
    const s = setUpAttestHandler();
    try {
        if (expired)
            await s.handler.injectExpiredCallback(row, { BLOCK_INDEX: 200, BLOCK_TIME: 1700000100, ACTION_INDEX: 9 });
        else
            await s.handler.injectCallbackExecute(row, {
                BLOCK_INDEX: 200, BLOCK_TIME: 1700000100, ACTION_INDEX: 9, TX_HASH: 'e'.repeat(64),
                TX_INDEX: 1, TX_VOUT: 0, RESPONSE_STATUS: status, RESPONSE_PAYLOAD: payload,
            });
        const call = s.executeStub.parse.firstCall;
        return { params: call.args[0], context: call.args[1] };
    } finally { sinon.restore(); }
}

function freshXcallWithGas() {
    const s = xf.freshXcall();
    s.handler.config['GAS_SCHEDULE'] = Object.assign({}, s.handler.config['GAS_SCHEDULE'] || {}, { VM_XCALL_CALLBACK: 100000 });
    return s;
}

// The XCALL injector's (params, context) pair for a result delivered straight to injectCallback.
async function xcallCallback(row, status, payload) {
    const s = freshXcallWithGas();
    await s.handler.injectCallback(row, Object.assign(xf.ctx(), { ACTION_INDEX: 9 }), status, payload);
    const call = s.executeStub.parse.firstCall;
    return { params: call.args[0], context: call.args[1] };
}

// The XCALL pair end to end through processResult: the mirrored, quorum-signed result row
// carries the callee's JSON return value base64-encoded and the injector decodes it.
async function xcallResultCallback(requestRow, returnValue) {
    const s = freshXcallWithGas();
    sinon.stub(ed25519, 'verify').returns(true);
    try {
        s.indexer.indexerDb.getCrossChainCallRequestById.resolves(requestRow);
        const b64 = Buffer.from(JSON.stringify(returnValue), 'utf8').toString('base64');
        await s.handler.processResult(xf.makeResultRow({ return_payload_b64: b64 }), Object.assign(xf.ctx(), { ACTION_INDEX: 9 }));
        assert.ok(s.executeStub.parse.calledOnce, 'the result injected a callback');
        const call = s.executeStub.parse.firstCall;
        return { params: call.args[0], context: call.args[1] };
    } finally { sinon.restore(); }
}

// The binding VOTE pair, built the way injectCallbackExecute builds it.
async function voteCallback(callbackParamsJson) {
    const handler = {
        actions: { protocolChanges: { isEnabled: async () => false } },
        config: { NETWORK: 'regtest' },
        util: { isNull: (v) => v === null || v === undefined || v === '' },
        indexerDb: {},
    };
    const poll = { action_index: 77, callback_contract_index: 5, callback_method: 'onPoll', callback_params: callbackParamsJson };
    const result = { poll_status: 'passed', winning_option: '0', total_counted_weight: '10', total_voters: '1', quorum_met: true, min_voters_met: true };
    const data = { BLOCK_INDEX: 600, BLOCK_TIME: 1700000600, ACTION_INDEX: 70 };
    const params = await bindingCallback.buildCallbackParams.call(handler, poll, data, result);
    const context = await bindingCallback.buildCallbackContext.call(handler, poll, data, 'BTC', 78);
    return { params, context };
}

// Today's argument vector for a params array: the '|' join and split the gate retires.
const legacySplit = (params) => { const j = params.slice(3).join('|'); return j ? j.split('|') : []; };

describe('CALLBACK_ARGS_EXACT: registry row @regression @tier1', function () {
    afterEach(() => sinon.restore());

    const row = () => CHANGES.find(r => r[0] === CALLBACK_ARGS_EXACT);

    it('is declared unarmed on mainnet and testnet', function () {
        assert.ok(row(), 'gate row missing');
        assert.strictEqual(row()[2], UNARMED, 'mainnet');
        assert.strictEqual(row()[3], UNARMED, 'testnet');
    });

    it('is genesis-active on regtest unless a venue sets CALLBACK_ARGS_EXACT_REGTEST_TIME', function () {
        const env = 'CALLBACK_ARGS_EXACT_REGTEST_TIME';
        const saved = process.env[env];
        try {
            delete process.env[env];
            assert.strictEqual(row()[4](), 0);
            process.env[env] = '1700000000';
            assert.strictEqual(row()[4](), 1700000000);
        } finally {
            if (saved === undefined) delete process.env[env]; else process.env[env] = saved;
        }
    });
});

describe('CALLBACK_ARGS_EXACT: every callback injector marks its context, and only those @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('ATTEST response, ATTEST expiry, XCALL result and binding VOTE callbacks', async function () {
        const pairs = [
            await attestCallback(attestRow(), 'ok', 'hello'),
            await attestCallback(attestRow(), null, null, true),
            await xcallCallback(xf.makeRequestRow(), 'ok', '"42"'),
            await xcallResultCallback(xf.makeRequestRow(), 'r'),
            await voteCallback('["c"]'),
        ];
        for (const p of pairs) assert.strictEqual(p.context[FRAMEWORK_CALLBACK], true);
    });

    it('a user-broadcast EXECUTE keeps its "|" wire semantics with the gate on', async function () {
        const r = await runExecute(['0', '5', 'm', 'a|b', 'c'], {}, true);
        assert.deepStrictEqual(r.params, ['a', 'b', 'c']);
        assert.strictEqual(r.methodParams, 'a|b|c');
    });
});

describe('CALLBACK_ARGS_EXACT: ATTEST callback @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('a callback param "a|b" stays one argument', async function () {
        const p = await attestCallback(attestRow({ callback_params_json: '["a|b","7"]' }), 'ok', 'hello');
        assert.deepStrictEqual((await runExecute(p.params, p.context, true)).params,
            [REQ_ID, 'http_get', 'ok', 'hello', 'a|b', '7']);
        assert.deepStrictEqual((await runExecute(p.params, p.context, false)).params,
            [REQ_ID, 'http_get', 'ok', 'hello', 'a', 'b', '7']);
    });

    it('a provider response "x|user-B" cannot take the contract\'s own slot 4', async function () {
        const p = await attestCallback(attestRow({ callback_params_json: '["user-A"]' }), 'ok', 'x|user-B');
        const on = await runExecute(p.params, p.context, true);
        assert.deepStrictEqual(on.params, [REQ_ID, 'http_get', 'ok', 'x|user-B', 'user-A']);
        const off = await runExecute(p.params, p.context, false);
        assert.strictEqual(off.params[4], 'user-B', 'below the gate the legacy split is kept');
    });

    it('a JSON response with a "|" keeps the developer param in slot 4', async function () {
        const p = await attestCallback(attestRow({ callback_params_json: '["orderId-42"]' }), 'ok', '{"rows":"A|B"}');
        const r = await runExecute(p.params, p.context, true);
        assert.strictEqual(r.params.length, 5);
        assert.strictEqual(r.params[3], '{"rows":"A|B"}');
        assert.strictEqual(r.params[4], 'orderId-42');
    });

    it('a response of 5000 "|" characters is one argument, not 5001', async function () {
        const p = await attestCallback(attestRow({ callback_params_json: '["ctx"]' }), 'ok', '|'.repeat(5000));
        assert.strictEqual((await runExecute(p.params, p.context, true)).params.length, 5);
        assert.strictEqual((await runExecute(p.params, p.context, false)).params.length, 4 + 5000 + 1);
    });

    it('an expiry callback keeps a callback param "a|b" whole', async function () {
        const p = await attestCallback(attestRow({ callback_params_json: '["a|b"]' }), null, null, true);
        assert.deepStrictEqual((await runExecute(p.params, p.context, true)).params,
            [REQ_ID, 'http_get', 'expired', '', 'a|b']);
        assert.deepStrictEqual((await runExecute(p.params, p.context, false)).params,
            [REQ_ID, 'http_get', 'expired', '', 'a', 'b']);
    });
});

describe('CALLBACK_ARGS_EXACT: XCALL callback @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('a callback param "a|b" stays one argument', async function () {
        const p = await xcallCallback(xf.makeRequestRow({ callback_params_json: '["a|b","7"]' }), 'ok', '"42"');
        assert.deepStrictEqual((await runExecute(p.params, p.context, true)).params,
            [CALL_ID, 'DOGE', 'ok', '"42"', 'a|b', '7']);
        assert.deepStrictEqual((await runExecute(p.params, p.context, false)).params,
            [CALL_ID, 'DOGE', 'ok', '"42"', 'a', 'b', '7']);
    });

    it('a callee return value "x|user-B|" cannot take the caller\'s slot 4', async function () {
        const p = await xcallResultCallback(xf.makeRequestRow({ callback_params_json: '["user-A"]' }), 'x|user-B|');
        assert.deepStrictEqual((await runExecute(p.params, p.context, true)).params,
            [CALL_ID, 'DOGE', 'ok', '"x|user-B|"', 'user-A']);
        assert.deepStrictEqual((await runExecute(p.params, p.context, false)).params,
            [CALL_ID, 'DOGE', 'ok', '"x', 'user-B', '"', 'user-A']);
    });
});

describe('CALLBACK_ARGS_EXACT: binding VOTE callback @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('a callback param written as "a\\u007cb" in JSON stays one argument', async function () {
        const p = await voteCallback('["a\\u007cb","7"]');
        assert.deepStrictEqual((await runExecute(p.params, p.context, true)).params.slice(-2), ['a|b', '7']);
        assert.deepStrictEqual((await runExecute(p.params, p.context, false)).params.slice(-3), ['a', 'b', '7']);
    });
});

describe('CALLBACK_ARGS_EXACT: what does not change @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('the stored METHOD_PARAMS / INPUT_PARAMS stays the "|" join on both sides of the gate', async function () {
        const p = await attestCallback(attestRow({ callback_params_json: '["a|b"]' }), 'ok', 'x|y');
        const expected = [REQ_ID, 'http_get', 'ok', 'x|y', 'a|b'].join('|');
        for (const gateOn of [true, false]) {
            const r = await runExecute(p.params, p.context, gateOn);
            assert.strictEqual(r.methodParams, expected);
            assert.strictEqual(r.stored, expected);
            assert.strictEqual(r.status, 'valid');
        }
    });

    it('a "|"-free callback runs with the same arguments with the gate on or off', async function () {
        const cases = [
            await attestCallback(attestRow({ callback_params_json: '["ctx","7"]' }), 'ok', 'hello'),
            await attestCallback(attestRow({ callback_params_json: '[{"k":1},["a","b"],null,1e21,""]' }), 'ok', ''),
            await attestCallback(attestRow({ provider_id: null, callback_params_json: 'not json' }), 'ok', 'a,b;c\td\ne'),
            await attestCallback(attestRow({ callback_params_json: '["","",""]' }), null, null, true),
            await xcallCallback(xf.makeRequestRow({ callback_params_json: '["a\\u0000b","a｜b","a¦b"]' }), 'ok', null),
            await xcallCallback(xf.makeRequestRow({ target_chain: null, callback_params_json: '[]' }), 'expired', ''),
            await voteCallback('["x","",""]'),
        ];
        for (const p of cases) {
            const on  = await runExecute(p.params, p.context, true);
            const off = await runExecute(p.params, p.context, false);
            assert.deepStrictEqual(on.params, off.params);
            assert.deepStrictEqual(off.params, legacySplit(p.params));
            assert.strictEqual(on.method, off.method);
        }
    });

    it('a callbackMethod "c|d" is passed whole as the method on both sides of the gate', async function () {
        const p = await attestCallback(attestRow({ callback_method: 'c|d', callback_params_json: '["z"]' }), 'ok', 'hi');
        for (const gateOn of [true, false]) {
            const r = await runExecute(p.params, p.context, gateOn);
            assert.strictEqual(r.method, 'c|d');
            assert.deepStrictEqual(r.params, [REQ_ID, 'http_get', 'ok', 'hi', 'z']);
        }
    });

    it('["a|b"] and ["a","b"] reach the VM differently but store the same display value', async function () {
        const one = await attestCallback(attestRow({ callback_params_json: '["a|b"]' }), 'ok', 'p');
        const two = await attestCallback(attestRow({ callback_params_json: '["a","b"]' }), 'ok', 'p');
        const r1 = await runExecute(one.params, one.context, true);
        const r2 = await runExecute(two.params, two.context, true);
        assert.notDeepStrictEqual(r1.params, r2.params);
        assert.strictEqual(r1.methodParams, r2.methodParams);
    });
});
