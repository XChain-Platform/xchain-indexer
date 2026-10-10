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
 * Unit: smoke /status stall-health copy parity
 */

'use strict';

const assert = require('assert');
const canonical = require('../../../src/XChainIndexer/stall_health.js');
const { stallHealthCopies: smoke } = require('../../smoke/connected/api_status.test/helpers/status_app.js');

describe('smoke status stall-health parity', function () {
    const NOW = 1_000_000_000;
    const GRACE_VALUES = [0, 120000, NaN];
    const REASONS = [null, '', 'price_sync_barrier', 'vm_executor_unavailable', 'bridge_proof_barrier'];
    const COMMIT_TIMES = [null, NOW - 120001, NOW - 120000, NOW - 1, NOW + 1];
    const CLEAR_TIMES = [undefined, null, NaN, -Infinity, NOW - 1, NOW, NOW + 1, Infinity, 'soon'];

    function assertParity(name, cases) {
        assert.strictEqual(typeof smoke[name], 'function', `smoke copy ${name} must be exported`);
        assert.strictEqual(typeof canonical[name], 'function', `canonical ${name} must be exported`);
        for (const args of cases) {
            assert.strictEqual(
                smoke[name](...args),
                canonical[name](...args),
                `${name} differs for ${JSON.stringify(args)}`
            );
        }
    }

    it('keeps stallWedged identical across reason, grace, commit, and clear boundaries', function () {
        const cases = [];
        for (const reason of REASONS) {
            for (const committedAt of COMMIT_TIMES) {
                for (const graceMs of GRACE_VALUES) {
                    for (const clearsAt of CLEAR_TIMES)
                        cases.push([reason, committedAt, graceMs, NOW, clearsAt]);
                }
            }
        }
        assertParity('stallWedged', cases);
    });

    it('keeps waitingOnFutureBlock identical across reason and clear boundaries', function () {
        const cases = [];
        for (const reason of REASONS) {
            for (const clearsAt of CLEAR_TIMES)
                cases.push([reason, clearsAt, NOW]);
        }
        assertParity('waitingOnFutureBlock', cases);
    });

    it('keeps stallClassOf identical across every classification boundary', function () {
        const cases = [];
        for (const reason of REASONS) {
            for (const committedAt of COMMIT_TIMES) {
                for (const graceMs of GRACE_VALUES) {
                    for (const clearsAt of CLEAR_TIMES)
                        cases.push([reason, committedAt, graceMs, NOW, clearsAt]);
                }
            }
        }
        assertParity('stallClassOf', cases);
    });

    it('keeps atProcessableTip identical across sync, reason, and clear boundaries', function () {
        const cases = [];
        for (const isSynced of [false, true, 0, 1]) {
            for (const reason of REASONS) {
                for (const clearsAt of CLEAR_TIMES)
                    cases.push([isSynced, reason, clearsAt, NOW]);
            }
        }
        assertParity('atProcessableTip', cases);
    });
});
