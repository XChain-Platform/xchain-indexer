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
 * The hub_push_delivered field of getlatestblock: the highest committed block
 * below which every hub push is acknowledged, derived from the durable outbox.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const observability = require('../../../../src/observability/index.js');
const hubPushes = require('../../../../src/db/hub_pushes/index.js');
const { buildSystemRpc } = require('../../../../src/api/rpc/system.js');
const { recordingView, fakeIndexer } = require('./helpers/fake_indexer.js');

// A view whose frontier is computed by the real query method over canned push rows.
// Acknowledged rows model the outbox's delete-on-delivery lifecycle; a null block is
// an undelivered push whose action no longer exists.
function outboxView(rows, tip) {
    const db = Object.create(hubPushes);
    db.poolQuery = async () => {
        const pending = rows.filter(r => !r.acknowledged);
        const blocks = pending.map(r => r.block).filter(b => b != null);
        return [{
            undelivered: pending.length,
            min_block:   blocks.length ? Math.min(...blocks) : null,
            unresolved:  pending.filter(r => r.block == null).length,
        }];
    };
    return recordingView({
        getLatestBlockIndex: tip,
        getHubPushDeliveryFrontier: () => db.getHubPushDeliveryFrontier(),
        getBlockTime: (b) => 1000 + b,
    });
}

function rpcFor(view) {
    return buildSystemRpc({ indexer: fakeIndexer({ view }), liveness: {} });
}

describe('getlatestblock hub_push_delivered @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('an undelivered push at 100 holds delivery at 99 even with delivered pushes at 101', async function () {
        const rows = [
            { action_index: 7, block: 100 },
            { action_index: 8, block: 101, acknowledged: true },
            { action_index: 9, block: 101, acknowledged: true },
        ];
        const res = await rpcFor(outboxView(rows, 105)).getlatestblock();
        assert.deepStrictEqual(res.hub_push_delivered, { block: 99, protocol_time: 1099 });
    });

    it('an empty outbox reports the committed tip', async function () {
        const res = await rpcFor(outboxView([], 105)).getlatestblock();
        assert.deepStrictEqual(res.hub_push_delivered, { block: 105, protocol_time: 1105 });
    });

    it('a failed read reports null', async function () {
        sinon.stub(observability.getLogger(), 'error');
        const view = recordingView({
            getLatestBlockIndex: 105,
            getHubPushDeliveryFrontier: () => { throw new Error('ECONNREFUSED'); },
        });
        const res = await rpcFor(view).getlatestblock();
        assert.strictEqual(res.hub_push_delivered, null);
        assert.strictEqual(res.block_index, 105);
    });

    it('an undelivered push whose action is gone reports null', async function () {
        const res = await rpcFor(outboxView([{ action_index: 9, block: null }], 105)).getlatestblock();
        assert.strictEqual(res.hub_push_delivered, null);
    });

    it('an unresolvable block time reports null', async function () {
        const view = recordingView({
            getLatestBlockIndex: 105,
            getHubPushDeliveryFrontier: { undelivered: 0, min_block: null, unresolved: 0 },
            getBlockTime: false,
        });
        assert.strictEqual((await rpcFor(view).getlatestblock()).hub_push_delivered, null);
    });
});
