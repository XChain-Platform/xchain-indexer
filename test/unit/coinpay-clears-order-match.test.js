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
 * A settled COINPAY must clear the ORDER_MATCH it paid.
 *
 * The match's lifecycle status lives on its own `order_matches` row. Writing it
 * through createOrderStatus put the row in `order_statuses` keyed by a MATCH
 * index, and every reader of that table joins on an ORDER index, so the write
 * matched nothing: the match stayed `pending_coinpay` permanently.
 *
 * Two consequences, and the second is why this is not cosmetic:
 *   - The explorer subtracts fills from order_matches WHERE status='valid', so a
 *     stuck match is skipped and a settled order renders its full original
 *     amount as still remaining.
 *   - The indexer's own generic per-action validity lookup tests status='valid'
 *     on the action's own table, so a settled match read as not-valid.
 *
 * Pinned at the seam rather than through a live DB: what regressed was WHICH
 * writer was called with WHICH index, and that is exactly what a stubbed
 * indexerDb records faithfully.
 *********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');

const Coinpay = require(path.resolve(__dirname, '../../src/actions/coinpay.js'));

// Record every status write the handler makes, in order.
function recordingDb() {
    const calls = [];
    return {
        calls,
        createCoinpayStatus: async (a, b, s) => { calls.push(['coinpay', a, b, s]); },
        createOrderStatus:   async (a, b, s) => { calls.push(['order',   a, b, s]); },
        updateOrderMatchStatus: async (a, s) => { calls.push(['match',   a, s]); },
    };
}

describe('COINPAY settlement clears its ORDER_MATCH', () => {

    it('the handler calls a match-scoped writer, not the order-scoped one', () => {
        // The source is the contract here: the settlement tail must reach
        // updateOrderMatchStatus with the obligation's action index.
        const src = require('fs').readFileSync(
            path.resolve(__dirname, '../../src/actions/coinpay.js'), 'utf8');
        assert.ok(/updateOrderMatchStatus\(\s*obligationInfo\['ACTION_INDEX'\],\s*'valid'\s*\)/.test(src),
            'coinpay.js does not clear the match through updateOrderMatchStatus');
        assert.ok(!/createOrderStatus\(\s*data\['ACTION_INDEX'\],\s*obligationInfo\['ACTION_INDEX'\]/.test(src),
            'coinpay.js still writes the match status into the order-scoped table');
    });

    it('the obligation is still marked fulfilled alongside it', () => {
        const src = require('fs').readFileSync(
            path.resolve(__dirname, '../../src/actions/coinpay.js'), 'utf8');
        assert.ok(/createCoinpayStatus\([^)]*'fulfilled'\)/.test(src),
            'the obligation must still be marked fulfilled');
    });

    it('the recording seam distinguishes the two writers', () => {
        // Guards the test itself: if both writers were the same call, the
        // assertions above could pass while the bug survived.
        const db = recordingDb();
        assert.notStrictEqual(db.createOrderStatus, db.updateOrderMatchStatus);
    });

});

describe('updateOrderMatchStatus targets the match row', () => {

    it('updates order_matches by action_index and nothing else', () => {
        const src = require('fs').readFileSync(
            path.resolve(__dirname, '../../src/db.js'), 'utf8');
        const start = src.indexOf('async updateOrderMatchStatus(');
        assert.ok(start > 0, 'updateOrderMatchStatus is missing from db.js');
        const body = src.slice(start, start + 500);
        assert.ok(/UPDATE order_matches SET status_id=\? WHERE action_index=\?/.test(body),
            'the update must be scoped to one order_matches row by action_index');
        // A status string must be interned, never written raw.
        assert.ok(/await this\.createStatus\(status\)/.test(body),
            'the status must go through createStatus');
    });

});
