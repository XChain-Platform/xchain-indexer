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
const sinon = require('sinon');
const AddressRetry = require('../../../../src/hub/hub_push_queue/address_retry.js');

function makeQueue(selector){
    return {
        indexer: { hubSelector: selector },
        indexerDb: {
            poolQuery: sinon.stub().resolves(),
            getPendingHubPushes: sinon.stub().resolves([])
        },
        hubClient: {},
        isDue: sinon.stub().returns(true)
    };
}

describe('HubPushQueue address retry', function(){
    afterEach(function(){ sinon.restore(); });

    it('reads a selector address from status when current is unavailable', function(){
        let queue = makeQueue({ status: () => ({ current: 'http://hub-a.test' }) });
        let retry = new AddressRetry(queue);

        assert.strictEqual(retry.currentSelectorAddress(), 'http://hub-a.test');
    });

    it('adopts the first available address without clearing attempts', async function(){
        let address = null;
        let queue = makeQueue({ current: () => address });
        let retry = new AddressRetry(queue);

        address = 'http://hub-a.test';
        assert.strictEqual(await retry.resetPendingAttemptsAfterMove(), false);
        assert.strictEqual(queue.indexerDb.poolQuery.callCount, 0);
    });

    it('resets persisted and fetched attempts when the address moves', async function(){
        let address = 'http://hub-a.test';
        let queue = makeQueue({ current: () => address });
        let retry = new AddressRetry(queue);
        let row = { attempts: 4, last_attempted_at: '2026-10-03T00:00:00.000Z', last_error: 'down' };

        address = 'http://hub-b.test';
        assert.strictEqual(await retry.resetPendingAttemptsAfterMove([row]), true);
        assert.strictEqual(queue.indexerDb.poolQuery.calledOnce, true);
        assert.deepStrictEqual(row, { attempts: 0, last_attempted_at: null, last_error: null });
    });
});
