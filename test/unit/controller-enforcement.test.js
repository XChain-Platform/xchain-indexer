'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Programmable policy layer — Phase B enforcement helper.
 *
 * Utility.maybeRunControllerGuard is the single enforcement point the token handlers
 * (SEND/ORDER/SWAP/DISPENSER) call at their validated→settlement boundary. These tests
 * pin its CONTROL FLOW with fakes (fake db.getEffectiveTokenController + fake
 * actions.actionExecute.runControllerGuard) — no DB, no VM — so they run on any Node.
 * The real guard run (VM execution, gas metering) is exercised on Node 22 / test-host.
 *
 * Spec: xchain-documentation/protocol/Controller_Bound_Tokens.md
 ********************************************************************/

const assert  = require('assert');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
const Utility = require('../../src/utility.js');

const util = new Utility();

const BASE = { BLOCK_INDEX: 100, ACTION_INDEX: 5, SOURCE: 'addr1' };

function mkDb(effective){
    return {
        config: { GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: 200000 }, GAS_PRICE: '0.00001', GAS: 'XCHAIN' },
        getTickerId: async () => 1,
        getEffectiveTokenController: async () => effective
    };
}
// guardEnabled toggles the CONTROLLER_GUARD activation gate that _invokeController consults
// (default true = at/above the flag-day, where the control-flow tests below exercise the guard).
function mkActions(guardResult, calls, guardEnabled){
    return {
        protocolChanges: { isEnabled: async () => (guardEnabled === undefined ? true : guardEnabled) },
        actionExecute:   { runControllerGuard: async (o) => { calls.push(o); return guardResult; } }
    };
}

describe('Programmable policy layer — Phase B enforcement @regression', function () {

    describe('controllerActionClass — static action→class map', function () {
        it('SEND → transfer', function () {
            assert.strictEqual(util.controllerActionClass('SEND'), 'transfer');
        });
        it('ORDER/SWAP/DISPENSER create → trade', function () {
            for (const a of ['ORDER_CREATE', 'SWAP_CREATE', 'DISPENSER_CREATE'])
                assert.strictEqual(util.controllerActionClass(a), 'trade');
        });
        it('DESTROY → burn', function () {
            assert.strictEqual(util.controllerActionClass('DESTROY'), 'burn');
        });
        it('MINT → mint, STAKE → stake (routable stubs)', function () {
            assert.strictEqual(util.controllerActionClass('MINT'), 'mint');
            assert.strictEqual(util.controllerActionClass('STAKE'), 'stake');
        });
        it('an unmapped action → null (never gated)', function () {
            for (const a of ['ATTEST', 'XCALL', 'ISSUE', 'EXECUTE', ''])
                assert.strictEqual(util.controllerActionClass(a), null);
        });
    });

    describe('maybeRunAddressControllerGuard — recipient/account-side', function () {
        function mkAddrDb(effective){
            return {
                config: { GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: 200000 }, GAS_PRICE: '0.00001', GAS: 'XCHAIN' },
                getAddressId: async () => 1,
                getEffectiveAddressController: async () => effective
            };
        }
        const recipOpts = (extra) => Object.assign({
            actionType: 'SEND', actionClass: 'transfer', address: 'addrB',
            from: 'addrA', to: 'addrB', tick: 'AAA', amount: '10',
            data: Object.assign({}, BASE), gasInfo: null, gasBalances: []
        }, extra || {});

        it('no address controller bound → skip (guard never runs)', async function () {
            const calls = [];
            const res = await util.maybeRunAddressControllerGuard(mkActions(null, calls), mkAddrDb(null), recipOpts());
            assert.deepStrictEqual(res, { error: null, guardFee: 0, payoutLegs: null });
            assert.strictEqual(calls.length, 0);
        });

        it('missing actionClass → skip', async function () {
            const res = await util.maybeRunAddressControllerGuard(mkActions(null, []), mkAddrDb({ contract_index: 9, is_unbind: 0 }), recipOpts({ actionClass: null }));
            assert.strictEqual(res.error, null);
        });

        it('recipient controller DENY → reverts the send (error = reason)', async function () {
            const res = await util.maybeRunAddressControllerGuard(
                mkActions({ allow: false, reason: 'recipient refused', gasBilled: 100 }, []),
                mkAddrDb({ contract_index: 9, is_unbind: 0 }), recipOpts());
            assert.strictEqual(res.error, 'recipient refused');
            assert.strictEqual(res.guardFee, 0);
        });

        it('recipient controller ALLOW → guardFee, guard called with the controller index', async function () {
            const calls = [];
            const res = await util.maybeRunAddressControllerGuard(
                mkActions({ allow: true, reason: null, gasBilled: 1000 }, calls),
                mkAddrDb({ contract_index: 9, is_unbind: 0 }), recipOpts());
            assert.strictEqual(res.error, null);
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].controllerIndex, 9);
            assert.strictEqual(util.bcgt(res.guardFee, '0'), true);
        });
    });

    describe('maybeRunControllerGuard — control flow', function () {
        it('no controller bound → skip (no error/fee, guard never runs)', async function () {
            const calls = [];
            const res = await util.maybeRunControllerGuard(mkActions(null, calls), mkDb(null), {
                actionType: 'SEND', tick: 'AAA', from: 'addr1', to: 'addr2', amount: '10',
                data: Object.assign({}, BASE), gasInfo: null, gasBalances: []
            });
            assert.deepStrictEqual(res, { error: null, guardFee: 0, payoutLegs: null });
            assert.strictEqual(calls.length, 0);
        });

        it('unmapped action → skip even when a controller exists', async function () {
            const calls = [];
            const res = await util.maybeRunControllerGuard(mkActions(null, calls), mkDb({ contract_index: 9, is_unbind: 0 }), {
                actionType: 'WHATEVER', tick: 'AAA', data: Object.assign({}, BASE), gasInfo: null, gasBalances: []
            });
            assert.strictEqual(res.error, null);
            assert.strictEqual(calls.length, 0);
        });

        it('controller ALLOW → guardFee derived from gasBilled, guard called with the controller index', async function () {
            const calls = [];
            const res = await util.maybeRunControllerGuard(
                mkActions({ allow: true, reason: null, gasBilled: 1000 }, calls),
                mkDb({ contract_index: 9, is_unbind: 0, cooldown_blocks: 0 }),
                { actionType: 'SEND', tick: 'AAA', from: 'addr1', to: 'addr2', amount: '10',
                  data: Object.assign({}, BASE), gasInfo: null, gasBalances: [] }
            );
            assert.strictEqual(res.error, null);
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].controllerIndex, 9);
            assert.strictEqual(util.bcgt(res.guardFee, '0'), true); // 1000 * 0.00001 > 0
        });

        it('controller DENY → error = the guard reason, no fee', async function () {
            const res = await util.maybeRunControllerGuard(
                mkActions({ allow: false, reason: 'controller (revert)', gasBilled: 500 }, []),
                mkDb({ contract_index: 9, is_unbind: 0 }),
                { actionType: 'SEND', tick: 'AAA', data: Object.assign({}, BASE), gasInfo: null, gasBalances: [] }
            );
            assert.strictEqual(res.error, 'controller (revert)');
            assert.strictEqual(res.guardFee, 0);
        });

        it('insufficient guard gas → error, guard never runs', async function () {
            const calls = [];
            const res = await util.maybeRunControllerGuard(
                mkActions({ allow: true, reason: null, gasBilled: 0 }, calls),
                mkDb({ contract_index: 9, is_unbind: 0 }),
                { actionType: 'SEND', tick: 'AAA', data: Object.assign({}, BASE),
                  gasInfo: { TICK_ID: 'GASID' }, gasBalances: [] } // empty balances → reservation fails
            );
            assert.strictEqual(res.error, 'insufficient funds (guard gas)');
            assert.strictEqual(calls.length, 0);
        });

        it('no guard-of-guard: a controller emitting its OWN token is not re-guarded', async function () {
            const calls = [];
            const data = Object.assign({}, BASE, { IS_GUARD_EMISSION: true, EMITTER: 9 }); // emitter == controller
            const res = await util.maybeRunControllerGuard(
                mkActions({ allow: false, reason: 'must-not-run', gasBilled: 0 }, calls),
                mkDb({ contract_index: 9, is_unbind: 0 }),
                { actionType: 'SEND', tick: 'AAA', data, gasInfo: null, gasBalances: [] }
            );
            assert.deepStrictEqual(res, { error: null, guardFee: 0, payoutLegs: null });
            assert.strictEqual(calls.length, 0);
        });

        it('cross-token guard emission IS still guarded (emitter != controller)', async function () {
            const calls = [];
            const data = Object.assign({}, BASE, { IS_GUARD_EMISSION: true, EMITTER: 7 }); // different controller (9)
            await util.maybeRunControllerGuard(
                mkActions({ allow: true, reason: null, gasBilled: 100 }, calls),
                mkDb({ contract_index: 9, is_unbind: 0 }),
                { actionType: 'SEND', tick: 'AAA', data, gasInfo: null, gasBalances: [] }
            );
            assert.strictEqual(calls.length, 1);
        });

        it('records the consulted tick on data._GUARDED_TICKS (completeness-assertion signal)', async function () {
            const data = Object.assign({}, BASE);
            await util.maybeRunControllerGuard(
                mkActions({ allow: true, reason: null, gasBilled: 0 }, []),
                mkDb({ contract_index: 9, is_unbind: 0 }),
                { actionType: 'SEND', tick: 'AAA', data, gasInfo: null, gasBalances: [] }
            );
            assert.ok(data._GUARDED_TICKS && data._GUARDED_TICKS['AAA'] === true);
        });
    });

    // ─── CONTROLLER_GUARD activation gate (consensus) ────────────────────────
    // The guard is a NEW acceptance + ledger rule: a node version that runs it and one that
    // does not settle the SAME guarded action differently (allow/deny + payout_legs vs plain),
    // forking the ledger and the per-block contract_hash on the first guarded action. Below the
    // CONTROLLER_GUARD flag-day _invokeController must be a STRICT no-op on every node — no VM
    // guard run, no fee, no payout_legs — identical to a node that lacks the controller layer.
    // protocol_changes.test.js pins the real isEnabled() flag-day math; this block pins that the
    // enforcement chokepoint actually HONORS the gate (a deny-returning guard must NOT run, and a
    // royalty-attaching guard must NOT leak payout_legs, while below activation).
    describe('CONTROLLER_GUARD activation gate honored at the chokepoint', function () {
        const guardOpts = (data) => ({
            actionType: 'SEND', tick: 'AAA', from: 'addr1', to: 'addr2', amount: '10',
            data, gasInfo: null, gasBalances: []
        });

        it('below activation → strict no-op: guard never runs, no fee, no payout_legs', async function () {
            const calls = [];
            const res = await util.maybeRunControllerGuard(
                // A guard that WOULD deny + attach royalties — proving none of it takes effect below the gate.
                mkActions({ allow: false, reason: 'must-not-run', gasBilled: 9999, payoutLegs: [{ to: 'x', bps: 500 }] }, calls, false),
                mkDb({ contract_index: 9, is_unbind: 0 }),
                guardOpts(Object.assign({}, BASE))
            );
            assert.deepStrictEqual(res, { error: null, guardFee: 0, payoutLegs: null });
            assert.strictEqual(calls.length, 0, 'guard VM must not run below the flag-day');
        });

        it('below activation → address-side controller is also a strict no-op', async function () {
            const calls = [];
            const mkAddrDb = { config: { GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: 200000 }, GAS_PRICE: '0.00001', GAS: 'XCHAIN' },
                getAddressId: async () => 1, getEffectiveAddressController: async () => ({ contract_index: 9, is_unbind: 0 }) };
            const res = await util.maybeRunAddressControllerGuard(
                mkActions({ allow: false, reason: 'must-not-run', gasBilled: 9999 }, calls, false),
                mkAddrDb,
                { actionType: 'SEND', actionClass: 'transfer', address: 'addrB', from: 'addrA', to: 'addrB',
                  tick: 'AAA', amount: '10', data: Object.assign({}, BASE), gasInfo: null, gasBalances: [] }
            );
            assert.deepStrictEqual(res, { error: null, guardFee: 0, payoutLegs: null });
            assert.strictEqual(calls.length, 0);
        });

        it('at/above activation → guard runs, can deny, and surfaces payout_legs', async function () {
            const calls = [];
            const res = await util.maybeRunControllerGuard(
                mkActions({ allow: true, reason: null, gasBilled: 1000, payoutLegs: [{ to: 'royaltyAddr', bps: 500 }] }, calls, true),
                mkDb({ contract_index: 9, is_unbind: 0 }),
                guardOpts(Object.assign({}, BASE))
            );
            assert.strictEqual(res.error, null);
            assert.strictEqual(calls.length, 1, 'guard VM must run at/above the flag-day');
            assert.deepStrictEqual(res.payoutLegs, [{ to: 'royaltyAddr', bps: 500 }]);
        });
    });
});
