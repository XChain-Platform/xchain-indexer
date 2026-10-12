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
 * The two XCALL mirror reads default a missing limit to XCALL_MAX_CALLS_PER_BLOCK,
 * never to a literal copy of its value. The constant equals 25 today, so the module is
 * reloaded with the export moved to another value to tell the constant from the literal.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../fixtures/config');
const Utility           = require('../../../src/utility');
const Database          = require('../../../src/db');

const CONSTANTS_PATH   = require.resolve('../../../src/protocol/constants.js');
const CROSS_CHAIN_PATH = require.resolve('../../../src/db/cross_chain/index.js');
const MOVED_CAP = 7;

function makeDb(hubDb) {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    if (hubDb) indexer.hubDb = hubDb;
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

// Load a fresh copy of the read methods while the exported cap reads MOVED_CAP. The
// constants module is looked up per call because other suites evict it from the cache.
function loadWithMovedCap() {
    const constants = require(CONSTANTS_PATH);
    const original  = constants.XCALL_MAX_CALLS_PER_BLOCK;
    const cached   = require.cache[CROSS_CHAIN_PATH];
    constants.XCALL_MAX_CALLS_PER_BLOCK = MOVED_CAP;
    delete require.cache[CROSS_CHAIN_PATH];
    try {
        return require(CROSS_CHAIN_PATH);
    } finally {
        constants.XCALL_MAX_CALLS_PER_BLOCK = original;
        if (cached) require.cache[CROSS_CHAIN_PATH] = cached;
        else delete require.cache[CROSS_CHAIN_PATH];
    }
}

function rows(n) {
    return Array.from({ length: n }, (_, i) => ({ call_id: 'c' + String(i).padStart(3, '0'), snapshot_block: i }));
}

describe('XCALL mirror reads default to the protocol cap @regression @tier1', function () {

    afterEach(() => sinon.restore());

    for (const limit of [undefined, 0, NaN]) {
        it('undispatched calls cap at XCALL_MAX_CALLS_PER_BLOCK for limit ' + String(limit), async function () {
            const fresh = loadWithMovedCap();
            const db = makeDb(null);
            sinon.stub(db, 'doQueryStrict').resolves(rows(30));
            sinon.stub(db, 'doQuery').resolves([]);
            const res = await fresh.getEffectiveUndispatchedCalls.call(db, 'BTC', 'regtest', 1700, limit, 100);
            assert.strictEqual(res.length, MOVED_CAP);
        });

        it('unprocessed results on one DB bind XCALL_MAX_CALLS_PER_BLOCK as the LIMIT for limit ' + String(limit), async function () {
            const fresh = loadWithMovedCap();
            const db = makeDb(null);
            const doQueryStrict = sinon.stub(db, 'doQueryStrict').resolves([]);
            await fresh.getEffectiveUnprocessedCallResults.call(db, 'BTC', 'regtest', 1700, limit, 100);
            const args = doQueryStrict.firstCall.args[1];
            assert.strictEqual(args[args.length - 1], MOVED_CAP);
        });

        it('unprocessed results on a separate mirror slice to XCALL_MAX_CALLS_PER_BLOCK for limit ' + String(limit), async function () {
            const fresh = loadWithMovedCap();
            const hubDb = { doQueryStrict: sinon.stub().resolves(rows(30)) };
            const db = makeDb(hubDb);
            sinon.stub(db, 'doQuery').resolves([]);
            sinon.stub(db, 'doQueryStrict').resolves([]);
            const res = await fresh.getEffectiveUnprocessedCallResults.call(db, 'BTC', 'regtest', 1700, limit, 100);
            assert.strictEqual(res.length, MOVED_CAP);
        });
    }

    it('an explicit limit still wins over the protocol cap', async function () {
        const fresh = loadWithMovedCap();
        const db = makeDb(null);
        sinon.stub(db, 'doQueryStrict').resolves(rows(30));
        sinon.stub(db, 'doQuery').resolves([]);
        const res = await fresh.getEffectiveUndispatchedCalls.call(db, 'BTC', 'regtest', 1700, 5, 100);
        assert.strictEqual(res.length, 5);
    });
});
