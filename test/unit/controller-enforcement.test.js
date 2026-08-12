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
 * Programmable policy layer: Phase B enforcement helper.
 *
 * Utility.maybeRunControllerGuard is the single enforcement point the token handlers
 * (SEND/ORDER/SWAP/DISPENSER) call at their validated→settlement boundary. These tests
 * pin its CONTROL FLOW with fakes (fake db.getEffectiveTokenController + fake
 * actions.actionExecute.runControllerGuard); no DB, no VM, so they run on any Node.
 * The real guard run (VM execution, gas metering) is exercised on a separate regtest venue.
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
        getEffectiveTokenController: async () => effective,
        // Enforcement resolves via the *ForGuard fallback resolver; the control-flow tests below
        // don't exercise the 'all' fallback, so it delegates to the same effective row.
        getEffectiveTokenControllerForGuard: async () => effective
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

describe('Programmable policy layer : Phase B enforcement @regression', function () {

    describe('controllerActionClass : static action→class map', function () {
        it('SEND → transfer', function () {
            assert.strictEqual(util.controllerActionClass('SEND'), 'transfer');
        });
        it('AIRDROP/DIVIDEND/SWEEP → transfer (bulk outbound moves are gated too)', function () {
            for (const a of ['AIRDROP', 'DIVIDEND', 'SWEEP'])
                assert.strictEqual(util.controllerActionClass(a), 'transfer');
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
        it('SWEEP_OWNERSHIP → ownership (deed-over gated apart from balance transfer)', function () {
            assert.strictEqual(util.controllerActionClass('SWEEP_OWNERSHIP'), 'ownership');
            // The plain SWEEP (balance move) stays on `transfer`, so binding one class never
            // silently gates the other.
            assert.strictEqual(util.controllerActionClass('SWEEP'), 'transfer');
        });
        it('an unmapped action → null (never gated)', function () {
            for (const a of ['ATTEST', 'XCALL', 'ISSUE', 'EXECUTE', ''])
                assert.strictEqual(util.controllerActionClass(a), null);
        });
    });

    describe('maybeRunAddressControllerGuard : recipient/account-side', function () {
        function mkAddrDb(effective){
            return {
                config: { GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: 200000 }, GAS_PRICE: '0.00001', GAS: 'XCHAIN' },
                getAddressId: async () => 1,
                getEffectiveAddressController: async () => effective,
                getEffectiveAddressControllerForGuard: async () => effective
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

    describe('maybeRunControllerGuard : control flow', function () {
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

        // Phase C: MINT and STAKE were routable-but-never-invoked stubs (the handlers didn't call
        // the guard). mint.js / stake.js v3 now invoke maybeRunControllerGuard, so a `mint`/`stake`
        // (or `all`-fallback) binding gates supply creation / contract staking. Pin that the helper
        // routes each action to its class and actually runs the guard (no longer inert).
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

    // Phase C: the SOURCE-outbound self-gate calls maybeRunAddressControllerGuard with the SENDER's
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

    // ─── CONTROLLER_GUARD activation gate (consensus) ────────────────────────
    // The guard is a NEW acceptance + ledger rule: a node version that runs it and one that
    // does not settle the SAME guarded action differently (allow/deny + payout_legs vs plain),
    // forking the ledger and the per-block contract_hash on the first guarded action. Below the
    // CONTROLLER_GUARD flag-day _invokeController must be a STRICT no-op on every node : no VM
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

    // ─── feequote GUARD_INERT : the public dry-run must never enter the controller VM ─────
    // computeFeeQuote runs the REAL handler under a forced rollback while holding the block-loop
    // tx mutex; without this a controlled SEND/ORDER/... quoted on the unauthenticated `feequote`
    // endpoint would run caller-influenced contract code (the same class FEE_QUOTE_DENYLIST blocks
    // for DEPLOY/EXECUTE), reachable today on testnet/regtest where CONTROLLER_GUARD is genesis-
    // active. The marker rides only computeFeeQuote's synthetic tx (data['GUARD_INERT']), so these
    // pin: it refuses at the shared chokepoint ONLY when a guard would truly run, it does NOT gag a
    // real guarded action (block processing / feequotedryrun), and it never turns the below-flag-day
    // no-op into a spurious DENY.
    describe('feequote GUARD_INERT : public dry-run must not enter the controller VM', function () {
        const guardOpts = (data) => ({
            actionType: 'SEND', tick: 'AAA', from: 'addr1', to: 'addr2', amount: '10',
            data, gasInfo: null, gasBalances: []
        });

        it('GUARD_INERT + at/above activation → refuses with the sentinel, guard VM never runs', async function () {
            const calls = [];
            const res = await util.maybeRunControllerGuard(
                // A guard that WOULD allow: proving the VM is not entered regardless of verdict.
                mkActions({ allow: true, reason: null, gasBilled: 1000 }, calls, true),
                mkDb({ contract_index: 9, is_unbind: 0 }),
                guardOpts(Object.assign({}, BASE, { GUARD_INERT: true }))
            );
            assert.strictEqual(res.error, 'FEE_QUOTE_CONTROLLER_UNSUPPORTED');
            assert.strictEqual(res.guardFee, 0);
            assert.strictEqual(calls.length, 0, 'controller VM must not run for a guard-inert feequote dry-run');
        });

        it('address-side guard is refused under GUARD_INERT too (both kinds share _invokeController)', async function () {
            const calls = [];
            const addrDb = { config: { GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: 200000 }, GAS_PRICE: '0.00001', GAS: 'XCHAIN' },
                getAddressId: async () => 1, getEffectiveAddressController: async () => ({ contract_index: 9, is_unbind: 0 }),
                getEffectiveAddressControllerForGuard: async () => ({ contract_index: 9, is_unbind: 0 }) };
            const res = await util.maybeRunAddressControllerGuard(
                mkActions({ allow: true, reason: null, gasBilled: 1000 }, calls, true),
                addrDb,
                { actionType: 'SEND', actionClass: 'transfer', address: 'addrB', from: 'addrA', to: 'addrB',
                  tick: 'AAA', amount: '10', data: Object.assign({}, BASE, { GUARD_INERT: true }), gasInfo: null, gasBalances: [] }
            );
            assert.strictEqual(res.error, 'FEE_QUOTE_CONTROLLER_UNSUPPORTED');
            assert.strictEqual(calls.length, 0);
        });

        it('a normal (non-inert) guarded action still runs the VM (fix does not gag block processing / feequotedryrun)', async function () {
            const calls = [];
            const res = await util.maybeRunControllerGuard(
                mkActions({ allow: true, reason: null, gasBilled: 1000 }, calls, true),
                mkDb({ contract_index: 9, is_unbind: 0 }),
                guardOpts(Object.assign({}, BASE)) // GUARD_INERT absent → real path
            );
            assert.strictEqual(res.error, null);
            assert.strictEqual(calls.length, 1, 'a real guarded action must still run its controller VM');
        });

        it('GUARD_INERT below the CONTROLLER_GUARD flag-day stays a strict no-op (gate wins, no sentinel)', async function () {
            const calls = [];
            const res = await util.maybeRunControllerGuard(
                mkActions({ allow: false, reason: 'must-not-run', gasBilled: 9999 }, calls, false), // gate disabled
                mkDb({ contract_index: 9, is_unbind: 0 }),
                guardOpts(Object.assign({}, BASE, { GUARD_INERT: true }))
            );
            // Below activation the guard is already a no-op for everyone; GUARD_INERT must not
            // upgrade that to a DENY, or a below-flag-day quote would misreport a controlled token.
            assert.deepStrictEqual(res, { error: null, guardFee: 0, payoutLegs: null });
            assert.strictEqual(calls.length, 0);
        });
    });

    // ─── 'all' action-class : most-specific-wins fallback (resolution) ───────────
    // getEffective*ControllerForGuard is the enforcement resolver: try the action's specific class,
    // then fall back to a catch-all 'all' binding. Exactly one row out (one guard runs, no stacking).
    // Tested against the REAL db.js method (prototype-called over a fake exact getter : no DB needed)
    // so the actual composition is pinned. The exact getters stay fallback-free (bind validation needs
    // them) : that separation is what lets a specific class OVERRIDE an 'all' binding.
    describe("getEffective*ControllerForGuard : 'all' fallback (most-specific-wins)", function () {
        const Database = require('../../src/db.js');
        // fake `this`: exact getter returns the row registered for a (key, class), else null.
        function resolver(rowsByClass){
            return { getEffectiveTokenController: async (id, cls) => (cls in rowsByClass ? rowsByClass[cls] : null) };
        }
        const ALL  = { contract_index: 1, is_unbind: 0 };
        const SPEC = { contract_index: 2, is_unbind: 0 };
        const callForGuard = (self, cls) =>
            Database.prototype.getEffectiveTokenControllerForGuard.call(self, 9, cls, 100, 5);

        it('specific-class binding overrides the catch-all (most-specific wins)', async function () {
            const res = await callForGuard(resolver({ transfer: SPEC, all: ALL }), 'transfer');
            assert.strictEqual(res.contract_index, 2);
        });
        it("'all'-only binding gates a class with no specific controller (fallback)", async function () {
            const res = await callForGuard(resolver({ all: ALL }), 'trade');
            assert.strictEqual(res.contract_index, 1);
        });
        it('no binding at all → null', async function () {
            const res = await callForGuard(resolver({}), 'burn');
            assert.strictEqual(res, null);
        });
        it("action_class === 'all' never self-recurses (single exact lookup, no fallback tail)", async function () {
            let calls = [];
            const self = { getEffectiveTokenController: async (id, cls) => { calls.push(cls); return null; } };
            const res = await Database.prototype.getEffectiveTokenControllerForGuard.call(self, 9, 'all', 100, 5);
            assert.strictEqual(res, null);
            assert.deepStrictEqual(calls, ['all'], "must do exactly one lookup for 'all', no fallback");
        });
        it('the Address twin resolves identically', async function () {
            const self = { getEffectiveAddressController: async (id, cls) => (cls === 'all' ? ALL : null) };
            const res = await Database.prototype.getEffectiveAddressControllerForGuard.call(self, 9, 'transfer', 100, 5);
            assert.strictEqual(res.contract_index, 1);
        });
    });
});
