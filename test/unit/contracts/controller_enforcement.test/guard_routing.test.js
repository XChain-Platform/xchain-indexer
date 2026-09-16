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
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/contracts/controller_enforcement.test/guard_routing.test.js
 *
 * The routing half of the enforcement suite: which action reaches which controller
 * class, that the guard actually runs once it is reached, and that the
 * CONTROLLER_GUARD activation gate is honoured at the same chokepoint for both the
 * recipient-side and SOURCE-outbound guards. Why the suite fakes the db and actions
 * layers instead of running a VM is written down in controller_enforcement.test.js;
 * this file keeps that suite's title, so every full test title reads unchanged.
 ********************************************************************/

const assert = require('assert');
const { util, BASE, mkDb, mkActions, guardOpts } = require('./helpers/controller_fixture');

describe('Programmable policy layer : Phase B enforcement @regression', function () {
    describe('maybeRunControllerGuard : control flow', function () {
        // MINT and STAKE route to their own classes, and their handlers call
        // the guard: mint.js / stake.js v3 invoke maybeRunControllerGuard, so a `mint`/`stake`
        // (or `all`-fallback) binding gates supply creation / contract staking. Pin that the helper
        // routes each action to its class and actually runs the guard (the guard is live, not inert).
        function mkClassCapturingDb(effective, captured){
            return {
                config: { GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: 200000 }, GAS_PRICE: '0.00001', GAS: 'XCHAIN' },
                getTickerId: async () => 1,
                getEffectiveTokenController: async () => effective,
                getEffectiveTokenControllerForGuard: async (id, cls) => { captured.push(cls); return effective; }
            };
        }
        for (const [action, cls] of [['MINT', 'mint'], ['STAKE', 'stake']]) {
            it(`${action} routes to the '${cls}' class and invokes the guard (stub now live)`, async function () {
                const calls = [], captured = [];
                const res = await util.maybeRunControllerGuard(
                    mkActions({ allow: true, reason: null, gasBilled: 1000 }, calls),
                    mkClassCapturingDb({ contract_index: 9, is_unbind: 0 }, captured),
                    { actionType: action, tick: 'AAA', from: 'addr1', amount: '10',
                      data: Object.assign({}, BASE), gasInfo: null, gasBalances: [] }
                );
                assert.deepStrictEqual(captured, [cls], `must resolve the '${cls}' controller class`);
                assert.strictEqual(calls.length, 1, 'guard must run (no longer an inert stub)');
                assert.strictEqual(res.error, null);
                assert.strictEqual(util.bcgt(res.guardFee, '0'), true);
            });
            it(`${action} controller DENY reverts the action`, async function () {
                const res = await util.maybeRunControllerGuard(
                    mkActions({ allow: false, reason: `${cls} refused`, gasBilled: 0 }, []),
                    mkClassCapturingDb({ contract_index: 9, is_unbind: 0 }, []),
                    { actionType: action, tick: 'AAA', data: Object.assign({}, BASE), gasInfo: null, gasBalances: [] }
                );
                assert.strictEqual(res.error, `${cls} refused`);
                assert.strictEqual(res.guardFee, 0);
            });
        }
    });
});

describe('Programmable policy layer : Phase B enforcement @regression', function () {
    // The SOURCE-outbound self-gate calls maybeRunAddressControllerGuard with the SENDER's
    // own address as the subject (symmetric `transfer` binding : same call, address = SOURCE). Pin
    // that the helper gates an outbound move by the source account's own controller.
    describe('maybeRunAddressControllerGuard : SOURCE-outbound self-gate (symmetric transfer)', function () {
        function mkAddrDb(effective, capturedIds){
            return {
                config: { GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: 200000 }, GAS_PRICE: '0.00001', GAS: 'XCHAIN' },
                getAddressId: async (a) => { if (capturedIds) capturedIds.push(a); return 1; },
                getEffectiveAddressController: async () => effective,
                getEffectiveAddressControllerForGuard: async () => effective
            };
        }
        const outboundOpts = {
            actionType: 'SEND', actionClass: 'transfer', address: 'addrA',
            from: 'addrA', to: 'addrB', tick: 'AAA', amount: '10',
            data: Object.assign({}, BASE), gasInfo: null, gasBalances: []
        };

        it('SOURCE-bound transfer controller DENY → reverts the outbound send', async function () {
            const ids = [];
            const res = await util.maybeRunAddressControllerGuard(
                mkActions({ allow: false, reason: 'outbound blocked', gasBilled: 100 }, []),
                mkAddrDb({ contract_index: 12, is_unbind: 0 }, ids), outboundOpts);
            assert.strictEqual(res.error, 'outbound blocked');
            assert.deepStrictEqual(ids, ['addrA'], 'resolves against the SOURCE account');
        });

        it('SOURCE-bound transfer controller ALLOW → guardFee, guard ran on the source contract', async function () {
            const calls = [];
            const res = await util.maybeRunAddressControllerGuard(
                mkActions({ allow: true, reason: null, gasBilled: 1000 }, calls),
                mkAddrDb({ contract_index: 12, is_unbind: 0 }), outboundOpts);
            assert.strictEqual(res.error, null);
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].controllerIndex, 12);
            assert.strictEqual(util.bcgt(res.guardFee, '0'), true);
        });
    });
});

describe('Programmable policy layer : Phase B enforcement @regression', function () {
    // ─── CONTROLLER_GUARD activation gate (consensus) ────────────────────────
    // The guard is a NEW acceptance + ledger rule: a node version that runs it and one that
    // does not settle the SAME guarded action differently (allow/deny + payout_legs vs plain),
    // forking the ledger and the per-block contract_hash on the first guarded action. Below the
    // CONTROLLER_GUARD flag-day invokeController must be a STRICT no-op on every node : no VM
    // guard run, no fee, no payout_legs : identical to a node that lacks the controller layer.
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
                // A guard that WOULD deny + attach royalties : proving none of it takes effect below the gate.
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
            mkAddrDb.getEffectiveAddressControllerForGuard = async () => ({ contract_index: 9, is_unbind: 0 });
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

