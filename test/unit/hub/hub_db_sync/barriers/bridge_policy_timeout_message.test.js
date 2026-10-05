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
// The bridge barrier's timeout message: above the height-map activation it names the
// admission height shortfall and omits the clock mirror time, below it keeps the old text.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

function makeSync(admissionActive) {
    const doQuery = sinon.stub().callsFake(async (sql, args) =>
        /information_schema\.TABLES/i.test(sql) ? [{ TABLE_NAME: args[0] }] : [{ ts: 1234 }]);
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', coin: 'BTC' });
    sinon.stub(sync, 'admissionActiveAt').returns(admissionActive);
    return sync;
}

async function timeoutMessage(sync) {
    try {
        await sync.waitForBridgeSync(5000, 1, 800);
        return null;
    } catch (e) {
        return e.message;
    }
}

describe('bridge barrier timeout message', function () {
    it('above the activation names the admission height and drops the mirror time', async function () {
        const message = await timeoutMessage(makeSync(true));
        assert.strictEqual(message,
            'bridge sync barrier timed out after 1ms' +
            ' (admission height bridge_transfers.BTC at none, needs 796)');
    });

    it('below the activation keeps the mirror time text', async function () {
        const message = await timeoutMessage(makeSync(false));
        assert.strictEqual(message,
            'bridge sync barrier timed out after 1ms waiting for block_time 5000' +
            ' (bridge mirror at 1234)');
    });
});
