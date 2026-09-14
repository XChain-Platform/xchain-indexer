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
 * test/unit/controller_enforcement.test/guard_activation.test.js
 *
 * The activation half of the enforcement suite: the GUARD_INERT marker that keeps the
 * public feequote dry-run out of the controller VM without gagging real block
 * processing, and the most-specific-wins resolution of a class binding against the
 * 'all' catch-all. Why the suite fakes the db and actions layers instead of running a
 * VM is written down in controller_enforcement.test.js; this file keeps that suite's
 * title, so every full test title reads unchanged.
 ********************************************************************/

const assert = require('assert');
const { util, BASE, mkDb, mkActions, guardOpts } = require('./helpers/controller_fixture');

describe('Programmable policy layer : Phase B enforcement @regression', function () {
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
        it('GUARD_INERT + at/above activation → refuses with the sentinel, guard VM never runs', async function () {
            const calls = [];
            const res = await util.maybeRunControllerGuard(
                // A guard that WOULD allow: proving the VM is not entered regardless of verdict.
                mkActions({ allow: true, reason: null, gasBilled: 1000 }, calls, true),
                mkDb({ contract_index: 9, is_unbind: 0 }),
                guardOpts(Object.assign({}, BASE, { GUARD_INERT: true }))
            );
            // The sentinel carries the controller that declined; it stays a substring
            // match, which is how every consumer already reads it.
            assert.strictEqual(util.isGuardInertError(res.error), true, res.error);
            assert.ok(res.error.indexOf('contract 9') !== -1, 'names the controller: ' + res.error);
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
            assert.strictEqual(util.isGuardInertError(res.error), true, res.error);
            assert.ok(res.error.indexOf('address addrB') !== -1, 'names the bound address: ' + res.error);
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
    });
});

describe('Programmable policy layer : Phase B enforcement @regression', function () {
    describe('feequote GUARD_INERT : public dry-run must not enter the controller VM', function () {
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
        const Database = require('../../../src/db');
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

