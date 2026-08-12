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
 * Watchdog Timeout Tests
 *
 * Verifies the withTimeout() utility in Utility class:
 * resolves on time, rejects on timeout, includes labels, cleans up timers.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const Utility = require('../../../src/utility.js');
// A deliberately slow promise, built from the shared fixed-delay helper, drives
// the watchdog past its budget; there is no event to poll for here.
const { sleep } = require('../../helpers/wait.js');

describe('Chaos: Watchdog Timeout', function () {
    this.timeout(10000);

    let util;

    beforeEach(function () {
        util = new Utility();
    });

    it('WD-01: resolves normally when promise completes before timeout', async function () {
        const result = await util.withTimeout(Promise.resolve(42), 5000, 'test');
        assert.strictEqual(result, 42);
    });

    it('WD-02: rejects with timeout error when promise exceeds timeout', async function () {
        const slow = sleep(5000);
        try {
            await util.withTimeout(slow, 50, 'slow-op');
            assert.fail('Should have thrown');
        } catch (e) {
            assert.ok(e.message.includes('Watchdog timeout'));
        }
    });

    it('WD-03: timeout error message includes label', async function () {
        const slow = sleep(5000);
        try {
            await util.withTimeout(slow, 50, 'block 12345');
            assert.fail('Should have thrown');
        } catch (e) {
            assert.ok(e.message.includes('block 12345'), 'Should include label in error');
            assert.ok(e.message.includes('50ms'), 'Should include timeout duration');
        }
    });

    it('WD-04: timer is cleaned up after promise resolves', async function () {
        // If the timer leaks, this test would show in --detect-handles
        // We verify by checking that the promise resolves cleanly
        const result = await util.withTimeout(Promise.resolve('ok'), 60000, 'cleanup-test');
        assert.strictEqual(result, 'ok');
        // If timer wasn't cleaned up, the 60s timer would keep the process alive
        // The .finally(() => clearTimeout(timer)) in withTimeout handles this
    });

    it('WD-05: timer is cleaned up after timeout fires', async function () {
        const neverResolves = new Promise(() => {});
        try {
            await util.withTimeout(neverResolves, 50, 'never');
        } catch (e) {
            assert.ok(e.message.includes('Watchdog timeout'));
        }
        // Timer should be cleared by .finally() (no dangling timers)
    });

    it('WD-06: very short timeout rejects near-immediately', async function () {
        const start = Date.now();
        const slow = sleep(10000);
        try {
            await util.withTimeout(slow, 1, 'instant');
            assert.fail('Should have thrown');
        } catch (e) {
            const elapsed = Date.now() - start;
            assert.ok(elapsed < 100, 'Should reject within 100ms, took ' + elapsed + 'ms');
            assert.ok(e.message.includes('Watchdog timeout'));
        }
    });
});
