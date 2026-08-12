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
 * Shared test-timing helpers.
 *
 * The single home for setTimeout-as-a-promise across the test tree. A test that
 * waits for something to HAPPEN should poll for it with waitUntil(); a fixed
 * sleep long enough to be safe on a loaded box is dead time on every green run,
 * and one short enough to be quick is the flake. Reach for sleep() only when
 * there is nothing to poll — chiefly a case asserting an event did NOT happen
 * within a window, which has no predicate that ever becomes true.
 */

'use strict';

/**
 * A fixed delay expressed as a promise. This is the one sanctioned raw
 * setTimeout in the test tree; prefer waitUntil() unless you are deliberately
 * settling for a fixed window (e.g. asserting an absence).
 *
 * @param {number} ms  milliseconds to wait
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `predicate` every `intervalMs` until it returns truthy or `timeoutMs`
 * elapses. Returns the predicate's final boolean; NEVER throws on timeout, so
 * the caller decides what a timeout means (assert on the return). The predicate
 * may be sync or async.
 *
 * @param {() => (boolean|Promise<boolean>)} predicate
 * @param {number} [timeoutMs=5000]
 * @param {number} [intervalMs=25]
 * @returns {Promise<boolean>} true if the predicate fired within the budget
 */
async function waitUntil(predicate, timeoutMs = 5000, intervalMs = 25) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await sleep(intervalMs);
    }
    return Boolean(await predicate()); // one final check after the deadline
}

module.exports = { sleep, waitUntil };
