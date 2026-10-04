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
 ********************************************************************/

'use strict';

const DEFAULT_RECONNECT_ATTEMPTS = 3;
const DEFAULT_MIN_DWELL_MS = 120000;

function createMovePolicy(options = {}) {
    const reconnectAttempts = Number.isInteger(options.reconnectAttempts) && options.reconnectAttempts > 0
        ? options.reconnectAttempts : DEFAULT_RECONNECT_ATTEMPTS;
    const minDwellMs = Number.isInteger(options.minDwellMs) && options.minDwellMs >= 0
        ? options.minDwellMs : DEFAULT_MIN_DWELL_MS;
    const now = options.now === undefined ? Date.now : options.now;

    let lastMoveAt = null;
    let moveReason = null;
    let moveCount = 0;
    let failureStreak = 0;

    function dwellPassed() {
        return lastMoveAt === null || now() - lastMoveAt >= minDwellMs;
    }

    return {
        onConnectFailure(candidateCount) {
            failureStreak += 1;
            return failureStreak >= reconnectAttempts && candidateCount > 1 && dwellPassed()
                ? 'move' : 'retry';
        },

        onStall(candidateCount) {
            if (candidateCount <= 1) return 'exit';
            return dwellPassed() ? 'move' : 'hold';
        },

        noteConnected() {
            failureStreak = 0;
        },

        noteMove(reason) {
            failureStreak = 0;
            lastMoveAt = now();
            moveReason = reason;
            moveCount += 1;
        },

        status() {
            return { lastMoveAt, moveReason, moveCount, failureStreak };
        }
    };
}

module.exports = { createMovePolicy };
