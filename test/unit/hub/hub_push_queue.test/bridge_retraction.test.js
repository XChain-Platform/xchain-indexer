// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// HubPushQueue drain of the bridge_retraction rows rollback.js parks when its live
// pushbridgereorg fails: the row rides its own hub rail with the closed-range ceiling
// and generation fence, exactly as the price, XCALL and match retractions do.
// Part of the HubPushQueue suite; see ../hub_push_queue.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert       = require('assert');
const sinon        = require('sinon');
const HubPushQueue = require('../../../../src/hub/hub_push_queue.js');
const { makeIndexer, makeRow } = require('./helpers/fixtures.js');

describe('HubPushQueue', function(){

    afterEach(function(){
        sinon.restore();
    });

    describe('_attempt()', function(){
        // ─── bridge_retraction (reorg orphans an XBRIDGE lock or burn) ─────
        it('calls retractBridgeRange for bridge_retraction rows with the ceiling + generation fence and marks delivered', async function(){
            let indexer = makeIndexer();
            let q = new HubPushQueue(indexer);
            await q.attempt(makeRow({ id: 11, push_type: 'bridge_retraction', payload: JSON.stringify({ coin: 'BTC', action_index: 158, last_action_index: 159, retraction_generation: 6 }) }));
            assert.deepStrictEqual(indexer.hubClient.retractBridgeRange.firstCall.args, ['BTC', 158, 159, 6]);
            // The bridge row rides its own rail: none of the sibling retractions is sent for it.
            assert.strictEqual(indexer.hubClient.retractMatchRange.callCount, 0);
            assert.strictEqual(indexer.hubClient.retractXcallRange.callCount, 0);
            assert.strictEqual(indexer.hubClient.retractPriceRange.callCount, 0);
            assert.strictEqual(indexer.indexerDb.markHubPushDelivered.calledWith(11), true);
            assert.strictEqual(indexer.indexerDb.recordHubPushAttempt.callCount, 0,
                'a dispatched bridge retraction must never be recorded as an unknown push_type');
        });
    });
});
