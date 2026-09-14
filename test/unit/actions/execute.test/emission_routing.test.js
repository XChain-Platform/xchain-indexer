// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// How an EXECUTE's emissions are built and routed: their params, the handler
// each reaches, the VOTE and XCALL host guards, the permissions allowlist and
// the emission fee skip. Split from ../execute.test.js by behaviour.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer } = require('../../../fixtures/mocks');
const { getTestConfig } = require('../../../fixtures/config');

const Execute = require('../../../../src/actions/execute/index.js');
const { SOURCE, CONTRACT, addExecuteStubs, makeVm, executeData, buildExecute } = require('./helpers/fixture.js');

// Rebuilt by setUp before every test. Module-level so the same-title sibling
// suites below, split only to fit the function-length limit with every full
// test title unchanged, share one fixture.
let indexer, actionsCtx, handler;

function setUp() {
    ({ indexer, actionsCtx, handler } = buildExecute());
}

function tearDown() {
    sinon.restore();
}

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // ─── buildActionParams unit checks ────────────────────────────────────

    describe('buildActionParams', function () {

        it('SEND → positional array VERSION|TICK|AMOUNT|DESTINATION|MEMO', function () {
            const p = handler.buildActionParams('SEND', { tick: 'TEST', quantity: '10', destination: '1Dest', memo: 'hi' });
            assert.deepStrictEqual(p, [0, 'TEST', '10', '1Dest', 'hi']);
        });

        it('DESTROY → VERSION|TICK|AMOUNT|MEMO', function () {
            const p = handler.buildActionParams('DESTROY', { tick: 'TEST', quantity: '5', memo: '' });
            assert.deepStrictEqual(p, [0, 'TEST', '5', '']);
        });

        it('MINT → VERSION|TICK|AMOUNT|DESTINATION|MEMO', function () {
            const p = handler.buildActionParams('MINT', { tick: 'TEST', quantity: '50', destination: '', memo: '' });
            assert.deepStrictEqual(p, [0, 'TEST', '50', '', '']);
        });

        it('BROADCAST → VERSION|MESSAGE|VALUE', function () {
            const p = handler.buildActionParams('BROADCAST', { message: 'hello', value: '42' });
            assert.deepStrictEqual(p, [0, 'hello', '42']);
        });

        it('COINPAY → VERSION|ORDER_MATCH_ACTION_INDEX', function () {
            const p = handler.buildActionParams('COINPAY', { orderMatchActionIndex: 99 });
            assert.deepStrictEqual(p, [0, 99]);
        });

        it('throws for unsupported emission action', function () {
            assert.throws(
                () => handler.buildActionParams('UNKNOWNACTION', {}),
                /unsupported emission action/
            );
        });

    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // ─── getActionHandler ─────────────────────────────────────────────────

    describe('getActionHandler', function () {

        it('returns null for unknown action', function () {
            assert.strictEqual(handler.getActionHandler('TOTALLY_UNKNOWN'), null);
        });

        it('returns the SEND handler when wired', function () {
            actionsCtx.actionSend = { parse: sinon.stub() };
            handler = new Execute(actionsCtx);
            assert.strictEqual(handler.getActionHandler('SEND'), actionsCtx.actionSend);
        });

        it('returns the DESTROY handler when wired', function () {
            actionsCtx.actionDestroy = { parse: sinon.stub() };
            handler = new Execute(actionsCtx);
            assert.strictEqual(handler.getActionHandler('DESTROY'), actionsCtx.actionDestroy);
        });

    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // ─── processEmission: emission routing ───────────────────────────────

    describe('processEmission', function () {
        it('throws when action handler is unknown or unsupported', async function () {
            // buildActionParams throws 'unsupported emission action' before getActionHandler fires
            const emission = { action: 'UNKNOWNACTION', params: {} };
            const execData = executeData({ FORMAT: 0 });
            await assert.rejects(
                () => handler.processEmission(emission, execData, 0),
                /unsupported|unknown/
            );
        });

        it('throws when ATTEST emission is missing position argument', async function () {
            const emission = { action: 'ATTEST', params: { requestId: 'a'.repeat(64) } };
            const execData = executeData({ FORMAT: 0 });
            await assert.rejects(
                () => handler.processEmission(emission, execData, undefined),
                /EMITTER_POSITION/
            );
        });

        // ── XCALL emission host-side guards (defense-in-depth vs a compromised VM) ──
        // All four throw before buildActionParams, so minimal emission params suffice.

        // Only VOTE v0 (create) / v1 (ballot) are emittable. v2
        // (finalize) and v3 (delegate) are gateway-rejected; re-blocked host-side as
        // defense in depth against an older/compromised bundled VM.
        it('throws on an emitted VOTE v2 (finalize) - host-side re-block', async function () {
            const emission = { action: 'VOTE', params: { version: 2, tick: 'TEST' } };
            const execData = executeData({ FORMAT: 0 });
            await assert.rejects(
                () => handler.processEmission(emission, execData, 0),
                /VOTE version 2 is not emittable/
            );
        });

        it('throws on an emitted VOTE v3 (delegate) - host-side re-block', async function () {
            const emission = { action: 'VOTE', params: { version: 3, tick: 'TEST' } };
            const execData = executeData({ FORMAT: 0 });
            await assert.rejects(
                () => handler.processEmission(emission, execData, 0),
                /VOTE version 3 is not emittable/
            );
        });

        it('throws when XCALL emission is missing the position argument', async function () {
            const emission = { action: 'XCALL', params: { gasLimit: 50000 } };
            const execData = executeData({ FORMAT: 0 });
            await assert.rejects(
                () => handler.processEmission(emission, execData, undefined),
                /XCALL emission missing EMITTER_POSITION/
            );
        });
    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);
    describe('processEmission', function () {
        it('throws when XCALL is emitted from a constructor', async function () {
            const emission = { action: 'XCALL', params: { gasLimit: 50000 } };
            const execData = executeData({ FORMAT: 0, IS_CONSTRUCTOR: true });
            await assert.rejects(
                () => handler.processEmission(emission, execData, 0),
                /XCALL emission is not allowed from a constructor/
            );
        });

        it('throws when the host-derived hop count exceeds the cross-chain cap', async function () {
            // CROSS_HOPS=2 → hostHops = 2+1 = 3 > XCALL_MAX_HOPS(2).
            const emission = { action: 'XCALL', params: { gasLimit: 50000 } };
            const execData = executeData({ FORMAT: 0, CROSS_HOPS: 2 });
            await assert.rejects(
                () => handler.processEmission(emission, execData, 0),
                /exceeds max cross-chain hops/
            );
        });

        it('re-validates the XCALL gasLimit host-side (out of range rejected)', async function () {
            for (const gasLimit of [4999, 200001]) {
                const emission = { action: 'XCALL', params: { gasLimit } };
                const execData = executeData({ FORMAT: 0 });
                await assert.rejects(
                    () => handler.processEmission(emission, execData, 0),
                    /XCALL emission gasLimit out of range/,
                    'gasLimit=' + gasLimit
                );
            }
        });

        it('buildActionParams(XCALL) emits the v0 positional wire format', function () {
            const out = handler.buildActionParams('XCALL', {
                callId: 'a'.repeat(64), targetChain: 'DOGE', contractIndex: 99, method: 'onArrival',
                params: ['x', 1], gasLimit: 50000, callbackMethod: 'onResult',
                callbackParams: ['ctx'], deadlineBlocks: 200, crossHops: 1,
            });
            // VERSION|CALL_ID|TARGET_CHAIN|TARGET_CONTRACT_INDEX|METHOD|PARAMS_JSON|GAS_LIMIT|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|DEADLINE_BLOCKS|CROSS_HOPS
            assert.deepStrictEqual(out, [
                0, 'a'.repeat(64), 'DOGE', 99, 'onArrival', '["x","1"]', 50000,
                'onResult', '["ctx"]', 200, 1,
            ]);
        });

        it('routes a SEND emission to the wired SEND handler', async function () {
            const sendHandler = { parse: sinon.stub().callsFake(async (params, data) => { data['STATUS'] = 'valid'; }) };
            actionsCtx.actionSend = sendHandler;
            handler = new Execute(actionsCtx);

            const emission = { action: 'SEND', params: { tick: 'TEST', quantity: '1', destination: SOURCE } };
            const execData = executeData({ FORMAT: 0, CONTRACT_ACTION_INDEX: CONTRACT });
            await handler.processEmission(emission, execData, 0);
            assert.ok(sendHandler.parse.calledOnce);
        });
    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('processEmission', function () {
        it('throws when emission handler sets STATUS to invalid', async function () {
            const sendHandler = { parse: sinon.stub().callsFake(async (params, data) => { data['STATUS'] = 'invalid: bad tick'; }) };
            actionsCtx.actionSend = sendHandler;
            handler = new Execute(actionsCtx);

            const emission = { action: 'SEND', params: { tick: 'TEST', quantity: '1', destination: SOURCE } };
            const execData = executeData({ FORMAT: 0, CONTRACT_ACTION_INDEX: CONTRACT });
            await assert.rejects(
                () => handler.processEmission(emission, execData, 0),
                /invalid/
            );
        });
    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('processEmission', function () {
        // ---- Phase E: permissions-manifest emission allowlist (all paths funnel here) ----

        it('rejects an emission whose action is not in the contract permissions allowlist', async function () {
            const sendHandler = { parse: sinon.stub().callsFake(async (params, data) => { data['STATUS'] = 'valid'; }) };
            actionsCtx.actionSend = sendHandler;
            handler = new Execute(actionsCtx);
            // The emitter declared a manifest permitting only ISSUE; a SEND must be rejected
            // fail-closed BEFORE the handler ever runs.
            actionsCtx.indexerDb.getContractPermissions = sinon.stub().resolves({ permissions: ['ISSUE'], maxTakeBps: null });

            const emission = { action: 'SEND', params: { tick: 'TEST', quantity: '1', destination: SOURCE } };
            const execData = executeData({ FORMAT: 0, CONTRACT_ACTION_INDEX: CONTRACT });
            await assert.rejects(
                () => handler.processEmission(emission, execData, 0),
                /manifest: action SEND not permitted/
            );
            assert.ok(sendHandler.parse.notCalled, 'handler is never reached for a disallowed action');
        });

        it('allows an emission whose action IS in the permissions allowlist', async function () {
            const sendHandler = { parse: sinon.stub().callsFake(async (params, data) => { data['STATUS'] = 'valid'; }) };
            actionsCtx.actionSend = sendHandler;
            handler = new Execute(actionsCtx);
            actionsCtx.indexerDb.getContractPermissions = sinon.stub().resolves({ permissions: ['SEND', 'ISSUE'], maxTakeBps: null });

            const emission = { action: 'SEND', params: { tick: 'TEST', quantity: '1', destination: SOURCE } };
            const execData = executeData({ FORMAT: 0, CONTRACT_ACTION_INDEX: CONTRACT });
            await handler.processEmission(emission, execData, 0);
            assert.ok(sendHandler.parse.calledOnce, 'a permitted action routes to its handler');
        });

        it('an empty permissions allowlist permits no emissions', async function () {
            const sendHandler = { parse: sinon.stub().callsFake(async (params, data) => { data['STATUS'] = 'valid'; }) };
            actionsCtx.actionSend = sendHandler;
            handler = new Execute(actionsCtx);
            actionsCtx.indexerDb.getContractPermissions = sinon.stub().resolves({ permissions: [], maxTakeBps: null });

            const emission = { action: 'SEND', params: { tick: 'TEST', quantity: '1', destination: SOURCE } };
            const execData = executeData({ FORMAT: 0, CONTRACT_ACTION_INDEX: CONTRACT });
            await assert.rejects(
                () => handler.processEmission(emission, execData, 0),
                /not permitted/
            );
        });
    });
});

describe('Execute (EXECUTE) @regression @tier2', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // ─── IS_EMISSION: skip fee ───────────────────────────────────────────

    describe('IS_EMISSION: fee skip', function () {

        it('skips gas fee debit when IS_EMISSION is true', async function () {
            const config = getTestConfig();
            config['GAS_PRICE'] = '0.00000001'; // non-zero fee to exercise the skip
            const localIndexer = createMockIndexer({ config });
            addExecuteStubs(localIndexer.indexerDb);
            localIndexer.indexerDb.isActionAllowed.resolves(true);
            localIndexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
            localIndexer.indexerDb.getAddressBalances.resolves({ 1: '0' }); // zero balance, would fail without skip

            const ctx = {
                config:    localIndexer.config,
                util:      localIndexer.util,
                mapper:    localIndexer.mapper,
                decoderDb: localIndexer.decoderDb,
                indexerDb: localIndexer.indexerDb,
                protocolChanges: localIndexer.protocolChanges,
                vm: makeVm(),   // EXECUTE fails closed without one
            };
            const h = new Execute(ctx);

            const data = executeData({ FORMAT: 0, IS_EMISSION: true });
            await h.parse(['0', String(CONTRACT), 'run', ''], data, null);
            // Should be valid because fee was skipped (zero balance would have blocked it otherwise)
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(localIndexer.indexerDb.createDebit.notCalled, 'no fee debit for IS_EMISSION');
        });

    });
});
