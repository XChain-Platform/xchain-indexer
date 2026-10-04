// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');

const { createMovePolicy } = require('../../../../../src/hub/hub_db_sync/failover/move_policy.js');

function stubClock(start = 0) {
    let current = start;
    return {
        now: () => current,
        advance: (ms) => { current += ms; }
    };
}

describe('HubDbSync failover move policy', function () {
    it('moves on the third connection failure without applying dwell before the first move', function () {
        const clock = stubClock();
        const policy = createMovePolicy({ reconnectAttempts: 3, minDwellMs: 120000, now: clock.now });

        assert.strictEqual(policy.onConnectFailure(2), 'retry');
        assert.strictEqual(policy.onConnectFailure(2), 'retry');
        assert.strictEqual(policy.onConnectFailure(2), 'move');
    });

    it('never moves a sole candidate after failures and exits when that candidate stalls', function () {
        const policy = createMovePolicy({ reconnectAttempts: 1, minDwellMs: 0, now: () => 0 });

        assert.strictEqual(policy.onConnectFailure(1), 'retry');
        assert.strictEqual(policy.onConnectFailure(1), 'retry');
        assert.strictEqual(policy.onStall(1), 'exit');
    });

    it('retries failures during post-move dwell and moves on the next failure after dwell', function () {
        const clock = stubClock(1000);
        const policy = createMovePolicy({ reconnectAttempts: 3, minDwellMs: 100, now: clock.now });
        policy.noteMove('connect_failure');

        assert.strictEqual(policy.onConnectFailure(2), 'retry');
        assert.strictEqual(policy.onConnectFailure(2), 'retry');
        assert.strictEqual(policy.onConnectFailure(2), 'retry');
        clock.advance(100);
        assert.strictEqual(policy.onConnectFailure(2), 'move');
    });

    it('holds a stalled connection during post-move dwell', function () {
        const clock = stubClock(1000);
        const policy = createMovePolicy({ minDwellMs: 100, now: clock.now });
        policy.noteMove('stall');

        clock.advance(99);
        assert.strictEqual(policy.onStall(2), 'hold');
        clock.advance(1);
        assert.strictEqual(policy.onStall(2), 'move');
    });

    it('clears the connection failure streak after a successful connection', function () {
        const policy = createMovePolicy({ reconnectAttempts: 3, minDwellMs: 0, now: () => 0 });

        assert.strictEqual(policy.onConnectFailure(2), 'retry');
        assert.strictEqual(policy.onConnectFailure(2), 'retry');
        policy.noteConnected();
        assert.strictEqual(policy.status().failureStreak, 0);
        assert.strictEqual(policy.onConnectFailure(2), 'retry');
    });

    it('falls back to default reconnect and dwell settings when values are invalid', function () {
        const clock = stubClock();
        const policy = createMovePolicy({ reconnectAttempts: 0, minDwellMs: -1, now: clock.now });

        assert.strictEqual(policy.onConnectFailure(2), 'retry');
        assert.strictEqual(policy.onConnectFailure(2), 'retry');
        assert.strictEqual(policy.onConnectFailure(2), 'move');
        policy.noteMove('first');
        clock.advance(119999);
        assert.strictEqual(policy.onStall(2), 'hold');
        clock.advance(1);
        assert.strictEqual(policy.onStall(2), 'move');
    });

    it('tracks the latest move and cumulative move count', function () {
        const clock = stubClock(10);
        const policy = createMovePolicy({ now: clock.now });

        assert.deepStrictEqual(policy.status(), {
            lastMoveAt: null,
            moveReason: null,
            moveCount: 0,
            failureStreak: 0
        });
        policy.onConnectFailure(2);
        policy.noteMove('connect_failure');
        assert.deepStrictEqual(policy.status(), {
            lastMoveAt: 10,
            moveReason: 'connect_failure',
            moveCount: 1,
            failureStreak: 0
        });
        clock.advance(20);
        policy.noteMove('stall');
        assert.deepStrictEqual(policy.status(), {
            lastMoveAt: 30,
            moveReason: 'stall',
            moveCount: 2,
            failureStreak: 0
        });
    });
});
